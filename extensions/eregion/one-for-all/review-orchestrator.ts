import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MAX_ITERATIONS, RUNS_DIR } from "./constants.js";
import { parseClarificationRequest, requireHandoff, validateReviewHandoff, validateReviewPlanHandoff } from "./handoffs.js";
import { reservePlanPath, releasePlanReservation } from "./plan-paths.js";
import { buildReviewBuildTask, buildReviewPlanRecoveryTask, buildReviewPlanTask, buildReviewTask } from "./prompts.js";
import { appendProgress } from "./progress.js";
import { readQualityConfig, runQualityCommand, type QualityConfig } from "./quality.js";
import { finishReport } from "./report.js";
import { activeRuns, assertAcceptanceCriteria, createRunId, saveState } from "./state.js";
import { resolveSubagentEfforts, resolveSubagentModels, runSubagent, type SubagentEfforts, type SubagentModels } from "./subagent.js";
import type { PhaseHandoff, ProgressEvent, QualityRun, RunControl, TestIssue, WorkflowState } from "./types.js";
import { ensureDirectory } from "./util.js";
import { askClarifications, updateUI } from "./ui.js";
import { projectAgentPath } from "../package-paths.js";

function gitHead(cwd: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

async function runRequiredQuality(cwd: string, config: QualityConfig, signal: AbortSignal, state: WorkflowState, stage: "review" | "final-review", iteration: number): Promise<void> {
	const failures: string[] = [];
	for (const name of config.required) {
		const result = await runQualityCommand(cwd, name, config.commands[name], config.timeoutMs, signal);
		const qualityRun: QualityRun = { ...result, stage, iteration, attempt: 1, completedAt: Date.now(), iterationCycle: state.iterationCycle || 0 };
		state.qualityRuns = [...(state.qualityRuns || []), qualityRun];
		if (result.exitCode !== 0) failures.push(`${name} exited ${result.exitCode}`);
	}
	if (failures.length) throw new Error(`Required ${stage} quality checks failed: ${failures.join(", ")}`);
}

/** PBR/DPBR lifecycle: plan with acceptance criteria, Builder-owned TDD, then persistent review. */
export async function runReviewWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	request: string,
	interactive: boolean,
	maxIterations: number,
	externalSignal?: AbortSignal,
	resumeState?: WorkflowState,
	workflowId = "pbr-simple",
	useDesignReview = false,
	models?: SubagentModels,
	efforts?: SubagentEfforts,
): Promise<WorkflowState> {
	const cwd = ctx.cwd;
	const runId = resumeState?.runId || createRunId();
	const runDir = resumeState?.activityLogPath ? path.dirname(resumeState.activityLogPath) : path.join(cwd, RUNS_DIR, runId);
	ensureDirectory(runDir);
	const builderPlanPath = resumeState?.builderPlanPath || reservePlanPath(cwd, request);
	const state: WorkflowState = resumeState || {
		workflowName: useDesignReview ? "dpbr" : "pbr", workflowId, request, runId, planPath: builderPlanPath, builderPlanPath,
		interactive, answers: [], questionRounds: 0, handoffs: [], iteration: 0, iterationCycle: 0,
		maxIterations: Math.max(1, Math.min(20, maxIterations || MAX_ITERATIONS)), status: "running", phase: "plan",
		startedAt: Date.now(), completedAt: null, activityLogPath: path.join(runDir, "activity.jsonl"), eventCount: 0,
	};
	const controller = new AbortController();
	if (externalSignal?.aborted) controller.abort(); else externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
	activeRuns.set(runId, { state, controller, context: ctx } as RunControl);
	const config = readQualityConfig(cwd);
	state.qualityProfile = { commands: config.commands, required: config.required };
	const agentModels = resolveSubagentModels(ctx, models);
	const agentEfforts = resolveSubagentEfforts(efforts);
	state.agentModels = agentModels;
	state.agentEfforts = agentEfforts;
	const baselineHead = gitHead(cwd);
	const progress = (agentName: "planner" | "builder" | "reviewer", phase: string) => ({ agentName, phase, effort: agentEfforts[agentName], permissionContext: ctx, permissionWorkflow: useDesignReview ? "DPBR" : "PBR", activityLogPath: state.activityLogPath!, onProgress: (event: ProgressEvent) => { appendProgress(cwd, state, event); saveState(cwd, state, pi, false); updateUI(ctx, state); } });
	try {
		let plan = state.handoffs.find((handoff) => handoff.phase === "plan");
		while (!plan) {
			state.phase = "plan"; saveState(cwd, state, pi);
			const result = await runSubagent({ cwd, agentPath: projectAgentPath(cwd, interactive ? "planner-interactive.md" : "planner-simple.md"), model: agentModels.planner, task: buildReviewPlanTask(request, builderPlanPath, state.answers, interactive), tools: ["read", "grep", "find", "ls", "bash", "write"], sessionPath: path.join(runDir, "planner.jsonl"), signal: controller.signal, ...progress("planner", "plan") });
			const clarification = parseClarificationRequest(result.output, "plan");
			if (clarification && interactive) { state.questionRounds++; state.answers.push(...await askClarifications(ctx, clarification.questions, state.questionRounds)); continue; }
			plan = requireHandoff(result, "plan", 1); plan.builderPlanPath = builderPlanPath;
			try { validateReviewPlanHandoff(plan, builderPlanPath); assertAcceptanceCriteria(cwd, builderPlanPath); } catch (error) {
				const recovery = await runSubagent({ cwd, agentPath: projectAgentPath(cwd, interactive ? "planner-interactive.md" : "planner-simple.md"), model: agentModels.planner, task: buildReviewPlanRecoveryTask(builderPlanPath, String(error)), tools: ["read", "grep", "find", "ls", "bash", "write"], sessionPath: path.join(runDir, "planner.jsonl"), signal: controller.signal, ...progress("planner", "plan-recovery") });
				plan = requireHandoff(recovery, "plan", 1); plan.builderPlanPath = builderPlanPath; validateReviewPlanHandoff(plan, builderPlanPath); assertAcceptanceCriteria(cwd, builderPlanPath);
			}
			state.handoffs.push(plan); saveState(cwd, state, pi);
		}
		let priorIssues: TestIssue[] = [];
		for (let iteration = 1; iteration <= state.maxIterations; iteration++) {
			state.iteration = iteration; state.phase = iteration === 1 ? "build" : "build fixes"; saveState(cwd, state, pi);
			const task = iteration === 1 ? buildReviewBuildTask(request, builderPlanPath, plan, iteration) : `Fix only these Reviewer issues using superpowers:test-driven-development, including tests and verification. Do not commit.\n${JSON.stringify(priorIssues)}`;
			const buildResult = await runSubagent({ cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: agentModels.builder, task, tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"), signal: controller.signal, ...progress("builder", `build-${iteration}`) });
			const build = requireHandoff(buildResult, "build", iteration); state.handoffs.push(build); saveState(cwd, state, pi);
			state.phase = "review";
			const reviewResult = await runSubagent({ cwd, agentPath: projectAgentPath(cwd, "reviewer.md"), model: agentModels.reviewer, task: buildReviewTask(request, builderPlanPath, build, iteration, Object.fromEntries(config.required.map((name) => [name, config.commands[name]])), priorIssues), tools: ["read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "review.jsonl"), signal: controller.signal, planOnly: true, reviewerCommitException: true, ...progress("reviewer", `review-${iteration}`) });
			const review = requireHandoff(reviewResult, "review", iteration); validateReviewHandoff(review); state.handoffs.push(review); saveState(cwd, state, pi);
			if (review.status === "pass") {
				if (review.commitSha !== gitHead(cwd) || review.commitSha === baselineHead) throw new Error("Reviewer commit was not created or does not match HEAD");
				state.reviewCommitSha = review.commitSha;
				await runRequiredQuality(cwd, config, controller.signal, state, "final-review", iteration);
				state.status = "completed"; state.completedAt = Date.now(); saveState(cwd, state, pi); finishReport(pi, ctx, state); return state;
			}
			priorIssues = review.issues || [];
		}
		state.status = "max-iterations-reached"; state.stopReason = "max-iterations";
	} catch (error) {
		state.status = controller.signal.aborted ? "aborted" : "failed"; state.stopReason = controller.signal.aborted ? "aborted" : "error"; state.failureReason = error instanceof Error ? error.message : String(error);
	} finally {
		state.completedAt = Date.now(); saveState(cwd, state, pi); finishReport(pi, ctx, state); activeRuns.delete(runId); releasePlanReservation(cwd, builderPlanPath);
	}
	return state;
}
