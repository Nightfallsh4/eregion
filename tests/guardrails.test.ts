import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import guardrails from "../extensions/eregion/global/guardrails.js";

function harness(cwd: string) {
	let toolCall: (event: unknown, ctx: unknown) => Promise<unknown>;
	let allow: (args: string, ctx: unknown) => Promise<void>;
	const choices: string[] = [];
	const notices: string[] = [];
	let prompts = 0;
	guardrails({
		on: (_name: string, handler: typeof toolCall) => { toolCall = handler; },
		registerCommand: (_name: string, command: { handler: typeof allow }) => { allow = command.handler; },
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd, hasUI: true, abort() {},
		ui: {
			notify: (message: string) => notices.push(message),
			select: async () => { prompts++; return choices.shift(); },
		},
	};
	return {
		choices, notices, get prompts() { return prompts; },
		allow: (args: string) => allow(args, ctx),
		call: (toolName: string, input: Record<string, unknown>) => toolCall({ toolName, input }, ctx),
	};
}

test("project whitelist persists for the current project and covers descendants, not sibling prefixes", async () => {
	const root = mkdtempSync(join(process.cwd(), "guardrails-test-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const first = harness(cwd);
		await first.allow("project .env");
		await first.allow("project .env");
		assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi/guardrails.json"), "utf8")), { whitelist: [join(cwd, ".env")] });
		assert.equal(await harness(cwd).call("read", { path: ".env" }), undefined);
		assert.equal(await harness(cwd).call("bash", { command: "cat .env" }), undefined);
		const settingsWrite = harness(cwd);
		settingsWrite.choices.push("Reject");
		assert.ok(await settingsWrite.call("write", { path: ".pi/guardrails.json" }));
		const other = harness(join(root, "other"));
		other.choices.push("Reject");
		assert.deepEqual(await other.call("read", { path: ".env" }), { block: true, reason: "Guardrails: Read file blocked — sensitive: .env file (rejected by user)." });
		const nested = harness(cwd);
		await nested.allow("project secrets");
		assert.equal(await harness(cwd).call("read", { path: "secrets/credentials.json" }), undefined);
		const sibling = harness(cwd);
		sibling.choices.push("Reject");
		assert.ok((await sibling.call("read", { path: "secrets-other/credentials.json" })));
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(root, { recursive: true, force: true });
	}
});

test("popup can persist global approval for bash, including /tmp execution; invalid settings fail closed", async () => {
	const root = mkdtempSync(join(process.cwd(), "guardrails-test-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const first = harness(root);
		first.choices.push("Allow and add path to global whitelist");
		assert.equal(await first.call("read", { path: ".env" }), undefined);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "agent/guardrails.json"), "utf8")), { whitelist: [join(root, ".env")] });
		assert.equal(await harness(join(root, "other")).call("bash", { command: `cat ${join(root, ".env")}` }), undefined);
		const globalCommand = harness(root);
		await globalCommand.allow("global ../another path/.env");
		assert.ok(JSON.parse(readFileSync(join(root, "agent/guardrails.json"), "utf8")).whitelist.includes(join(process.cwd(), "another path/.env")));
		const script = join(tmpdir(), `guardrails-script-${process.pid}.sh`);
		const execCheck = harness(root);
		execCheck.choices.push("Allow and add path to project whitelist");
		assert.equal(await execCheck.call("bash", { command: `bash ${script}` }), undefined);
		assert.equal(await harness(root).call("bash", { command: `bash ${script}` }), undefined);
		writeFileSync(join(root, "agent/guardrails.json"), "invalid json");
		const broken = harness(root);
		await broken.allow("global credentials.json");
		assert.ok(broken.notices.some((notice) => notice.includes("Could not update")));
		await assert.rejects(() => broken.call("read", { path: "credentials.json" }));
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(root, { recursive: true, force: true });
	}
});
