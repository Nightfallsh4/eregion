import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import oneForAllExtension from "../extensions/eregion/one-for-all/index.js";
import { runWorkflow } from "../extensions/eregion/one-for-all/orchestrator.js";
import { buildFinalReport, deliverWorkflowOutput, finishReport } from "../extensions/eregion/one-for-all/report.js";
import { inspectState, listStates, saveState } from "../extensions/eregion/one-for-all/state.js";
import type { WorkflowState } from "../extensions/eregion/one-for-all/types.js";
import { updateUI } from "../extensions/eregion/one-for-all/ui.js";
import { compactErrorMessage, sanitizeTerminalText } from "../extensions/eregion/one-for-all/util.js";

const diagnostics = "\x1b[31mProvider failed\x1b[0m\r\n\x1b]0;unwanted title\x07\x1b[2J"
	+ "Compiler error: 界界 🚨 — a long diagnostic\n".repeat(2_000)
	+ "LAST_DIAGNOSTIC";

type Widget = { render(width: number): string[]; invalidate(): void };
type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };

function makeContext(cwd = os.tmpdir(), hasUI = true) {
	let widget: Widget | undefined;
	const notices: { text: string; type?: string }[] = [];
	const ctx = {
		cwd,
		hasUI,
		sessionManager: { getSessionFile: () => undefined },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getAvailable: () => [{ provider: "test", id: "test-model" }],
		},
		ui: {
			setWidget(_key: string, factory: () => Widget) { widget = factory(); },
			setStatus() {},
			notify(text: string, type?: string) { notices.push({ text, type }); },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices, getWidget: () => { assert.ok(widget); return widget; } };
}

function makeAPI() {
	const commands = new Map<string, Command>();
	const renderers = new Map<string, MessageRenderer<WorkflowState>>();
	const messages: { customType: string; content: string; details?: WorkflowState }[] = [];
	const userMessages: string[] = [];
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerMessageRenderer: (name: string, renderer: MessageRenderer<WorkflowState>) => renderers.set(name, renderer),
		registerTool() {},
		on() {},
		appendEntry() {},
		sendMessage: (message: typeof messages[number]) => messages.push(message),
		sendUserMessage: (message: string) => userMessages.push(message),
	} as unknown as ExtensionAPI;
	return { pi, commands, renderers, messages, userMessages };
}

function failedState(workflowName = "pbt"): WorkflowState {
	return {
		workflowName,
		workflowId: workflowName === "dpbt" ? "dpbt" : "pbt-simple",
		request: "Fix the workflow display",
		runId: "run-ui-regression",
		planPath: "acache/plans/plan-display.md",
		interactive: false,
		answers: [],
		questionRounds: 0,
		handoffs: [],
		iteration: 1,
		maxIterations: 5,
		status: "failed",
		phase: "build lint",
		failureReason: diagnostics,
		stopReason: "error",
		startedAt: 1,
		completedAt: 2,
	};
}

function assertSafeLine(line: string) {
	// truncateToWidth may insert harmless SGR resets around its ellipsis.
	assert.doesNotMatch(line.replace(/\x1b\[0m/g, ""), /[\x00-\x1f\x7f-\x9f]/);
}

test("error previews are bounded single lines without terminal commands", () => {
	const preview = compactErrorMessage(new Error(diagnostics));
	assert.ok(preview.startsWith("Provider failed"));
	assert.ok(preview.endsWith("…"));
	assert.ok(preview.length <= 160);
	assertSafeLine(preview);
	assert.equal(compactErrorMessage(" \r\n\t"), "Unknown error");
	assert.equal(compactErrorMessage("abcdefghij", 5), "abcd…");
	assert.equal(sanitizeTerminalText("\x1b[31mred\x1b[0m\r\nnext\rline"), "red\nnext\nline");
	assert.doesNotMatch(sanitizeTerminalText(diagnostics), /\x1b|\x07|\r|unwanted title/);
});

for (const workflow of ["pbt", "dpbt"]) {
	test(`${workflow} failure delivery never prints over the TUI or loses full diagnostics`, (t) => {
		const log = t.mock.method(console, "log", () => {});
		const { ctx, notices, getWidget } = makeContext();
		const { pi, messages } = makeAPI();
		const state = failedState(workflow);
		finishReport(pi, ctx, state);
		assert.equal(log.mock.callCount(), 0);
		// Pi cannot remove notifications from the transcript on resume. The
		// replaceable widget/report show this error without a permanent toast.
		assert.equal(notices.length, 0);
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /LAST_DIAGNOSTIC/);
		assert.doesNotMatch(messages[0].content, /\x1b|\x07|\r/);
		assert.equal(messages[0].details?.failureReason, diagnostics);
		assert.equal(state.failureReason, diagnostics);
		assert.match(buildFinalReport(state), /LAST_DIAGNOSTIC/);
		assert.match(inspectState(state, ctx.cwd), /LAST_DIAGNOSTIC/);
		for (const width of [1, 2, 10, 20, 40, 80, 120]) {
			const lines = getWidget().render(width);
			assert.equal(lines.length, 3);
			for (const line of lines) {
				assertSafeLine(line);
				assert.ok(visibleWidth(line) <= width);
			}
		}
	});
}

test("resuming clears stopped-run errors before the workflow restarts", async (t) => {
	for (const workflow of ["pbt", "dpbt"]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-ui-reset-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const { ctx } = makeContext(cwd);
		const { pi } = makeAPI();
		const snapshots: WorkflowState[] = [];
		Object.assign(pi, { appendEntry: (_type: string, state: WorkflowState) => { snapshots.push(structuredClone(state)); } });
		const state = failedState(workflow);
		state.status = "max-iterations-reached";
		state.stopReason = "max-iterations";
		state.iteration = state.maxIterations;
		state.latestOutput = "OLD_ERROR";
		state.currentAgent = "tester";
		state.currentActivity = "OLD_ERROR";
		state.agentStatuses = { tester: { status: "failed", phase: "test", activity: "OLD_ERROR", updatedAt: 1 } };
		const result = await runWorkflow(pi, ctx, state.request, false, state.maxIterations, undefined, state, true, state.workflowId, workflow === "dpbt");
		// No lint setup: this run fails anew without invoking child agents. The
		// first persisted update still shows that the old failure was cleared.
		assert.equal(result.status, "failed");
		assert.equal(snapshots[0].status, "running");
		assert.equal(snapshots[0].iterationCycle, 1);
		assert.equal(snapshots[0].iteration, 0);
		assert.equal(snapshots[0].failureReason, undefined);
		assert.equal(snapshots[0].stopReason, undefined);
		assert.equal(snapshots[0].latestOutput, undefined);
		assert.equal(snapshots[0].currentAgent, undefined);
		assert.equal(snapshots[0].currentActivity, undefined);
		assert.equal(snapshots[0].agentStatuses?.tester.status, "waiting");
	}
});

test("a new budget cycle does not show stale verification or lint failures", () => {
	const { ctx, getWidget } = makeContext();
	const state = failedState();
	state.status = "running";
	state.iteration = 0;
	state.iterationCycle = 1;
	state.failureReason = undefined;
	state.stopReason = undefined;
	state.lintCommand = "npm run lint";
	state.lintRuns = [{ stage: "build", iteration: 5, attempt: 1, exitCode: 1, command: "npm run lint", stdout: "", stderr: "previous error", completedAt: 1, iterationCycle: 0 }];
	state.handoffs = [{ phase: "test", testStage: "verification", iteration: 5, iterationCycle: 0, summary: "previous error", artifacts: [], decisions: [], status: "fail", completedAt: 1 }];
	updateUI(ctx, state);
	const lines = getWidget().render(120).join("\n");
	assert.match(lines, /test verification waiting/);
	assert.match(lines, /Lint: npm run lint/);
	assert.doesNotMatch(lines, /previous error|test verification fail|Lint: failed/);
});

test("running widgets cannot expand from multiline errors, long ledgers, or wide Unicode", () => {
	const { ctx, getWidget } = makeContext();
	const state = failedState();
	state.status = "running";
	state.currentAgent = "builder";
	state.currentActivity = diagnostics;
	state.agentStatuses = { builder: { status: "failed", phase: "build", activity: diagnostics, updatedAt: 1 } };
	state.latestOutput = diagnostics;
	state.planPath = "界界/".repeat(200);
	state.issueLedger = Array.from({ length: 100 }, (_, i) => ({
		issue: { id: `issue-${i}`, description: "test", test: "test", severity: "error" as const },
		status: "pending" as const, attempts: 0, updatedAt: 1,
	}));
	updateUI(ctx, state);
	for (const width of [1, 10, 20, 40, 80, 120]) {
		const lines = getWidget().render(width);
		assert.ok(lines.length < 24);
		for (const line of lines) {
			assertSafeLine(line);
			assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("PBT status and final reports show both role-specific plan artifacts", () => {
	const state = failedState();
	state.builderPlanPath = "acache/plans/builder-plan-display.md";
	state.testerPlanPath = "acache/plans/tester-plan-display.md";
	assert.match(inspectState(state, os.tmpdir()), /Builder plan: acache\/plans\/builder-plan-display\.md/);
	assert.match(buildFinalReport(state), /Builder plan: acache\/plans\/builder-plan-display\.md/);
	assert.match(buildFinalReport(state), /Tester plan: acache\/plans\/tester-plan-display\.md/);
});

test("aborted and other terminal states leave a compact widget", () => {
	for (const status of ["aborted", "completed", "max-iterations-reached", "plateau-reached"] as const) {
		const { ctx, getWidget } = makeContext();
		const state = { ...failedState(), status };
		updateUI(ctx, state);
		assert.ok(getWidget().render(40).length <= 3);
	}
});

test("RPC clients receive sanitized string widgets instead of terminal factories", (t) => {
	const { ctx } = makeContext();
	Object.assign(ctx, { mode: "rpc" });
	const setWidget = t.mock.method(ctx.ui, "setWidget", () => {});
	updateUI(ctx, failedState());
	const lines = setWidget.mock.calls[0].arguments[1];
	assert.ok(Array.isArray(lines));
	assert.equal(lines.length, 3);
	for (const line of lines) assertSafeLine(line);
});

test("resuming PBT/DPBT retires earlier errors from the transcript but keeps history", (t) => {
	for (const workflow of ["pbt", "dpbt"]) {
		for (const status of ["max-iterations-reached", "failed"] as const) {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-ui-resume-"));
			t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
			const { ctx, getWidget, notices } = makeContext(cwd);
			const { pi, renderers, messages } = makeAPI();
			oneForAllExtension(pi);
			const renderer = renderers.get("workflow-final-report")!;
			const theme = { fg: (_color: string, text: string) => text } as Parameters<typeof renderer>[2];
			const state = failedState(workflow);
			state.status = status;
			state.iteration = state.maxIterations;
			state.stopReason = status === "failed" ? "error" : "max-iterations";
			state.activityLogPath = path.join(cwd, "acache/workflow-runs", state.runId, "activity.jsonl");
			state.handoffs.push({ phase: "test", testStage: "verification", iteration: 5, iterationCycle: 0, summary: "OLD_TEST_ERROR", artifacts: [], decisions: [], status: "fail", completedAt: 2 });
			if (status === "max-iterations-reached") state.failureReason = undefined;
			saveState(cwd, state, pi);
			finishReport(pi, ctx, state);
			assert.equal(notices.length, 0);
			const report = messages.at(-1)!;
			const view = renderer({ role: "custom", customType: report.customType, content: report.content, details: structuredClone(report.details), display: true, timestamp: 1 }, { expanded: false, outputPad: 0 }, theme)!;
			assert.match(view.render(120).join("\n"), /Workflow (failed|max-iterations-reached)/);

			state.status = "running";
			state.iteration = 0;
			state.iterationCycle = 1;
			state.resumeCount = 1;
			state.failureReason = undefined;
			state.stopReason = undefined;
			saveState(cwd, state, pi);
			updateUI(ctx, state);
			assert.match(view.render(120).join("\n"), /superseded by resume/);
			assert.doesNotMatch(view.render(120).join("\n"), /OLD_TEST_ERROR|Provider failed|max-iterations-reached/);
			assert.doesNotMatch(getWidget().render(120).join("\n"), /Provider failed/);

			state.status = "completed";
			state.iteration = 1;
			state.completedAt = 3;
			state.handoffs.push({ phase: "test", testStage: "verification", iteration: 1, iterationCycle: 1, summary: "All tests passed", artifacts: [], decisions: [], status: "pass", completedAt: 3 });
			saveState(cwd, state, pi);
			finishReport(pi, ctx, state);
			const resumed = messages.at(-1)!;
			const success = renderer({ role: "custom", customType: resumed.customType, content: resumed.content, details: resumed.details, display: true, timestamp: 3 }, { expanded: true, outputPad: 0 }, theme)!;
			assert.match(success.render(120).join("\n"), /Workflow completed/);
			assert.doesNotMatch(success.render(120).join("\n"), /OLD_TEST_ERROR|Provider failed/);
			assert.doesNotMatch(view.render(120).join("\n"), /OLD_TEST_ERROR|Provider failed/);
			assert.equal(notices.filter((notice) => notice.type === "error" || notice.type === "warning").length, 0);
			assert.match(buildFinalReport(state), /OLD_TEST_ERROR/);
		}
	}
});

test("an idle Herdr child tab follows a maxed-out run when it resumes", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-ui-child-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const { ctx, getWidget } = makeContext(cwd);
	const state = failedState();
	state.status = "max-iterations-reached";
	state.stopReason = "max-iterations";
	state.failureReason = undefined;
	state.activityLogPath = path.join(cwd, "acache/workflow-runs", state.runId, "activity.jsonl");
	Object.assign(ctx.sessionManager, { getSessionFile: () => path.join(path.dirname(state.activityLogPath!), "build.jsonl") });
	const { pi } = makeAPI();
	const hooks = new Map<string, (...args: any[]) => any>();
	Object.assign(pi, { on: (name: string, handler: (...args: any[]) => any) => { hooks.set(name, handler); } });
	oneForAllExtension(pi);
	saveState(cwd, state, pi);
	try {
		await hooks.get("session_start")!({}, ctx);
		assert.match(getWidget().render(120).join("\n"), /max-iterations-reached/);
		state.status = "running";
		state.stopReason = undefined;
		state.iterationCycle = 1;
		saveState(cwd, state, pi);
		await new Promise((resolve) => setTimeout(resolve, 650));
		assert.match(getWidget().render(120).join("\n"), /Budget cycle 1/);
		assert.doesNotMatch(getWidget().render(120).join("\n"), /max-iterations-reached/);
	} finally {
		hooks.get("session_shutdown")!();
	}
});

test("headless reports retain stdout output and complete persisted diagnostics", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-ui-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const log = t.mock.method(console, "log", () => {});
	const { ctx, notices } = makeContext(cwd, false);
	const { pi } = makeAPI();
	const state = failedState();
	saveState(cwd, state, pi);
	finishReport(pi, ctx, state);
	assert.equal(log.mock.callCount(), 1);
	assert.equal(log.mock.calls[0].arguments[0], buildFinalReport(state));
	assert.equal(notices.length, 0);
	assert.equal(listStates(cwd)[0].failureReason, diagnostics);
});

test("/pbt-lint-setup starts a visible, current-session agent turn", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-lint-setup-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const { ctx } = makeContext(cwd);
	const { pi, commands, userMessages } = makeAPI();
	oneForAllExtension(pi);
	await commands.get("pbt-lint-setup")!.handler("", ctx);
	assert.equal(userMessages.length, 1);
	assert.match(userMessages[0], /current session/);
	assert.match(userMessages[0], /do not delegate it to a background\/subagent session/);
	assert.match(userMessages[0], /\.pi[\\/]lint\.json/);
});

test("/doc starts a visible maintenance turn in its invoking session", async () => {
	const { ctx } = makeContext();
	const { pi, commands, messages, userMessages } = makeAPI();
	oneForAllExtension(pi);
	await commands.get("doc")!.handler("", ctx);
	assert.equal(userMessages.length, 1);
	assert.equal(messages.length, 0);
	assert.match(userMessages[0], /project in the current working directory/i);
	assert.match(userMessages[0], /not Pi or its coding-agent harness/i);
	assert.match(userMessages[0], /do not look up, read, summarize, or modify Pi CLI\/SDK\/extension\/skill documentation/i);
	assert.match(userMessages[0], /do not delegate.*background process or subagent/i);
	assert.match(userMessages[0], /Update only docs\/ in the current project/);
});

test("--docs requests the separate final documentation phase", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-docs-flag-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const { ctx } = makeContext(cwd);
	const { pi, commands } = makeAPI();
	oneForAllExtension(pi);
	// The missing lint configuration stops before any child starts, while the
	// persisted state proves --docs was parsed as a final workflow phase.
	await commands.get("pbt")!.handler("--docs document the feature", ctx);
	const state = listStates(cwd)[0];
	assert.equal(state.documentationRequested, true);
	assert.equal(state.status, "failed");
	assert.match(state.failureReason!, /linting is not configured/);
});

test("a session delivery failure does not fall back to raw stdout in the TUI", (t) => {
	const log = t.mock.method(console, "log", () => {});
	const { ctx, notices } = makeContext();
	const pi = { sendMessage() { throw new Error("session unavailable"); } } as unknown as ExtensionAPI;
	deliverWorkflowOutput(pi, ctx, diagnostics);
	assert.equal(log.mock.callCount(), 0);
	assert.equal(notices.length, 1);
	assertSafeLine(notices[0].text);
});

test("failed reports are collapsed by default and can be expanded without losing diagnostics", () => {
	const { pi, renderers } = makeAPI();
	oneForAllExtension(pi);
	const renderer = renderers.get("workflow-final-report");
	assert.ok(renderer);
	const state = failedState();
	const message = { role: "custom" as const, customType: "workflow-final-report", content: buildFinalReport(state), details: state, display: true, timestamp: 1 };
	const theme = { fg: (_color: string, text: string) => text } as Parameters<typeof renderer>[2];
	const compact = renderer(message, { expanded: false, outputPad: 0 }, theme);
	const expanded = renderer(message, { expanded: true, outputPad: 0 }, theme);
	assert.ok(compact);
	assert.ok(expanded);
	assert.ok(compact.render(80).length <= 5);
	assert.doesNotMatch(compact.render(80).join("\n"), /LAST_DIAGNOSTIC/);
	assert.match(expanded.render(80).join("\n"), /LAST_DIAGNOSTIC/);
	assert.doesNotMatch(expanded.render(80).join("\n"), /\x1b|\x07|\r/);
});

for (const [command, args, resume] of [
	["pbt", "regression test", "pbt-resume"],
	["pbt", "--interactive regression test", "pbt-resume"],
	["b", "regression test", "b-resume"],
	["dpbt", "regression test", "dpbt-resume"],
	["dpbt", "--interactive regression test", "dpbt-resume"],
	["flow", "dpbt regression test", "dpbt-resume"],
]) {
	test(`/${command} ${args} and /${resume} keep errors in replaceable UI only`, async (t) => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-ui-command-"));
		t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		const log = t.mock.method(console, "log", () => {});
		const { ctx, notices } = makeContext(cwd);
		const { pi, commands, messages } = makeAPI();
		oneForAllExtension(pi);
		// Missing lint setup fails deterministically before any subagent starts.
		await commands.get(command)!.handler(args, ctx);
		const state = listStates(cwd)[0];
		assert.equal(state.status, "failed");
		assert.match(state.failureReason!, /linting is not configured/);
		assert.equal(notices.filter((notice) => notice.type === "error").length, 0);
		await commands.get(resume)!.handler(state.runId, ctx);
		assert.equal(notices.filter((notice) => notice.type === "error").length, 0);
		assert.equal(messages.filter((message) => message.customType === "workflow-final-report").length, 2);
		assert.equal(log.mock.callCount(), 0);
		await commands.get("pbt-status")!.handler(state.runId, ctx);
		await commands.get("pbt-inspect")!.handler(state.runId, ctx);
		assert.match(messages.at(-1)!.content, /failure: .*linting is not configured/);
		assert.equal(log.mock.callCount(), 0);
		for (const notice of notices) assertSafeLine(notice.text);
	});
}
