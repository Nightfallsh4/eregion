/**
 * Herdr terminal multiplexer integration.
 *
 * When the parent pi session runs inside a Herdr-managed pane, workflows can
 * run every subagent phase as a visible pi TUI inside its own Herdr tab
 * instead of a hidden headless process. This module wraps the `herdr` CLI
 * (socket API) with typed helpers; the subagent runner in `subagent.ts`
 * composes them.
 *
 * Reusable by any workflow that wants observable, inspectable subagent tabs.
 */

import { spawn } from "node:child_process";

/** True when phases should run as pi TUI agents in Herdr tabs. */
export function isHerdrTuiEnabled(): boolean {
	const override = process.env.PBT_FLOW_HERDR?.trim().toLowerCase();
	if (override === "off" || override === "0" || override === "false") return false;
	return (process.env.HERDR_ENV ?? "") === "1";
}

export class HerdrError extends Error {
	code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

export class HerdrAbortError extends Error {
	constructor() {
		super("Herdr command aborted");
		this.name = "HerdrAbortError";
	}
}

export interface HerdrAgentInfo {
	name?: string;
	agent_status?: string;
	pane_id?: string;
	tab_id?: string;
	interactive_ready?: boolean;
}

function parseErrorPayload(text: string): { message: string; code?: string } {
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object") {
			return {
				message: typeof parsed.error.message === "string" ? parsed.error.message : text.trim(),
				code: typeof parsed.error.code === "string" ? parsed.error.code : undefined,
			};
		}
	} catch {
		// Fall through to raw text.
	}
	return { message: text.trim() || "herdr command failed" };
}

/** Run a herdr CLI command and return its parsed JSON stdout. */
export function herdrCommand(
	args: string[],
	options: { signal?: AbortSignal; killAfterMs?: number } = {},
): Promise<any> {
	return new Promise((resolve, reject) => {
		const child = spawn("herdr", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			fail(new HerdrAbortError());
		};
		const killTimer =
			options.killAfterMs && options.killAfterMs > 0
				? setTimeout(() => {
						child.kill("SIGKILL");
						const { message, code } = parseErrorPayload(stderr);
						fail(new HerdrError(message || `herdr ${args[0]} exceeded its hard kill timeout`, code ?? "timeout"));
					}, options.killAfterMs)
				: undefined;
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => fail(new HerdrError(`Failed to spawn herdr: ${error.message}`)));
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (code === 0) {
				try {
					resolve(JSON.parse(stdout));
				} catch {
					resolve(stdout);
				}
				return;
			}
			// CLI server errors are JSON on stderr; be tolerant of either stream.
			const payload = stderr.trim() || stdout.trim();
			const { message, code: errorCode } = parseErrorPayload(payload);
			reject(new HerdrError(message, errorCode));
		});
	});
}

/** Create a background tab and return its tab and root pane IDs. */
export async function herdrTabCreate(options: {
	cwd: string;
	label: string;
	signal?: AbortSignal;
}): Promise<{ tabId: string; paneId: string }> {
	const args = ["tab", "create", "--cwd", options.cwd, "--label", options.label, "--no-focus"];
	if (process.env.HERDR_WORKSPACE_ID) args.push("--workspace", process.env.HERDR_WORKSPACE_ID);
	const response = await herdrCommand(args, { signal: options.signal, killAfterMs: 30_000 });
	const tabId = response?.result?.tab?.tab_id;
	const paneId = response?.result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") {
		throw new HerdrError(`herdr tab create returned an unexpected payload: ${JSON.stringify(response)}`);
	}
	return { tabId, paneId };
}

/** Start a pi TUI agent in an existing shell pane and wait until it is ready. */
export async function herdrAgentStart(options: {
	name: string;
	paneId: string;
	piArgs: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<HerdrAgentInfo> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const response = await herdrCommand(
		["agent", "start", options.name, "--kind", "pi", "--pane", options.paneId, "--timeout", String(timeoutMs), "--", ...options.piArgs],
		{ signal: options.signal, killAfterMs: timeoutMs + 30_000 },
	);
	return (response?.result?.agent ?? {}) as HerdrAgentInfo;
}

/**
 * Submit a prompt to a live agent and wait for the first settled state
 * (idle, done, or blocked). Returns the agent record after settling.
 */
export async function herdrAgentPromptWait(options: {
	name: string;
	task: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<HerdrAgentInfo> {
	const response = await herdrCommand(
		["agent", "prompt", options.name, options.task, "--wait", "--timeout", String(options.timeoutMs)],
		{ signal: options.signal, killAfterMs: options.timeoutMs + 30_000 },
	);
	return (response?.result?.agent ?? {}) as HerdrAgentInfo;
}

/** Look up a live agent by name; undefined when no such agent exists. */
export async function herdrAgentGet(name: string): Promise<HerdrAgentInfo | undefined> {
	try {
		const response = await herdrCommand(["agent", "get", name], { killAfterMs: 15_000 });
		const agent = response?.result?.agent;
		return agent && typeof agent === "object" ? (agent as HerdrAgentInfo) : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort interrupt (Esc) of an agent's current turn. */
export async function herdrAgentInterrupt(name: string): Promise<void> {
	try {
		await herdrCommand(["agent", "send-keys", name, "esc"], { killAfterMs: 10_000 });
	} catch {
		// Best-effort only.
	}
}

/** Best-effort tab rename (used to reflect phase status in the tab bar). */
export async function herdrTabRename(tabId: string, label: string): Promise<void> {
	try {
		await herdrCommand(["tab", "rename", tabId, label], { killAfterMs: 10_000 });
	} catch {
		// Best-effort only.
	}
}
