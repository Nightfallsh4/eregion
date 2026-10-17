import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import guardrails from "../extensions/eregion/global/guardrails.js";
import {
	GUARDRAIL_CHOICES, GUARDRAIL_RELAY_ENV, guardrailRelayFile,
	readGuardrailRelay, requestGuardrailPermission, startGuardrailRelay,
} from "../extensions/eregion/global/guardrails-relay.js";
import { cleanupRunResources } from "../extensions/eregion/one-for-all/cleanup.js";
import { RUNS_DIR } from "../extensions/eregion/one-for-all/constants.js";
import type { WorkflowState } from "../extensions/eregion/one-for-all/types.js";
import { runSubagent } from "../extensions/eregion/one-for-all/subagent.js";

function fixture(t: TestContext) {
	const cwd = mkdtempSync(join(process.cwd(), "guardrails-relay-test-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldRelay = process.env[GUARDRAIL_RELAY_ENV];
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	delete process.env[GUARDRAIL_RELAY_ENV];
	t.after(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldRelay === undefined) delete process.env[GUARDRAIL_RELAY_ENV];
		else process.env[GUARDRAIL_RELAY_ENV] = oldRelay;
		rmSync(cwd, { recursive: true, force: true });
	});
	return cwd;
}

function parent(select: ExtensionContext["ui"]["select"], hasUI = true): ExtensionContext {
	return { hasUI, ui: { select }, signal: undefined } as ExtensionContext;
}

function child(cwd: string, sessionPath?: string, hasUI = true) {
	let handler: (event: unknown, ctx: unknown) => Promise<{ block: boolean; reason: string } | undefined>;
	let aborts = 0;
	guardrails({
		on: (_name: string, callback: typeof handler) => { handler = callback; },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd, hasUI, sessionManager: { getSessionFile: () => sessionPath },
		abort() { aborts++; },
		ui: { select() { throw new Error("Child selector must not open"); }, notify() {} },
	};
	return {
		get aborts() { return aborts; },
		call: (path = ".env") => handler({ toolName: "read", input: { path } }, ctx),
	};
}

async function relay(t: TestContext, ctx: ExtensionContext, label: string, sessionPath?: string) {
	const controller = new AbortController();
	const server = await startGuardrailRelay({ ctx, label, sessionPath, signal: controller.signal });
	t.after(() => server.close());
	return { ...server, controller };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("Timed out waiting for relay activity");
}

for (const workflow of ["PBT", "DPBT"]) {
	for (const [phase, agent] of [["design", "designer"], ["plan", "planner"], ["build", "builder"], ["test authoring", "tester"], ["test verification", "tester"]]) {
		if (workflow === "PBT" && phase === "design") continue;
		test(`${workflow} ${phase} permissions appear in parent, never the child TUI`, async (t) => {
			const cwd = fixture(t);
			const sessionPath = join(cwd, `${agent}.jsonl`);
			let prompts = 0;
			const ctx = parent(async (title, choices) => {
				prompts++;
				assert.match(title, new RegExp(`${workflow} · Phase: ${phase} · Agent: ${agent}`));
				assert.ok(title.includes(`Working dir:  ${cwd}`));
				assert.ok(title.includes(join(cwd, ".env")));
				assert.deepEqual(choices, GUARDRAIL_CHOICES);
				return "Allow this once";
			});
			const server = await relay(t, ctx, `${workflow} · Phase: ${phase} · Agent: ${agent}`, sessionPath);
			assert.equal(statSync(dirname(server.endpoint.socketPath)).mode & 0o777, 0o700);
			assert.equal(statSync(guardrailRelayFile(sessionPath)).mode & 0o777, 0o600);
			const agentSession = child(cwd, sessionPath);
			assert.equal(await agentSession.call(), undefined);
			assert.equal(await agentSession.call(), undefined);
			assert.equal(prompts, 2, "allow once must not become a lasting grant");
		});
	}
}

test("headless/ephemeral children forward through their environment even without a local UI", async (t) => {
	const cwd = fixture(t);
	const server = await relay(t, parent(async () => "Reject"), "PBT · Phase: plan · Agent: planner");
	process.env[GUARDRAIL_RELAY_ENV] = JSON.stringify(server.endpoint);
	assert.match((await child(cwd, undefined, false).call())!.reason, /rejected by user/);
});

test("all grants and reject/stop keep their child-side scope and effects", async (t) => {
	const cwd = fixture(t);
	const sessionPath = join(cwd, "build.jsonl");
	const choices: string[] = [
		"Allow and don't ask again this session",
		"Allow and add path to project whitelist",
		"Allow and add path to global whitelist",
		"Reject",
		"Reject and stop execution",
	];
	let prompts = 0;
	await relay(t, parent(async () => { prompts++; return choices.shift(); }), "DPBT · Phase: build · Agent: builder", sessionPath);
	const agent = child(cwd, sessionPath);
	assert.equal(await agent.call(".env.session"), undefined);
	assert.equal(await agent.call(".env.session"), undefined);
	assert.equal(prompts, 1);
	assert.equal(await agent.call(".env.project"), undefined);
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi/guardrails.json"), "utf8")).whitelist, [join(cwd, ".env.project")]);
	assert.equal(await agent.call(".env.global"), undefined);
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, "agent/guardrails.json"), "utf8")).whitelist, [join(cwd, ".env.global")]);
	assert.match((await agent.call(".env.reject"))!.reason, /rejected by user/);
	assert.equal(agent.aborts, 0);
	assert.match((await agent.call(".env.stop"))!.reason, /stopping execution/);
	assert.equal(agent.aborts, 1);
	assert.equal(prompts, 5);
});

test("parallel build/test requests are queued, labeled, and answered independently", async (t) => {
	fixture(t);
	const titles: string[] = [];
	const answers: ((choice: string) => void)[] = [];
	const ctx = parent((title) => {
		titles.push(title);
		return new Promise((resolve) => answers.push(resolve));
	});
	const build = await relay(t, ctx, "PBT · Phase: build · Agent: builder");
	const testAgent = await relay(t, ctx, "PBT · Phase: test authoring · Agent: tester");
	const building = requestGuardrailPermission(build.endpoint, "build target");
	await until(() => titles.length === 1);
	const testing = requestGuardrailPermission(testAgent.endpoint, "test target");
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(titles.length, 1);
	answers[0]("Allow this once");
	assert.equal(await building, "Allow this once");
	await until(() => titles.length === 2);
	assert.match(titles[0], /Phase: build/);
	assert.match(titles[1], /Phase: test authoring/);
	answers[1]("Reject");
	assert.equal(await testing, "Reject");
});

test("workflow abort cancels the active parent dialog and skips queued requests", async (t) => {
	fixture(t);
	let prompts = 0;
	let dismissed = 0;
	const ctx = parent((_title, _choices, options) => {
		prompts++;
		return new Promise((resolve) => options!.signal!.addEventListener("abort", () => { dismissed++; resolve(undefined); }, { once: true }));
	});
	const server = await relay(t, ctx, "DPBT · Phase: build · Agent: builder");
	const active = requestGuardrailPermission(server.endpoint, "first");
	await until(() => prompts === 1);
	const queued = requestGuardrailPermission(server.endpoint, "second");
	server.controller.abort();
	assert.equal(await active, undefined);
	assert.equal(await queued, undefined);
	await until(() => dismissed === 1);
	assert.equal(prompts, 1);
	assert.ok(!existsSync(server.endpoint.socketPath));
});

test("child cancellation dismisses only its parent dialog", async (t) => {
	fixture(t);
	let opened = false;
	let dismissed = false;
	const server = await relay(t, parent((_title, _choices, options) => {
		opened = true;
		return new Promise((resolve) => options!.signal!.addEventListener("abort", () => { dismissed = true; resolve(undefined); }, { once: true }));
	}), "PBT · Phase: test · Agent: tester");
	const childTurn = new AbortController();
	const pending = requestGuardrailPermission(server.endpoint, "target", childTurn.signal);
	await until(() => opened);
	childTurn.abort();
	assert.equal(await pending, undefined);
	await until(() => dismissed);
	assert.equal(server.controller.signal.aborted, false);
});

test("persistent sessions rebind to the new parent's relay; stale endpoints fail closed", async (t) => {
	const cwd = fixture(t);
	const sessionPath = join(cwd, "build.jsonl");
	const first = await relay(t, parent(async () => "Allow this once"), "PBT · Phase: build", sessionPath);
	const agent = child(cwd, sessionPath);
	assert.equal(await agent.call(), undefined);
	first.close();
	assert.ok(await agent.call(), "a missing parent must not open a selector in the child");
	const second = await relay(t, parent(async () => "Reject"), "PBT · Phase: build fixes", sessionPath);
	assert.deepEqual(readGuardrailRelay(sessionPath), second.endpoint);
	assert.notEqual(second.endpoint.token, first.endpoint.token);
	assert.match((await agent.call())!.reason, /rejected by user/);
	assert.equal(await requestGuardrailPermission({ ...second.endpoint, token: first.endpoint.token }, "forged"), undefined);
});

test("headless parent, dismissed/broken dialogs, and corrupt discovery never grant access", async (t) => {
	const cwd = fixture(t);
	const sessionPath = join(cwd, "test.jsonl");
	for (const ctx of [parent(async () => "Allow this once", false), parent(async () => undefined), parent(async () => { throw new Error("UI gone"); })]) {
		const server = await relay(t, ctx, "PBT · Phase: test", sessionPath);
		assert.ok(await child(cwd, sessionPath).call());
		server.close();
	}
	writeFileSync(guardrailRelayFile(sessionPath), "invalid json");
	assert.ok(await child(cwd, sessionPath).call());
});

test("cleanup removes relay discovery files along with phase sessions", async (t) => {
	const cwd = fixture(t);
	const runId = "relay-cleanup";
	const sessionPath = join(cwd, RUNS_DIR, runId, "design.jsonl");
	mkdirSync(dirname(sessionPath), { recursive: true });
	const server = await relay(t, parent(async () => "Reject"), "DPBT · Phase: design", sessionPath);
	writeFileSync(sessionPath, "");
	server.close();
	await cleanupRunResources(cwd, { runId } as WorkflowState);
	assert.ok(!existsSync(sessionPath));
	assert.ok(!existsSync(guardrailRelayFile(sessionPath)));
});

for (const persistent of [false, true]) {
	test(`subagent runner forwards real child-process requests (${persistent ? "persistent" : "ephemeral"})`, async (t) => {
		const cwd = fixture(t);
		const script = join(cwd, "fake-pi.mjs");
		writeFileSync(script, `
			import { createConnection } from 'node:net';
			const endpoint = JSON.parse(process.env.${GUARDRAIL_RELAY_ENV});
			const socket = createConnection(endpoint.socketPath);
			socket.on('connect', () => socket.write(JSON.stringify({ token: endpoint.token, title: 'Read file — sensitive: .env file' }) + '\\n'));
			let data = '';
			socket.on('data', chunk => {
				data += chunk;
				if (!data.includes('\\n')) return;
				const choice = JSON.parse(data).choice;
				console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: choice }], stopReason: 'stop' } }));
				socket.end();
			});
		`);
		const oldEntry = process.argv[1];
		process.argv[1] = script;
		t.after(() => { process.argv[1] = oldEntry; });
		let prompts = 0;
		const ctx = parent(async (title) => {
			prompts++;
			assert.match(title, /DPBT · Phase: build 2 lint repair · Agent: builder/);
			return "Allow this once";
		});
		const sessionPath = persistent ? join(cwd, "build.jsonl") : undefined;
		const result = await runSubagent({
			cwd, agentPath: script, model: "fake/model", task: "relay integration test", tools: ["read"],
			sessionPath, signal: new AbortController().signal, agentName: "builder", phase: "build-2-lint-repair",
			activityLogPath: join(cwd, "activity.jsonl"), permissionContext: ctx, permissionWorkflow: "DPBT",
		});
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.output, "Allow this once");
		assert.equal(prompts, 1);
		if (sessionPath) assert.equal(existsSync(readGuardrailRelay(sessionPath)!.socketPath), false);
	});
}
