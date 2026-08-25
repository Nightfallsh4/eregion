/**
 * Local plan -> build -> test workflow.
 *
 * The extension is intentionally command-driven: the orchestrator owns the
 * loop, while each phase runs in a separate pi process with its own tools and
 * (for interactive planning, building, and testing) persistent session.
 *
 * This file is only the pi extension wiring (commands, tools, session hooks).
 * The reusable pieces live in sibling modules:
 *
 * - constants.ts    — run layout, timeouts, and display caps
 * - types.ts        — handoff/state/progress contracts
 * - util.ts         — small shared helpers
 * - handoffs.ts     — handoff parsing, validation, and analysis
 * - prompts.ts      — per-phase task prompt builders
 * - plan-paths.ts   — feature-named plan path reservation
 * - progress.ts     — activity.jsonl append/read/format
 * - state.ts        — run registry and state.json persistence
 * - subagent.ts     — child pi process runner
 * - ui.ts           — status widget and clarification prompts
 * - report.ts       — final report rendering/delivery
 * - cleanup.ts      — clears persisted subagent sessions and Herdr tabs
 * - orchestrator.ts — the plan-build-test control loop
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { MAX_ITERATIONS, RUNS_DIR } from "./constants.js";
import { runWorkflow } from "./orchestrator.js";
import { buildFinalReport } from "./report.js";
import { cleanupRunResources } from "./cleanup.js";
import { readProgress } from "./progress.js";
import { activeRuns, inspectState, isResumableState, listStates, loadState, resumableStateForArgument, saveState, stateForArgument, summarizeState } from "./state.js";
import { truncate } from "./util.js";
import { updateUI } from "./ui.js";
import { formatWorkflowCatalog, loadWorkflowDefinitions, resolveWorkflow, type WorkflowDefinition } from "./workflows.js";

const WorkflowStartParams = Type.Object({
	request: Type.String({ description: "Feature request to plan, build, and test" }),
	workflow: Type.Optional(Type.String({ description: "Workflow catalog ID; defaults to pbt-simple" })),
	interactive: Type.Optional(Type.Boolean({ description: "Use clarification rounds in the main UI (design phase for DPBT, plan phase for PBT)", default: false })),
	maxIterations: Type.Optional(Type.Number({ description: "Maximum build/test iterations (default 5)" })),
});

const WorkflowStatusParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run ID; defaults to the most recent run" })),
});

const PbtFlowInspectParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run ID; defaults to the most recent run" })),
	limit: Type.Optional(Type.Number({ description: "Number of recent activity events to return", default: 40 })),
});

const WorkflowStopParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Running run ID; defaults to the most recent active run" })),
});

const WorkflowResumeParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run ID to resume; defaults to the newest resumable run" })),
	maxIterations: Type.Optional(Type.Number({ description: "Maximum build/test iterations (default uses the run's persisted cap)" })),
	resetIteration: Type.Optional(Type.Boolean({ description: "Reset the iteration budget when resuming a maxed-out run", default: false })),
});

const WorkflowCleanupParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run ID to clean; defaults to the latest run" })),
});

export default function oneForAllExtension(pi: ExtensionAPI) {
	let statusPollTimer: ReturnType<typeof setInterval> | undefined;
	let watchedRunId: string | undefined;
	let watchedSignature: string | undefined;

	function stopStatusWatcher(): void {
		if (statusPollTimer) clearInterval(statusPollTimer);
		statusPollTimer = undefined;
		watchedRunId = undefined;
		watchedSignature = undefined;
	}

	function isDpbtState(state: NonNullable<ReturnType<typeof loadState>>): boolean {
		return state.workflowName === "dpbt" || state.workflowId === "dpbt" || Boolean(state.design);
	}

	function dpbtStateForArgument(cwd: string, runId?: string): NonNullable<ReturnType<typeof loadState>> | null {
		if (runId) {
			const state = loadState(cwd, runId);
			return state && isDpbtState(state) ? state : null;
		}
		const active = [...activeRuns.values()].map((control) => control.state).reverse().find(isDpbtState);
		return active || listStates(cwd).find(isDpbtState) || null;
	}

	function resumableDpbtStateForArgument(cwd: string, runId?: string): NonNullable<ReturnType<typeof loadState>> | null {
		const state = dpbtStateForArgument(cwd, runId);
		return state && isResumableState(state) ? state : null;
	}

	function activeDpbtRun(runId?: string): { runId: string; active: NonNullable<ReturnType<typeof activeRuns.get>> } | undefined {
		if (runId) {
			const active = activeRuns.get(runId);
			return active && isDpbtState(active.state) ? { runId, active } : undefined;
		}
		const entry = [...activeRuns.entries()].reverse().find(([, active]) => isDpbtState(active.state));
		return entry ? { runId: entry[0], active: entry[1] } : undefined;
	}

	function stateSignature(state: ReturnType<typeof loadState>): string {
		if (!state) return "missing";
		return JSON.stringify({
			status: state.status,
			phase: state.phase,
			iteration: state.iteration,
			iterationCycle: state.iterationCycle || 0,
			stopReason: state.stopReason,
			completedAt: state.completedAt,
			currentAgent: state.currentAgent,
			currentActivity: state.currentActivity,
			agentStatuses: state.agentStatuses,
			latestOutput: state.latestOutput,
			eventCount: state.eventCount,
			handoffs: state.handoffs.length,
			answers: state.answers.length,
		});
	}

	/**
	 * Child pi sessions are separate extension instances, so they do not receive
	 * the parent's in-memory updateUI calls. Follow the persisted state file so
	 * every planner/builder/tester tab renders the same live workflow status.
	 */
	function watchWorkflowStatus(ctx: ExtensionContext | ExtensionCommandContext, state: NonNullable<ReturnType<typeof loadState>>): void {
		stopStatusWatcher();
		watchedRunId = state.runId;
		watchedSignature = stateSignature(state);
		statusPollTimer = setInterval(() => {
			if (!watchedRunId) return;
			const latest = loadState(ctx.cwd, watchedRunId);
			if (!latest) return;
			const signature = stateSignature(latest);
			if (signature === watchedSignature) return;
			watchedSignature = signature;
			updateUI(ctx, latest);
			if (latest.status !== "running" && latest.status !== "awaiting-clarification" && latest.status !== "awaiting-design-review") stopStatusWatcher();
		}, 500);
	}

	async function startDefinition(definition: WorkflowDefinition, request: string, ctx: ExtensionCommandContext): Promise<void> {
			const state = await runWorkflow(pi, ctx, request, definition.interactive, definition.maxIterations, undefined, undefined, false, definition.id, definition.runner === "dpbt");
			if (state.status === "failed" || state.status === "aborted") ctx.ui.notify(state.failureReason || state.status, "error");
		}

	async function startFromCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const interactive = trimmed === "--interactive" || trimmed.startsWith("--interactive ");
		const request = interactive ? trimmed.slice("--interactive".length).trim() : trimmed;
		const definition = resolveWorkflow(ctx.cwd, "pbt", interactive);
		if (!request || !definition) {
			ctx.ui.notify("Usage: /pbt [--interactive] <request>", "warning");
			return;
		}
		await startDefinition(definition, request, ctx);
	}

	async function startDpbtCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const interactive = trimmed === "--interactive" || trimmed.startsWith("--interactive ");
		const request = interactive ? trimmed.slice("--interactive".length).trim() : trimmed;
		const definition = resolveWorkflow(ctx.cwd, "dpbt", interactive);
		if (!request || !definition) {
			ctx.ui.notify("Usage: /dpbt [--interactive] <request>", "warning");
			return;
		}
		await startDefinition(definition, request, ctx);
	}

	async function startGenericCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const workflowId = parts.shift();
		const interactive = parts.includes("--interactive");
		const request = parts.filter((part) => part !== "--interactive").join(" ").trim();
		const definition = resolveWorkflow(ctx.cwd, workflowId, interactive);
		if (!definition || !request) {
			ctx.ui.notify(`Usage: /flow <workflow-id> <request>\nAvailable workflows:\n${formatWorkflowCatalog(loadWorkflowDefinitions(ctx.cwd)).join("\n")}`, "warning");
			return;
		}
		await startDefinition(definition, request, ctx);
	}

	pi.registerCommand("pbt", {
		description: "Run the PBT plan-build-test workflow",
		handler: startFromCommand,
	});

	pi.registerCommand("flow", {
		description: "Run a named workflow from the local workflow catalog",
		handler: startGenericCommand,
	});

	pi.registerCommand("dpbt", {
		description: "Run Design → Plan → Build → Test with explicit mockup approval; --interactive asks design questions first",
		handler: startDpbtCommand,
	});

	pi.registerCommand("flows", {
		description: "List available workflows and recent workflow runs",
		handler: async (_args, ctx) => {
			const definitions = loadWorkflowDefinitions(ctx.cwd);
			const states = listStates(ctx.cwd);
			console.log(["Available workflows:", ...formatWorkflowCatalog(definitions), "", "Recent runs:", ...(states.length ? states.slice(0, 10).map(summarizeState) : ["  (none)"])].join("\n\n"));
			ctx.ui.notify(`${definitions.length} workflow${definitions.length === 1 ? "" : "s"} available`, "info");
		},
	});

	pi.registerCommand("pbts", {
		description: "List local workflow variants and recent runs",
		handler: async (_args, ctx) => {
			const states = listStates(ctx.cwd);
			const lines = [
				"Available workflows:",
				...formatWorkflowCatalog(loadWorkflowDefinitions(ctx.cwd)),
				"",
				"PBT workflow commands:",
				"  /pbt <request> — simple planner",
				"  /pbt --interactive <request> — planner clarification rounds",
				"  /dpbt <request> — design/review a mockup, then simple plan/build/test",
				"  /dpbt --interactive <request> — ask design questions before mockup/review; then simple plan/build/test",
				"  /dpbt-resume [run-id] [--reset-iteration] — resume a stopped/review-pending DPBT run",
				"  /dpbt-stop [run-id] — stop an active DPBT run",
				"  /dpbt-cleanup [run-id] — close DPBT tabs, preview server, and subagent sessions",
				"  /pbt-resume [run-id] [--reset-iteration] — resume a stopped run; reset the iteration budget when needed",
				"  /pbt-cleanup [run-id] — close tabs and remove subagent sessions",
				"  /flow <workflow-id> [--interactive] <request> — run a named workflow",
				"",
				"Recent runs:",
				...(states.length ? states.slice(0, 10).map(summarizeState) : ["  (none)"]),
			];
			console.log(lines.join("\n\n"));
			ctx.ui.notify(`${states.length} workflow run${states.length === 1 ? "" : "s"}`, "info");
		},
	});

	pi.registerCommand("dpbt-resume", {
		description: "Resume a stopped, failed, aborted, interrupted, or design-review DPBT run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const resetIteration = parts.includes("--reset-iteration") || parts.includes("--reset");
			const runId = parts.find((part) => !part.startsWith("--"));
			const state = resumableDpbtStateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify(runId ? `DPBT run ${runId} cannot be resumed.` : "No resumable DPBT runs found.", "warning");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is already running.`, "warning");
				return;
			}
			ctx.ui.notify(`Resuming DPBT ${state.runId} from ${state.phase || "pending phase"}…`, "info");
			const resumed = await runWorkflow(pi, ctx, state.request, state.interactive, state.maxIterations, undefined, state, resetIteration, state.workflowId || "dpbt", true);
			if (resumed.status === "failed" || resumed.status === "aborted") ctx.ui.notify(resumed.failureReason || resumed.status, "error");
		},
	});

	pi.registerCommand("pbt-resume", {
		description: "Resume a stopped, failed, aborted, or interrupted PBT workflow run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const resetIteration = parts.includes("--reset-iteration") || parts.includes("--reset");
			const runId = parts.find((part) => !part.startsWith("--"));
			const state = resumableStateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify(runId ? `Run ${runId} cannot be resumed.` : "No resumable workflow runs found.", "warning");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is already running.`, "warning");
				return;
			}
			ctx.ui.notify(`Resuming ${state.runId} from ${state.phase || "pending phase"}${resetIteration ? " with a reset iteration budget" : ""}…`, "info");
			const resumed = await runWorkflow(pi, ctx, state.request, state.interactive, state.maxIterations, undefined, state, resetIteration, state.workflowId || "pbt-simple", state.workflowName === "dpbt" || Boolean(state.design));
			if (resumed.status === "failed" || resumed.status === "aborted") ctx.ui.notify(resumed.failureReason || resumed.status, "error");
		},
	});

	pi.registerCommand("dpbt-cleanup", {
		description: "Close a DPBT run's Herdr tabs, preview server, and persistent subagent sessions",
		handler: async (args, ctx) => {
			const state = dpbtStateForArgument(ctx.cwd, args.trim() || undefined);
			if (!state) {
				ctx.ui.notify("No DPBT runs found.", "info");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is still running; stop it before cleanup.`, "warning");
				return;
			}
			const result = await cleanupRunResources(ctx.cwd, state);
			const warningText = result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
			ctx.ui.notify(`Cleaned DPBT ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${warningText}`, result.warnings.length ? "warning" : "info");
		},
	});

	pi.registerCommand("pbt-cleanup", {
		description: "Close the latest PBT workflow run's Herdr tabs and remove its subagent sessions",
		handler: async (args, ctx) => {
			const requestedId = args.trim() || undefined;
			const state = stateForArgument(ctx.cwd, requestedId);
			if (!state) {
				ctx.ui.notify("No workflow runs found.", "info");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is still running in this pi process; stop it before cleanup.`, "warning");
				return;
			}
			const result = await cleanupRunResources(ctx.cwd, state);
			const warningText = result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
			ctx.ui.notify(`Cleaned ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${warningText}`, result.warnings.length ? "warning" : "info");
		},
	});

	pi.registerCommand("pbt-status", {
		description: "Show local workflow progress and handoffs",
		handler: async (args, ctx) => {
			const state = stateForArgument(ctx.cwd, args.trim() || undefined);
			if (!state) {
				ctx.ui.notify("No workflow runs found.", "info");
				return;
			}
			const text = `${inspectState(state, ctx.cwd, 30)}\n\nhandoffs: ${state.handoffs.length}\nanswers: ${state.answers.length}`;
			console.log(text);
			updateUI(ctx, state);
			ctx.ui.notify(`${state.runId}: ${state.status}`, "info");
		},
	});

	pi.registerCommand("dpbt-stop", {
		description: "Abort a running DPBT workflow run",
		handler: async (args, ctx) => {
			const entry = activeDpbtRun(args.trim() || undefined);
			if (!entry) {
				ctx.ui.notify("No active DPBT workflow runs.", "info");
				return;
			}
			const { runId, active } = entry;
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			updateUI(ctx, active.state);
			active.controller.abort();
			ctx.ui.notify(`Stopping DPBT ${runId}…`, "warning");
		},
	});

	pi.registerCommand("pbt-stop", {
		description: "Abort a running PBT workflow run",
		handler: async (args, ctx) => {
			const requestedId = args.trim() || [...activeRuns.keys()].at(-1);
			if (!requestedId) {
				ctx.ui.notify("No active workflow runs.", "info");
				return;
			}
			const active = activeRuns.get(requestedId);
			if (!active) {
				ctx.ui.notify(`No active workflow found for ${requestedId}.`, "warning");
				return;
			}
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			updateUI(ctx, active.state);
			active.controller.abort();
			ctx.ui.notify(`Stopping ${requestedId}…`, "warning");
		},
	});

	pi.registerTool({
		name: "pbt_start",
		label: "Start PBT",
		description: "Start the PBT workflow with isolated planner, builder, and tester sessions.",
		promptSnippet: "Start the deterministic PBT workflow",
		parameters: WorkflowStartParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const definition = resolveWorkflow(ctx.cwd, params.workflow, params.interactive ?? false);
			if (!definition) return { content: [{ type: "text", text: `Unknown workflow. Available: ${loadWorkflowDefinitions(ctx.cwd).map((item) => item.id).join(", ")}` }], details: {} };
			const state = await runWorkflow(
				pi,
				ctx,
				params.request,
				definition.interactive,
				params.maxIterations ?? definition.maxIterations,
				signal,
				undefined,
				false,
				definition.id,
				definition.runner === "dpbt",
			);
			return {
				content: [{ type: "text", text: buildFinalReport(state) }],
				details: state,
				isError: state.status === "failed" || state.status === "aborted",
			};
		},
		renderCall(args, theme) {
			const variant = String(args.workflow || (args.interactive ? "pbt-interactive" : "pbt-simple"));
			return new Text(
				theme.fg("toolTitle", theme.bold("workflow_start ")) +
					theme.fg("accent", variant) +
					theme.fg("dim", ` ${truncate(String(args.request || ""), 80)}`),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "dpbt_resume",
		label: "Resume DPBT",
		description: "Resume the newest or specified stopped DPBT workflow run, including a pending design review.",
		parameters: WorkflowResumeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = resumableDpbtStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No resumable DPBT workflow run found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is already running.` }], details: state };
			const resumed = await runWorkflow(pi, ctx, state.request, state.interactive, params.maxIterations ?? state.maxIterations, signal, state, params.resetIteration ?? false, state.workflowId || "dpbt", true);
			return { content: [{ type: "text", text: buildFinalReport(resumed) }], details: resumed, isError: resumed.status === "failed" || resumed.status === "aborted" };
		},
	});

	pi.registerTool({
		name: "pbt_resume",
		label: "Resume PBT",
		description: "Resume the newest or specified stopped PBT workflow run from its persisted pending phase.",
		parameters: WorkflowResumeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = resumableStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No resumable workflow run found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is already running.` }], details: state };
			const resumed = await runWorkflow(
				pi,
				ctx,
				state.request,
				state.interactive,
				params.maxIterations ?? state.maxIterations,
				signal,
				state,
				params.resetIteration ?? false,
				state.workflowId || "pbt-simple",
				state.workflowName === "dpbt" || Boolean(state.design),
			);
			return { content: [{ type: "text", text: buildFinalReport(resumed) }], details: resumed, isError: resumed.status === "failed" || resumed.status === "aborted" };
		},
	});

	pi.registerTool({
		name: "dpbt_cleanup",
		label: "Cleanup DPBT",
		description: "Close a DPBT run's Herdr tabs and preview server, then remove persistent designer/planner/builder/tester sessions.",
		parameters: WorkflowCleanupParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = dpbtStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No DPBT workflow runs found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is still running; stop it before cleanup.` }], details: state, isError: true };
			const result = await cleanupRunResources(ctx.cwd, state);
			const text = `Cleaned DPBT ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : ""}`;
			return { content: [{ type: "text", text }], details: result, isError: result.warnings.length > 0 };
		},
	});

	pi.registerTool({
		name: "pbt_cleanup",
		label: "Cleanup PBT",
		description: "Close a PBT workflow run's Herdr tabs and remove its planner, builder, and tester session files.",
		parameters: WorkflowCleanupParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No workflow runs found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is still running in this pi process; stop it before cleanup.` }], details: state, isError: true };
			const result = await cleanupRunResources(ctx.cwd, state);
			const text = `Cleaned ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : ""}`;
			return { content: [{ type: "text", text }], details: result, isError: result.warnings.length > 0 };
		},
	});

	pi.registerTool({
		name: "pbt_status",
		label: "PBT Status",
		description: "Read the state and latest handoffs for a PBT workflow run.",
		parameters: WorkflowStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No workflow runs found." }], details: {} };
			return { content: [{ type: "text", text: summarizeState(state) }], details: state };
		},
	});

	pi.registerCommand("pbt-inspect", {
		description: "Show recent live activity for a PBT workflow run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const runId = parts[0];
			const limit = parts[1] ? Number(parts[1]) : 40;
			const state = stateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify("No PBT workflow runs found.", "info");
				return;
			}
			console.log(inspectState(state, ctx.cwd, Number.isFinite(limit) ? limit : 40));
			updateUI(ctx, state);
		},
	});

	pi.registerTool({
		name: "pbt_inspect",
		label: "Inspect PBT",
		description: "Show recent live activity, active agent, phase, handoffs, and log path for a PBT workflow run.",
		parameters: PbtFlowInspectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No PBT workflow runs found." }], details: {} };
			const events = readProgress(ctx.cwd, state, params.limit ?? 40);
			return { content: [{ type: "text", text: inspectState(state, ctx.cwd, params.limit ?? 40) }], details: { state, events } };
		},
	});

	pi.registerTool({
		name: "dpbt_stop",
		label: "Stop DPBT",
		description: "Abort an active DPBT design-review or plan/build/test workflow run.",
		parameters: WorkflowStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = activeDpbtRun(params.runId);
			if (!entry) return { content: [{ type: "text", text: "No active DPBT workflow runs." }], details: {} };
			const { runId, active } = entry;
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			active.controller.abort();
			updateUI(ctx, active.state);
			return { content: [{ type: "text", text: `Stopping DPBT ${runId}.` }], details: active.state };
		},
	});

	pi.registerTool({
		name: "pbt_stop",
		label: "Stop PBT",
		description: "Abort a running PBT workflow subagent loop.",
		parameters: WorkflowStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedId = params.runId || [...activeRuns.keys()].at(-1);
			if (!requestedId) return { content: [{ type: "text", text: "No active workflow runs." }], details: {} };
			const active = activeRuns.get(requestedId);
			if (!active) return { content: [{ type: "text", text: `No active workflow found for ${requestedId}.` }], details: {} };
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			active.controller.abort();
			updateUI(ctx, active.state);
			return { content: [{ type: "text", text: `Stopping ${requestedId}.` }], details: active.state };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const currentSessionFile = ctx.sessionManager?.getSessionFile?.();
		if (!currentSessionFile) return;
		const resolvedCurrent = path.resolve(currentSessionFile);
		for (const state of listStates(ctx.cwd)) {
			if (state.status !== "running" && state.status !== "awaiting-clarification" && state.status !== "awaiting-design-review") continue;
			const isParentSession = state.parentSessionPath === currentSessionFile;
			// Use the persisted activity path so runs created by older versions
			// under legacy PBT run directories are also recognized by their child sessions.
			const runDir = state.activityLogPath
				? path.resolve(path.dirname(state.activityLogPath))
				: path.resolve(ctx.cwd, RUNS_DIR, state.runId);
			const isSubagentSession = resolvedCurrent.startsWith(runDir + path.sep);
			if (isParentSession || isSubagentSession) {
				updateUI(ctx, state);
				watchWorkflowStatus(ctx, state);
				if (isParentSession) {
					ctx.ui.notify(`${state.workflowId || state.workflowName} ${state.runId} was interrupted; resume it with /pbt-resume or inspect it with /pbt-status.`, "warning");
				}
				return;
			}
		}
	});

	pi.on("session_shutdown", () => {
		stopStatusWatcher();
	});
}
