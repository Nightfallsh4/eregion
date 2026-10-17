/** Parent-session guardrail dialogs and a private, per-subagent-turn IPC relay. */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GUARDRAIL_CHOICES = [
	"Allow this once",
	"Allow and don't ask again this session",
	"Allow and add path to project whitelist",
	"Allow and add path to global whitelist",
	"Reject",
	"Reject and stop execution",
] as const;
export type GuardrailChoice = typeof GUARDRAIL_CHOICES[number];
export const GUARDRAIL_RELAY_ENV = "EREGION_GUARDRAILS_RELAY";
export interface GuardrailRelayEndpoint { socketPath: string; token: string }
type DialogContext = Pick<ExtensionContext, "hasUI" | "ui" | "signal">;

// One queue for the parent process, including parallel builder/tester requests.
let dialogQueue: Promise<unknown> = Promise.resolve();
export function selectGuardrailPermission(ctx: DialogContext, title: string, signal = ctx.signal): Promise<GuardrailChoice | undefined> {
	const pending = dialogQueue.then(async () => {
		if (!ctx.hasUI || signal?.aborted) return undefined;
		const reminder = setTimeout(() => sendSystemNotification("Guardrails: Permission Needed", title.split("\n").slice(0, 3).join(" — ")), 10_000);
		try {
			const choice = await ctx.ui.select(title, [...GUARDRAIL_CHOICES], { signal });
			return !signal?.aborted && GUARDRAIL_CHOICES.includes(choice as GuardrailChoice) ? choice as GuardrailChoice : undefined;
		} finally {
			clearTimeout(reminder);
		}
	});
	dialogQueue = pending.catch(() => {});
	return pending;
}

export function guardrailRelayFile(sessionPath: string): string {
	return `${sessionPath}.guardrails-relay.json`;
}

/** Re-read on every request: a resumed Herdr TUI must use its new parent's relay. */
export function readGuardrailRelay(sessionPath?: string): GuardrailRelayEndpoint | undefined {
	const file = sessionPath && guardrailRelayFile(sessionPath);
	const raw = file && existsSync(file) ? readFileSync(file, "utf8") : process.env[GUARDRAIL_RELAY_ENV];
	if (!raw) return undefined;
	const endpoint = JSON.parse(raw) as GuardrailRelayEndpoint;
	if (typeof endpoint?.socketPath !== "string" || typeof endpoint?.token !== "string") throw new Error("Invalid parent guardrails relay");
	return endpoint;
}

/** Child-side request. Disconnects/errors/cancellation always fail closed. */
export function requestGuardrailPermission(endpoint: GuardrailRelayEndpoint, title: string, signal?: AbortSignal): Promise<GuardrailChoice | undefined> {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve(undefined); return; }
		const socket = createConnection(endpoint.socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let settled = false;
		const finish = (choice?: GuardrailChoice) => {
			if (settled) return;
			settled = true;
			clearTimeout(connectTimer);
			signal?.removeEventListener("abort", abort);
			socket.destroy();
			resolve(choice);
		};
		const abort = () => finish();
		const connectTimer = setTimeout(abort, 5_000);
		signal?.addEventListener("abort", abort, { once: true });
		socket.on("connect", () => {
			clearTimeout(connectTimer);
			socket.write(JSON.stringify({ token: endpoint.token, title }) + "\n");
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (buffer.length > 65_536) { finish(); return; }
			if (!buffer.includes("\n")) return;
			try {
				const { choice } = JSON.parse(buffer.split("\n")[0]);
				finish(GUARDRAIL_CHOICES.includes(choice) ? choice : undefined);
			} catch { finish(); }
		});
		socket.on("error", abort);
		socket.on("close", abort);
	});
}

export async function startGuardrailRelay(options: {
	ctx: DialogContext;
	label: string;
	signal: AbortSignal;
	sessionPath?: string;
}): Promise<{ endpoint: GuardrailRelayEndpoint; close(): void }> {
	// Private local IPC only: a Unix socket, or a named pipe on Windows.
	const directory = mkdtempSync(join(tmpdir(), "pi-gr-"));
	const token = randomUUID();
	const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-guardrails-${token}` : join(directory, "relay.sock");
	const endpoint = { socketPath, token };
	const sockets = new Set<Socket>();
	let closed = false;
	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		sockets.add(socket);
		const request = new AbortController();
		let buffer = "";
		let received = false;
		const handshakeTimer = setTimeout(() => socket.destroy(), 5_000);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			clearTimeout(handshakeTimer);
			request.abort();
			sockets.delete(socket);
		});
		socket.on("data", (chunk) => {
			if (received) return;
			buffer += chunk.toString();
			if (buffer.length > 65_536) { socket.destroy(); return; }
			if (!buffer.includes("\n")) return;
			received = true;
			clearTimeout(handshakeTimer);
			try {
				const payload = JSON.parse(buffer.split("\n")[0]);
				if (closed || payload.token !== endpoint.token || typeof payload.title !== "string") { socket.destroy(); return; }
				void selectGuardrailPermission(options.ctx, `${options.label}\nGuardrails permission\n\n${payload.title}`, request.signal)
					.then((choice) => { if (!socket.destroyed) socket.end(JSON.stringify({ choice }) + "\n"); })
					.catch(() => socket.destroy());
			} catch { socket.destroy(); }
		});
	});
	const close = () => {
		if (closed) return;
		closed = true;
		options.signal.removeEventListener("abort", close);
		for (const socket of sockets) socket.destroy();
		server.close(() => {});
		rmSync(directory, { recursive: true, force: true });
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint.socketPath, () => { server.removeListener("error", reject); resolve(); });
		});
		server.on("error", close);
		if (options.signal.aborted) throw new Error("Workflow aborted");
		options.signal.addEventListener("abort", close, { once: true });
		if (options.sessionPath) {
			const file = guardrailRelayFile(options.sessionPath);
			const temporary = `${file}.${endpoint.token}.tmp`;
			try {
				writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600, flag: "wx" });
				renameSync(temporary, file);
			} finally { rmSync(temporary, { force: true }); }
		}
		// Leave the discovery file until cleanup. An orphaned child must block,
		// not fall back to a hidden child-tab selector after the parent exits.
		return { endpoint, close };
	} catch (error) {
		close();
		throw error;
	}
}

function sendSystemNotification(title: string, body: string): void {
	const esc = (s: string) => s.replace(/'/g, "'\\''");
	switch (process.platform) {
		case "linux":
			exec(`notify-send '${esc(title)}' '${esc(body)}'`, (err) => {
				if (err) exec(`echo 'Guardrails: ${esc(body)}' | wall 2>/dev/null`, () => {});
			});
			break;
		case "darwin": {
			const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
			exec(`osascript -e '${esc(script)}'`, () => {});
			break;
		}
		case "win32": exec('msg * "Guardrails: Permission needed" 2>nul', () => {}); break;
		default: exec(`notify-send '${esc(title)}' '${esc(body)}' 2>/dev/null`, () => {});
	}
}
