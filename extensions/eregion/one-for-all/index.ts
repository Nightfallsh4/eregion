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
import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { MAX_ITERATIONS, RUNS_DIR } from "./constants.js";
import { runWorkflow } from "./orchestrator.js";
import { isJustBuildState, runBuildWorkflow } from "./build-orchestrator.js";
import { buildFinalReport, deliverWorkflowOutput } from "./report.js";
import { cleanupRunResources } from "./cleanup.js";
import { readProgress } from "./progress.js";
import { activeRuns, inspectState, isResumableState, listStates, loadState, saveState, stateForArgument, summarizeState } from "./state.js";
import { compactErrorMessage, sanitizeTerminalText, truncate } from "./util.js";
import type { WorkflowState } from "./types.js";
import { updateUI } from "./ui.js";
import { formatWorkflowCatalog, loadWorkflowDefinitions, resolveWorkflow, type WorkflowDefinition } from "./workflows.js";
import { buildQualitySetupTask, QUALITY_CONFIG_PATH } from "./quality.js";
import { buildDocumentationTask } from "./prompts.js";

const WorkflowStartParams = Type.Object({
	request: Type.String({ description: "Feature request for the selected workflow" }),
	workflow: Type.Optional(Type.String({ description: "Workflow catalog ID; defaults to pbt-simple" })),
	interactive: Type.Optional(Type.Boolean({ description: "Use clarification rounds in the main UI (design phase for DPBT, plan phase for PBT)", default: false })),
	docs: Type.Optional(Type.Boolean({ description: "Run the final documentation-maintenance subagent after every required Tester and quality gate passes", default: false })),
	// Keep the original tool parameter working while slash commands use --docs.
	doc: Type.Optional(Type.Boolean({ description: "Deprecated alias for docs", default: false })),
	maxIterations: Type.Optional(Type.Number({ description: "Maximum build/test iterations, or just-build quality-repair turns" })),
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
	maxIterations: Type.Optional(Type.Number({ description: "Maximum build/test iterations or just-build quality-repair turns (default uses the run's persisted cap)" })),
	resetIteration: Type.Optional(Type.Boolean({ description: "Reset the iteration budget when resuming a maxed-out run", default: false })),
});

const WorkflowCleanupParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run ID to clean; defaults to the latest run" })),
});

// Transcript messages are immutable in pi. Read the authoritative run file
// while rendering so an older report stops showing its error after a resume.
// Stat first to avoid parsing a potentially large state.json on every frame.
function currentReportState(report: WorkflowState): () => WorkflowState {
	const statePath = report.activityLogPath && path.join(path.dirname(report.activityLogPath), "state.json");
	let cached = report;
	let version: string | undefined;
	return () => {
		if (!statePath) return cached;
		try {
			const stat = fs.statSync(statePath);
			const nextVersion = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
			if (version !== nextVersion) {
				const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as WorkflowState;
				if (parsed.runId === report.runId) cached = parsed;
				version = nextVersion;
			}
		} catch {
			// The report snapshot still renders if a run file was cleaned up.
		}
		return cached;
	};
}

export default function oneForAllExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer<WorkflowState>("workflow-final-report", (message, { expanded }, theme) => {
		const report = message.details;
		if (!report) return undefined;
		if (report.status === "completed" && !report.resumeCount) return undefined;
		const readCurrent = currentReportState(report);
		return {
			render(width: number): string[] {
				const current = readCurrent();
				let text: string;
				const runId = compactErrorMessage(report.runId);
				if ((current.resumeCount || 0) > (report.resumeCount || 0)) {
					text = `Earlier workflow report superseded by resume · ${runId}`;
				} else if (report.status === "completed") {
					// A resumed success should not replay old failed verifications in
					// the TUI. The complete run history stays in the session and on disk.
					const destination = isJustBuildState(report) ? "Lint: passed" : `Plan: ${compactErrorMessage(report.planPath)}`;
					text = `Workflow completed · ${runId}\n${destination}`;
				} else if (expanded) {
					text = sanitizeTerminalText(buildFinalReport(report));
				} else {
					const failed = report.status === "failed" || report.status === "aborted";
					text = [
						theme.fg(failed ? "error" : "warning", compactErrorMessage(`Workflow ${report.status} · ${runId}`)),
						failed ? compactErrorMessage(report.failureReason || report.stopReason || "unknown error") : "Resume with --reset-iteration for a fresh budget.",
						"Expand for the full report, or use /pbt-status.",
					].join("\n");
				}
				return new Text(text, 0, 0).render(width);
			},
			invalidate() {},
		};
	});

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

	function buildStateForArgument(cwd: string, runId?: string): NonNullable<ReturnType<typeof loadState>> | null {
		if (runId) {
			const state = loadState(cwd, runId);
			return state && isJustBuildState(state) ? state : null;
		}
		const active = [...activeRuns.values()].map((control) => control.state).reverse().find(isJustBuildState);
		return active || listStates(cwd).find(isJustBuildState) || null;
	}

	function resumableBuildStateForArgument(cwd: string, runId?: string): NonNullable<ReturnType<typeof loadState>> | null {
		const state = buildStateForArgument(cwd, runId);
		return state && isResumableState(state) ? state : null;
	}

	function activeBuildRun(runId?: string): { runId: string; active: NonNullable<ReturnType<typeof activeRuns.get>> } | undefined {
		if (runId) {
			const active = activeRuns.get(runId);
			return active && isJustBuildState(active.state) ? { runId, active } : undefined;
		}
		const entry = [...activeRuns.entries()].reverse().find(([, active]) => isJustBuildState(active.state));
		return entry ? { runId: entry[0], active: entry[1] } : undefined;
	}

	function resumablePbtStateForArgument(cwd: string, runId?: string): NonNullable<ReturnType<typeof loadState>> | null {
		if (runId) {
			const state = loadState(cwd, runId);
			return state && !isJustBuildState(state) && isResumableState(state) ? state : null;
		}
		return listStates(cwd).find((state) => !isJustBuildState(state) && isResumableState(state)) || null;
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
			// Maxed-out and failed runs can resume in this same Herdr tab. Keep
			// watching until success or session close so a resumed run can
			// replace its terminal widget and retire earlier report errors.
			if (latest.status === "completed") stopStatusWatcher();
		}, 500);
	}

	async function startDefinition(definition: WorkflowDefinition, request: string, ctx: ExtensionCommandContext, documentationRequested = false): Promise<void> {
		// Each orchestrator delivers its final report through the replaceable UI.
		// Do not pass diagnostics through Pi's permanent notification layer.
		if (definition.runner === "build") {
			await runBuildWorkflow(pi, ctx, request, definition.maxIterations, undefined, undefined, false, definition.id, definition.models, documentationRequested, definition.efforts);
			return;
		}
		await runWorkflow(pi, ctx, request, definition.interactive, definition.maxIterations, undefined, undefined, false, definition.id, definition.runner === "dpbt", definition.models, documentationRequested, definition.efforts);
	}

	function parseStartFlags(args: string, allowInteractive: boolean): { request: string; interactive: boolean; documentationRequested: boolean; valid: boolean } {
		let interactive = false;
		let documentationRequested = false;
		const requestParts: string[] = [];
		for (const part of args.trim().split(/\s+/).filter(Boolean)) {
			// --doc remains accepted for existing scripts; advertise --docs so its
			// plural form clearly denotes the distinct documentation phase.
			if (part === "--docs" || part === "--doc") documentationRequested = true;
			else if (allowInteractive && part === "--interactive") interactive = true;
			else if (part === "--interactive") return { request: "", interactive: false, documentationRequested: false, valid: false };
			else requestParts.push(part);
		}
		return { request: requestParts.join(" ").trim(), interactive, documentationRequested, valid: true };
	}

	async function startFromCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseStartFlags(args, true);
		const definition = resolveWorkflow(ctx.cwd, "pbt", parsed.interactive);
		if (!parsed.valid || !parsed.request || !definition) {
			ctx.ui.notify("Usage: /pbt [--interactive] [--docs] <request>", "warning");
			return;
		}
		await startDefinition(definition, parsed.request, ctx, parsed.documentationRequested);
	}

	async function startBCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseStartFlags(args, false);
		const definition = resolveWorkflow(ctx.cwd, "b");
		if (!parsed.valid || !parsed.request || !definition) {
			ctx.ui.notify("Usage: /b [--docs] <request>", "warning");
			return;
		}
		await startDefinition(definition, parsed.request, ctx, parsed.documentationRequested);
	}

	async function startDpbtCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseStartFlags(args, true);
		const definition = resolveWorkflow(ctx.cwd, "dpbt", parsed.interactive);
		if (!parsed.valid || !parsed.request || !definition) {
			ctx.ui.notify("Usage: /dpbt [--interactive] [--docs] <request>", "warning");
			return;
		}
		await startDefinition(definition, parsed.request, ctx, parsed.documentationRequested);
	}

	async function startGenericCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const workflowId = parts.shift();
		const parsed = parseStartFlags(parts.join(" "), true);
		const definition = resolveWorkflow(ctx.cwd, workflowId, parsed.interactive);
		if (!parsed.valid || !definition || !parsed.request) {
			ctx.ui.notify(`Usage: /flow <workflow-id> [--interactive] [--docs] <request>\nAvailable workflows:\n${formatWorkflowCatalog(loadWorkflowDefinitions(ctx.cwd)).join("\n")}`, "warning");
			return;
		}
		await startDefinition(definition, parsed.request, ctx, parsed.documentationRequested);
	}

	pi.registerCommand("pbt", {
		description: "Run the PBT plan-build-test workflow; add --docs for a final Docs-agent phase",
		handler: startFromCommand,
	});

	pi.registerCommand("flow", {
		description: "Run a named workflow from the local workflow catalog",
		handler: startGenericCommand,
	});

	pi.registerCommand("b", {
		description: "Run the focused just-build workflow with required quality gates; add --docs for a final Docs-agent phase",
		handler: startBCommand,
	});

	pi.registerCommand("dpbt", {
		description: "Run Design → Plan → Build → Test with explicit mockup approval; --interactive asks design questions first; --docs adds a Docs-agent phase",
		handler: startDpbtCommand,
	});

	pi.registerCommand("doc", {
		description: "Start visible documentation maintenance in this Pi session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /doc", "warning");
				return;
			}
			if (activeRuns.size) {
				ctx.ui.notify("Wait for the active workflow to finish before running /doc so it can document a stable project state.", "warning");
				return;
			}
			// Sending a user message creates a normal, visible turn in the session
			// that invoked /doc. Do not dispatch this manual command through the
			// child-process subagent runner; --docs owns that separate final phase.
			pi.sendUserMessage(buildDocumentationTask("Project-wide documentation maintenance", [], true));
		},
	});

	pi.registerCommand("pbt-lint-setup", {
		description: "Start an in-session agent turn that inspects and configures the required PBT quality profile",
		handler: async (args, ctx) => {
			const force = args.trim() === "--force";
			if (args.trim() && !force) {
				ctx.ui.notify("Usage: /pbt-lint-setup [--force]", "warning");
				return;
			}
			const configPath = path.join(ctx.cwd, QUALITY_CONFIG_PATH);
			if (fs.existsSync(configPath) && !force) {
				ctx.ui.notify(`${QUALITY_CONFIG_PATH} already exists. Use /pbt-lint-setup --force to inspect and reconfigure it.`, "warning");
				return;
			}
			// A user message makes this a visible, interruptible turn in the current
			// session. The user can use Pi's normal interrupt/steer/follow-up controls.
			pi.sendUserMessage(buildQualitySetupTask(force));
		},
	});

	pi.registerCommand("flows", {
		description: "List available workflows and recent workflow runs",
		handler: async (_args, ctx) => {
			const definitions = loadWorkflowDefinitions(ctx.cwd);
			const states = listStates(ctx.cwd);
			deliverWorkflowOutput(pi, ctx, ["Available workflows:", ...formatWorkflowCatalog(definitions), "", "Recent runs:", ...(states.length ? states.slice(0, 10).map(summarizeState) : ["  (none)"])].join("\n\n"));
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
				"  /pbt-lint-setup [--force] — inspect the project and configure its required quality profile",
				"  /pbt [--interactive] [--docs] <request> — plan/build/test; --docs runs the final Docs-agent phase",
				"  /b [--docs] <request> — focused build, required lint, and optional final Docs-agent phase",
				"  /doc — visibly inspect, update, and clean docs/ in this current session",
				"  /b-resume [run-id] [--reset-iteration] — resume a stopped just-build run",
				"  /b-stop [run-id] — stop an active just-build run",
				"  /b-status [run-id] / /b-inspect [run-id] [limit] — inspect just-build progress",
				"  /b-cleanup [run-id] — close its Builder tab and remove the persistent session",
				"  /dpbt [--docs] <request> — design/review a mockup, then plan/build/test and an optional Docs-agent phase",
				"  /dpbt --interactive [--docs] <request> — ask design questions before mockup/review; then plan/build/test",
				"  /dpbt-resume [run-id] [--reset-iteration] — resume a stopped/review-pending DPBT run",
				"  /dpbt-stop [run-id] — stop an active DPBT run",
				"  /dpbt-cleanup [run-id] — close DPBT tabs, preview server, and subagent sessions",
				"  /pbt-resume [run-id] [--reset-iteration] — resume a stopped run; reset the iteration budget when needed",
				"  /pbt-cleanup [run-id] — close tabs and remove subagent sessions",
				"  /flow <workflow-id> [--interactive] [--docs] <request> — run a named workflow",
				"",
				"Recent runs:",
				...(states.length ? states.slice(0, 10).map(summarizeState) : ["  (none)"]),
			];
			deliverWorkflowOutput(pi, ctx, lines.join("\n\n"));
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
			const definition = resolveWorkflow(ctx.cwd, state.workflowId || "dpbt");
			await runWorkflow(pi, ctx, state.request, state.interactive, state.maxIterations, undefined, state, resetIteration, state.workflowId || "dpbt", true, definition?.models, state.documentationRequested, definition?.efforts);
		},
	});

	pi.registerCommand("b-resume", {
		description: "Resume a stopped, failed, aborted, or interrupted just-build run using its persistent Builder session",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const resetIteration = parts.includes("--reset-iteration") || parts.includes("--reset");
			const runId = parts.find((part) => !part.startsWith("--"));
			const state = resumableBuildStateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify(runId ? `Just-build run ${runId} cannot be resumed.` : "No resumable just-build runs found.", "warning");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is already running.`, "warning");
				return;
			}
			ctx.ui.notify(`Resuming just-build ${state.runId} from ${state.phase || "pending phase"}…`, "info");
			const definition = resolveWorkflow(ctx.cwd, state.workflowId || "b");
			await runBuildWorkflow(pi, ctx, state.request, state.maxLintRepairs || definition?.maxIterations || MAX_ITERATIONS, undefined, state, resetIteration, state.workflowId || "b", definition?.models, state.documentationRequested, definition?.efforts);
		},
	});

	pi.registerCommand("pbt-resume", {
		description: "Resume a stopped, failed, aborted, or interrupted PBT workflow run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const resetIteration = parts.includes("--reset-iteration") || parts.includes("--reset");
			const runId = parts.find((part) => !part.startsWith("--"));
			const state = resumablePbtStateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify(runId ? `Run ${runId} cannot be resumed.` : "No resumable workflow runs found.", "warning");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is already running.`, "warning");
				return;
			}
			ctx.ui.notify(`Resuming ${state.runId} from ${state.phase || "pending phase"}${resetIteration ? " with a reset iteration budget" : ""}…`, "info");
			const definition = resolveWorkflow(ctx.cwd, state.workflowId || "pbt-simple");
			await runWorkflow(pi, ctx, state.request, state.interactive, state.maxIterations, undefined, state, resetIteration, state.workflowId || "pbt-simple", state.workflowName === "dpbt" || Boolean(state.design), definition?.models, state.documentationRequested, definition?.efforts);
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

	pi.registerCommand("b-cleanup", {
		description: "Close a just-build run's Herdr Builder tab and remove its persistent Builder session",
		handler: async (args, ctx) => {
			const state = buildStateForArgument(ctx.cwd, args.trim() || undefined);
			if (!state) {
				ctx.ui.notify("No just-build runs found.", "info");
				return;
			}
			if (activeRuns.has(state.runId)) {
				ctx.ui.notify(`${state.runId} is still running; stop it before cleanup.`, "warning");
				return;
			}
			const result = await cleanupRunResources(ctx.cwd, state);
			const warningText = result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : "";
			ctx.ui.notify(`Cleaned just-build ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${warningText}`, result.warnings.length ? "warning" : "info");
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

	pi.registerCommand("b-status", {
		description: "Show just-build progress, Builder handoffs, and lint attempts",
		handler: async (args, ctx) => {
			const state = buildStateForArgument(ctx.cwd, args.trim() || undefined);
			if (!state) {
				ctx.ui.notify("No just-build runs found.", "info");
				return;
			}
			deliverWorkflowOutput(pi, ctx, `${inspectState(state, ctx.cwd, 30)}\n\nhandoffs: ${state.handoffs.length}`);
			updateUI(ctx, state);
			ctx.ui.notify(`${state.runId}: ${state.status}`, "info");
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
			deliverWorkflowOutput(pi, ctx, text);
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

	pi.registerCommand("b-stop", {
		description: "Abort a running just-build workflow run",
		handler: async (args, ctx) => {
			const entry = activeBuildRun(args.trim() || undefined);
			if (!entry) {
				ctx.ui.notify("No active just-build workflow runs.", "info");
				return;
			}
			const { runId, active } = entry;
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			updateUI(ctx, active.state);
			active.controller.abort();
			ctx.ui.notify(`Stopping just-build ${runId}…`, "warning");
		},
	});

	pi.registerCommand("pbt-stop", {
		description: "Abort a running PBT workflow run",
		handler: async (args, ctx) => {
			const requestedId = args.trim() || [...activeRuns.entries()].reverse().find(([, active]) => !isJustBuildState(active.state))?.[0];
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
			const state = definition.runner === "build"
				? await runBuildWorkflow(
					pi,
					ctx,
					params.request,
					params.maxIterations ?? definition.maxIterations,
					signal,
					undefined,
					false,
					definition.id,
					definition.models,
					params.docs ?? params.doc ?? false,
					definition.efforts,
				)
				: await runWorkflow(
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
					definition.models,
					params.docs ?? params.doc ?? false,
					definition.efforts,
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
		name: "b_resume",
		label: "Resume Just Build",
		description: "Resume the newest or specified stopped just-build run in its persistent Builder session.",
		parameters: WorkflowResumeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = resumableBuildStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No resumable just-build workflow run found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is already running.` }], details: state };
			const definition = resolveWorkflow(ctx.cwd, state.workflowId || "b");
			const resumed = await runBuildWorkflow(pi, ctx, state.request, params.maxIterations ?? state.maxLintRepairs ?? definition?.maxIterations ?? MAX_ITERATIONS, signal, state, params.resetIteration ?? false, state.workflowId || "b", definition?.models, state.documentationRequested, definition?.efforts);
			return { content: [{ type: "text", text: buildFinalReport(resumed) }], details: resumed, isError: resumed.status === "failed" || resumed.status === "aborted" };
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
			const definition = resolveWorkflow(ctx.cwd, state.workflowId || "dpbt");
			const resumed = await runWorkflow(pi, ctx, state.request, state.interactive, params.maxIterations ?? state.maxIterations, signal, state, params.resetIteration ?? false, state.workflowId || "dpbt", true, definition?.models, state.documentationRequested, definition?.efforts);
			return { content: [{ type: "text", text: buildFinalReport(resumed) }], details: resumed, isError: resumed.status === "failed" || resumed.status === "aborted" };
		},
	});

	pi.registerTool({
		name: "pbt_resume",
		label: "Resume PBT",
		description: "Resume the newest or specified stopped PBT workflow run from its persisted pending phase.",
		parameters: WorkflowResumeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = resumablePbtStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No resumable PBT or DPBT workflow run found." }], details: {} };
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
				resolveWorkflow(ctx.cwd, state.workflowId || "pbt-simple")?.models,
				state.documentationRequested,
				resolveWorkflow(ctx.cwd, state.workflowId || "pbt-simple")?.efforts,
			);
			return { content: [{ type: "text", text: buildFinalReport(resumed) }], details: resumed, isError: resumed.status === "failed" || resumed.status === "aborted" };
		},
	});

	pi.registerTool({
		name: "b_cleanup",
		label: "Cleanup Just Build",
		description: "Close a just-build run's Herdr Builder tab and remove its persistent Builder session file.",
		parameters: WorkflowCleanupParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = buildStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No just-build workflow runs found." }], details: {} };
			if (activeRuns.has(state.runId)) return { content: [{ type: "text", text: `${state.runId} is still running; stop it before cleanup.` }], details: state, isError: true };
			const result = await cleanupRunResources(ctx.cwd, state);
			const text = `Cleaned just-build ${state.runId}: closed ${result.tabsClosed} tab(s), removed ${result.sessionsRemoved} session(s).${result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : ""}`;
			return { content: [{ type: "text", text }], details: result, isError: result.warnings.length > 0 };
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
		name: "b_status",
		label: "Just Build Status",
		description: "Read the state, Builder handoffs, and lint attempts for a just-build run.",
		parameters: WorkflowStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = buildStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No just-build workflow runs found." }], details: {} };
			return { content: [{ type: "text", text: summarizeState(state) }], details: state };
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

	pi.registerCommand("b-inspect", {
		description: "Show recent live activity for a just-build workflow run",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const runId = parts[0];
			const limit = parts[1] ? Number(parts[1]) : 40;
			const state = buildStateForArgument(ctx.cwd, runId);
			if (!state) {
				ctx.ui.notify("No just-build runs found.", "info");
				return;
			}
			deliverWorkflowOutput(pi, ctx, inspectState(state, ctx.cwd, Number.isFinite(limit) ? limit : 40));
			updateUI(ctx, state);
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
			deliverWorkflowOutput(pi, ctx, inspectState(state, ctx.cwd, Number.isFinite(limit) ? limit : 40));
			updateUI(ctx, state);
		},
	});

	pi.registerTool({
		name: "b_inspect",
		label: "Inspect Just Build",
		description: "Show recent Builder/lint activity, phase, handoffs, and log path for a just-build workflow run.",
		parameters: PbtFlowInspectParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = buildStateForArgument(ctx.cwd, params.runId);
			if (!state) return { content: [{ type: "text", text: "No just-build workflow runs found." }], details: {} };
			const events = readProgress(ctx.cwd, state, params.limit ?? 40);
			return { content: [{ type: "text", text: inspectState(state, ctx.cwd, params.limit ?? 40) }], details: { state, events } };
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
		name: "b_stop",
		label: "Stop Just Build",
		description: "Abort an active just-build workflow run.",
		parameters: WorkflowStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = activeBuildRun(params.runId);
			if (!entry) return { content: [{ type: "text", text: "No active just-build workflow runs." }], details: {} };
			const { runId, active } = entry;
			active.state.status = "aborted";
			active.state.stopReason = "aborted";
			active.state.failureReason = "Stopped by user";
			saveState(ctx.cwd, active.state, pi);
			active.controller.abort();
			updateUI(ctx, active.state);
			return { content: [{ type: "text", text: `Stopping just-build ${runId}.` }], details: active.state };
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
			const requestedId = params.runId || [...activeRuns.entries()].reverse().find(([, active]) => !isJustBuildState(active.state))?.[0];
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
			if (!isResumableState(state)) continue;
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
					const resumeCommand = isJustBuildState(state) ? "/b-resume" : "/pbt-resume";
					const statusCommand = isJustBuildState(state) ? "/b-status" : "/pbt-status";
					ctx.ui.notify(`${state.workflowId || state.workflowName} ${state.runId} was interrupted; resume it with ${resumeCommand} or inspect it with ${statusCommand}.`, "warning");
				}
				return;
			}
		}
	});

	pi.on("session_shutdown", () => {
		stopStatusWatcher();
		for (const { controller } of activeRuns.values()) controller.abort();
	});
}
