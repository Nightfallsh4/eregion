/**
 * Focused just-build (`/b`) workflow.
 *
 * Unlike PBT/DPBT this workflow has no plan, design, test-authoring, or test
 * verification phase. It makes one implementation turn in a persistent
 * Builder session, runs every required project quality command itself, and
 * gives each failed result back to that exact Builder session until all
 * required commands pass or the configured repair budget is exhausted.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { RUNS_DIR } from "./constants.js";
import { requireHandoff } from "./handoffs.js";
import { appendProgress } from "./progress.js";
import { buildJustBuildLintRepairTask, buildJustBuildTask } from "./prompts.js";
import { finishReport } from "./report.js";
import { isHerdrTuiEnabled } from "./herdr.js";
import { resolveSubagentEfforts, resolveSubagentModels, runSubagent, type SubagentEfforts, type SubagentModels } from "./subagent.js";
import { activeRuns, createRunId, saveState } from "./state.js";
import type { ProgressEvent, QualityRun, RunControl, WorkflowState } from "./types.js";
import { ensureDirectory } from "./util.js";
import { updateUI } from "./ui.js";
import { projectAgentPath } from "../package-paths.js";
import { refreshOpenRouterModels } from "../openrouter-dynamic-models/index.js";
import { readQualityConfig, renderQualityFailure, runQualityCommand, type QualityConfig } from "./quality.js";
import { runDocumentationPhase } from "./documentation.js";

export function isJustBuildState(state: WorkflowState): boolean {
	return state.workflowName === "b" || state.workflowId === "b";
}

/**
 * Run or resume the one-build-plus-lint workflow. `maxLintRepairs` is the
 * workflow definition's loop budget and means repair *turns*, not build/test
 * iterations. The implementation build remains iteration 1 throughout.
 */
export async function runBuildWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	request: string,
	maxLintRepairs: number,
	externalSignal?: AbortSignal,
	resumeState?: WorkflowState,
	resetIteration = false,
	workflowId = "b",
	models?: SubagentModels,
	documentationRequested = false,
	efforts?: SubagentEfforts,
): Promise<WorkflowState> {
	const cwd = ctx.cwd;
	const resumed = Boolean(resumeState);
	const runId = resumeState?.runId || createRunId();
	const runDir = resumeState?.activityLogPath
		? path.dirname(path.resolve(resumeState.activityLogPath))
		: path.join(cwd, RUNS_DIR, runId);
	ensureDirectory(runDir);
	const repairLimit = Math.max(1, Math.min(20, Math.floor(maxLintRepairs) || 3));
	const state: WorkflowState = resumeState || {
		workflowName: "b",
		workflowId,
		request,
		runId,
		// WorkflowState remains compatible with PBT's plan-bearing state shape,
		// but no path is reserved or written for this build-only workflow.
		planPath: "(not used by just-build)",
		interactive: false,
		answers: [],
		questionRounds: 0,
		handoffs: [],
		iteration: 0,
		maxIterations: 1,
		maxLintRepairs: repairLimit,
		iterationCycle: 0,
		status: "running",
		phase: "build",
		startedAt: Date.now(),
		completedAt: null,
		activityLogPath: path.join(runDir, "activity.jsonl"),
		eventCount: 0,
		documentationRequested,
	};
	state.workflowName = "b";
	state.workflowId = state.workflowId || workflowId;
	state.maxIterations = 1;
	state.maxLintRepairs = Math.max(state.maxLintRepairs || 1, repairLimit);
	state.iterationCycle = state.iterationCycle || 0;
	state.documentationRequested = Boolean(state.documentationRequested || documentationRequested);
	if (resumed) {
		state.stopReason = undefined;
		state.failureReason = undefined;
		state.latestOutput = undefined;
		state.currentAgent = undefined;
		state.currentActivity = undefined;
	}
	if (resumed && resetIteration) state.iterationCycle++;
	state.status = "running";
	state.completedAt = null;
	state.resumeCount = (state.resumeCount || 0) + (resumed ? 1 : 0);
	state.lastResumedAt = resumed ? Date.now() : state.lastResumedAt;
	state.parentSessionPath = state.parentSessionPath || ctx.sessionManager?.getSessionFile?.() || undefined;
	const now = Date.now();
	state.agentStatuses = {
		builder: { status: "waiting", phase: "build", activity: "waiting to start", updatedAt: now },
		...(state.documentationRequested ? { documentation: { status: "waiting" as const, phase: "documentation", activity: "waiting for successful workflow completion", updatedAt: now } } : {}),
	};

	const controller = new AbortController();
	const control: RunControl = { state, controller, context: ctx };
	activeRuns.set(runId, control);
	const relayAbort = () => controller.abort();
	if (externalSignal) {
		if (externalSignal.aborted) controller.abort();
		else externalSignal.addEventListener("abort", relayAbort, { once: true });
	}
	saveState(cwd, state, pi);
	updateUI(ctx, state);

	try {
		const qualityConfig: QualityConfig = readQualityConfig(cwd);
		state.qualityProfile = { commands: qualityConfig.commands, required: qualityConfig.required };
		saveState(cwd, state, pi);

		const missingOpenRouterModel = Object.values(models || {}).some((raw) => {
		const value = raw?.trim();
		if (!value) return false;
		const slash = value.indexOf("/");
		if (slash <= 0 || value.slice(0, slash) !== "openrouter") return false;
		const model = ctx.modelRegistry.find("openrouter", value.slice(slash + 1));
		return !model || !ctx.modelRegistry.hasConfiguredAuth(model);
	});
	if (missingOpenRouterModel) await refreshOpenRouterModels(pi);

	const resolvedModels = resolveSubagentModels(ctx, models);
	const resolvedEfforts = resolveSubagentEfforts(efforts);
	const builderModel = resolvedModels.builder;
	const builderEffort = resolvedEfforts.builder;
	const herdrTui = isHerdrTuiEnabled();
	const tui = herdrTui ? { runId, agentKey: "builder", tabLabel: "b build", workflowPrefix: "b" } : undefined;
	state.agentModels = {
		...(builderModel ? { builder: builderModel } : {}),
		...(state.documentationRequested && resolvedModels.documentation ? { documentation: resolvedModels.documentation } : {}),
	};
	state.agentEfforts = {
		builder: builderEffort,
		...(state.documentationRequested ? { documentation: resolvedEfforts.documentation } : {}),
	};
	state.latestOutput = builderModel
		? `Builder (${herdrTui ? "Herdr TUI tab" : "headless"}): ${builderModel}; effort: ${builderEffort}`
		: `Builder: no authenticated model resolved; effort: ${builderEffort}`;
	saveState(cwd, state, pi);

	const cycle = state.iterationCycle || 0;
	const progress = (phase: string) => ({
		agentName: "builder",
		phase,
		effort: builderEffort,
		permissionContext: ctx,
		permissionWorkflow: "B",
		activityLogPath: state.activityLogPath!,
		onProgress: (event: ProgressEvent) => {
			appendProgress(cwd, state, event);
			saveState(cwd, state, pi, false);
			updateUI(ctx, state);
		},
	});
	const runBuilder = async (task: string, phase: string) => runSubagent({
		cwd,
		agentPath: projectAgentPath(cwd, "builder.md"),
		model: builderModel,
		task,
		tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
		sessionPath: path.join(runDir, "build.jsonl"),
		signal: controller.signal,
		tui,
		onOutput: (output) => updateUI(ctx, state, output),
		...progress(phase),
	});

		let buildHandoff = state.handoffs
			.filter((handoff) => handoff.phase === "build" && handoff.iteration === 1)
			.at(0);
		if (!buildHandoff) {
			if (controller.signal.aborted) throw new Error("Workflow aborted");
			state.iteration = 1;
			state.phase = "build";
			state.status = "running";
			saveState(cwd, state, pi);
			const result = await runBuilder(buildJustBuildTask(request), "build-1");
			buildHandoff = requireHandoff(result, "build", 1);
			buildHandoff.iterationCycle = cycle;
			state.handoffs.push(buildHandoff);
			saveState(cwd, state, pi);
			updateUI(ctx, state, result.output);
		} else {
			state.iteration = 1;
		}

		for (let attempt = 1; attempt <= state.maxLintRepairs! + 1; attempt++) {
			if (controller.signal.aborted) throw new Error("Workflow aborted");
			state.phase = "build quality";
			state.status = "running";
			state.latestOutput = `Running required project quality commands: ${qualityConfig.required.join(", ")}`;
			appendProgress(cwd, state, {
				timestamp: Date.now(), agent: "quality", phase: "build quality", kind: "started",
				message: `Running ${qualityConfig.required.length} required quality command(s) (attempt ${attempt})`, details: qualityConfig.required.join(", "),
			});
			saveState(cwd, state, pi);
			updateUI(ctx, state);

			const results: QualityRun[] = [];
			for (const name of qualityConfig.required) {
				const result = await runQualityCommand(cwd, name, qualityConfig.commands[name], qualityConfig.timeoutMs, controller.signal);
				const qualityRun: QualityRun = { ...result, stage: "build", iteration: 1, attempt, completedAt: Date.now(), iterationCycle: cycle };
				results.push(qualityRun);
				state.qualityRuns = [...(state.qualityRuns || []), qualityRun];
				appendProgress(cwd, state, {
					timestamp: qualityRun.completedAt, agent: "quality", phase: "build quality",
					kind: result.exitCode === 0 ? "completed" : "failed",
					message: result.exitCode === 0 ? `Quality command ${name} passed` : `Quality command ${name} failed with exit code ${result.exitCode}`,
					details: result.exitCode === 0 ? result.command : renderQualityFailure(result).slice(0, 2_000),
				});
			}
			saveState(cwd, state, pi);
			const failed = results.filter((result) => result.exitCode !== 0);
			if (failed.length === 0) {
				if (state.documentationRequested) await runDocumentationPhase(pi, ctx, state, models, controller.signal, efforts);
				state.status = "completed";
				state.phase = "completed";
				state.completedAt = Date.now();
				saveState(cwd, state, pi);
				finishReport(pi, ctx, state);
				return state;
			}

			const diagnostics = failed.map(renderQualityFailure).join("\n\n");
			if (attempt > state.maxLintRepairs!) {
				throw new Error(`Required project quality commands still fail after ${state.maxLintRepairs} repair attempt(s); just-build cannot complete.\n${diagnostics}`);
			}
			state.phase = "build quality repair";
			state.latestOutput = "Sending quality-gate failures to the persistent Builder session";
			saveState(cwd, state, pi);
			updateUI(ctx, state, diagnostics);
			const repairResult = await runBuilder(buildJustBuildLintRepairTask(diagnostics, attempt), `build-quality-repair-${attempt}`);
			const repairHandoff = requireHandoff(repairResult, "build", 1);
			repairHandoff.iterationCycle = cycle;
			state.handoffs.push(repairHandoff);
			saveState(cwd, state, pi);
			updateUI(ctx, state, repairResult.output);
		}
		throw new Error("Just-build quality loop ended unexpectedly");
	} catch (error) {
		const aborted = controller.signal.aborted || /aborted/i.test(error instanceof Error ? error.message : String(error));
		state.status = aborted ? "aborted" : "failed";
		state.stopReason = aborted ? "aborted" : "error";
		state.failureReason = `phase=${state.phase || "unknown"}, build=1: ${error instanceof Error ? error.message : String(error)}`;
		state.completedAt = Date.now();
		saveState(cwd, state, pi);
		finishReport(pi, ctx, state);
		return state;
	} finally {
		if (externalSignal) externalSignal.removeEventListener("abort", relayAbort);
		activeRuns.delete(runId);
	}
}
