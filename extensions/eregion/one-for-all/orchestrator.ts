/**
 * The plan → build → test orchestration loop.
 *
 * This module owns only the control flow: it composes the reusable pieces
 * (plan path reservation, subagent runner, handoff protocol, prompts, state
 * persistence, progress logging, and UI) into the One For All lifecycle:
 *
 * 1. Reserve a deterministic feature-named plan path.
 * 2. For PBT, plan with clarification rounds in the interactive variant;
 *    for DPBT, optionally clarify during design before approval.
 * 3. Build and author tests in parallel; test execution waits for the
 *    builder-complete barrier.
 * 4. Verify with the persistent tester session.
 * 5. Feed failures back to the persistent builder session, up to the
 *    iteration cap or a detected plateau.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { MAX_ITERATIONS, MAX_LINT_REPAIR_ATTEMPTS, RUNS_DIR, WORKFLOW_NAME } from "./constants.js";
import {
	detectPlateau,
	parseClarificationRequest,
	parseHandoff,
	readLatestAssistantText,
	requireHandoff,
	validateAuthoringHandoff,
	validatePlanHandoff,
	validateVerificationHandoff,
} from "./handoffs.js";
import { releasePlanReservations, reservePlanPaths } from "./plan-paths.js";
import { appendProgress } from "./progress.js";
import {
	buildCompletionTask,
	buildInitialBuildTask,
	buildLintRepairTask,
	buildIssueFixRetryTask,
	buildIssueFixTask,
	buildDesignTask,
	buildPlanRecoveryTask,
	buildPlanTask,
	buildTestAuthoringTask,
	buildTestAuthoringLintRepairTask,
	buildTestVerificationLintRepairTask,
	buildTestVerificationTask,
} from "./prompts.js";
import { finishReport } from "./report.js";
import { isHerdrTuiEnabled } from "./herdr.js";
import { resolveSubagentEfforts, resolveSubagentModels, runSubagent, type SubagentEfforts, type SubagentModels, type SubagentRole } from "./subagent.js";
import { activeRuns, assertPlanOutputsExist, createRunId, saveState } from "./state.js";
import type { AgentResult, IssueLedgerEntry, LintRun, PhaseHandoff, ProgressEvent, RunControl, TestIssue, WorkflowState } from "./types.js";
import { ensureDirectory } from "./util.js";
import { askClarifications, updateUI } from "./ui.js";
import { attachDesignReviewAssets, ensureDesignPreviewServer, initializeDesignReview, openDesignPreview, readApproval, readDesignFeedback, readReviewAction, resetReviewRequest } from "./design-review.js";
import { projectAgentPath } from "../package-paths.js";
import { refreshOpenRouterModels } from "../openrouter-dynamic-models/index.js";
import { readLintConfig, renderLintFailure, runLintCommand, type LintConfig } from "./lint.js";
import { runDocumentationPhase } from "./documentation.js";

export async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	request: string,
	interactive: boolean,
	maxIterations: number,
	externalSignal?: AbortSignal,
	resumeState?: WorkflowState,
	resetIteration = false,
	workflowId = "pbt-simple",
	useDesignReview = false,
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
	const hasPersistedPlanPaths = Boolean(resumeState?.builderPlanPath && resumeState?.testerPlanPath);
	const planPaths = hasPersistedPlanPaths
		? { builderPlanPath: resumeState!.builderPlanPath!, testerPlanPath: resumeState!.testerPlanPath! }
		: reservePlanPaths(cwd, request);
	// Keep the old variable as a Builder-facing compatibility alias until all
	// downstream task builders receive their role-specific paths.
	const planPath = planPaths.builderPlanPath;
	const previewDir = path.join(runDir, "design-preview");
	if (resumeState) {
		for (const outputPath of [planPaths.builderPlanPath, planPaths.testerPlanPath]) {
			if (!fs.existsSync(path.resolve(cwd, outputPath))) {
				ensureDirectory(path.dirname(path.resolve(cwd, outputPath)));
				fs.writeFileSync(path.resolve(cwd, outputPath), "", { flag: "a" });
			}
		}
	}
	const state: WorkflowState = resumeState || {
		workflowName: useDesignReview ? "dpbt" : WORKFLOW_NAME,
		workflowId,
		request,
		runId,
		planPath,
		builderPlanPath: planPaths.builderPlanPath,
		testerPlanPath: planPaths.testerPlanPath,
		interactive,
		answers: [],
		questionRounds: 0,
		handoffs: [],
		iteration: 0,
		iterationCycle: 0,
		maxIterations: Math.max(1, Math.min(20, Math.floor(maxIterations) || MAX_ITERATIONS)),
		status: "running",
		phase: "plan",
		startedAt: Date.now(),
		completedAt: null,
		activityLogPath: path.join(runDir, "activity.jsonl"),
		eventCount: 0,
		documentationRequested,
		...(useDesignReview ? { design: { previewDir, decisionPath: path.join(runDir, "design-decisions.md"), status: "drafting", revision: 0, feedback: [] } } : {}),
	};
	// A resumed state is the source of truth, but its max-iteration cap can be
	// raised by the caller when desired. Never reduce it during a resume.
	state.workflowName = state.workflowName || (useDesignReview ? "dpbt" : WORKFLOW_NAME);
	state.workflowId = state.workflowId || workflowId;
	state.builderPlanPath = planPaths.builderPlanPath;
	state.testerPlanPath = planPaths.testerPlanPath;
	state.planPath = planPaths.builderPlanPath;
	state.maxIterations = Math.max(state.maxIterations || 1, Math.max(1, Math.min(20, Math.floor(maxIterations) || MAX_ITERATIONS)));
	state.iterationCycle = state.iterationCycle || 0;
	state.documentationRequested = Boolean(state.documentationRequested || documentationRequested);
	if (resumed) {
		// A stopped run's diagnostic belongs to the previous attempt. Keep its
		// handoffs and activity log, but do not display that error as live status
		// while the resumed attempt is running (even without a budget reset).
		state.stopReason = undefined;
		state.failureReason = undefined;
		state.latestOutput = undefined;
		state.currentAgent = undefined;
		state.currentActivity = undefined;
	}
	if (resumed && resetIteration) {
		// Keep the previous cycle's handoffs for history, but start a fresh
		// iteration budget. The cycle marker prevents old iteration-1 barriers
		// from being mistaken for the new cycle's completed work. The old issue
		// ledger belongs to the old verification cycle and must not turn the new
		// cycle's initial build into a fix turn.
		state.iterationCycle++;
		state.iteration = 0;
	}
	if (useDesignReview && !state.design) state.design = { previewDir, decisionPath: path.join(runDir, "design-decisions.md"), status: "drafting", revision: 0, feedback: [] };
	state.status = "running";
	state.completedAt = null;
	state.resumeCount = (state.resumeCount || 0) + (resumed ? 1 : 0);
	state.lastResumedAt = resumed ? Date.now() : state.lastResumedAt;
	state.parentSessionPath = state.parentSessionPath || ctx.sessionManager?.getSessionFile?.() || undefined;
	const statusNow = Date.now();
	state.agentStatuses = {
		...(useDesignReview ? { designer: { status: "waiting" as const, phase: "design", activity: "waiting to start", updatedAt: statusNow } } : {}),
		planner: { status: "waiting", phase: "plan", activity: "waiting to start", updatedAt: statusNow },
		builder: { status: "waiting", phase: "build", activity: "waiting to start", updatedAt: statusNow },
		tester: { status: "waiting", phase: "test", activity: "waiting to start", updatedAt: statusNow },
		...(state.documentationRequested ? { documentation: { status: "waiting" as const, phase: "documentation", activity: "waiting for successful workflow completion", updatedAt: statusNow } } : {}),
		...(resumed ? {} : state.agentStatuses || {}),
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

	// The dynamic OpenRouter extension normally refreshes only when the model
	// selector opens. A workflow may name a newly released model directly, so
	// refresh before resolving subagent pins instead of silently falling back to
	// the durable default because the local snapshot is stale. Keep this here so
	// slash commands, workflow_start, and resume all get the same behavior.
	const missingOpenRouterModel = Object.values(models || {}).some((raw) => {
		const value = raw?.trim();
		if (!value) return false;
		const slash = value.indexOf("/");
		if (slash <= 0 || value.slice(0, slash) !== "openrouter") return false;
		const model = ctx.modelRegistry.find("openrouter", value.slice(slash + 1));
		return !model || !ctx.modelRegistry.hasConfiguredAuth(model);
	});
	if (missingOpenRouterModel) await refreshOpenRouterModels(pi);

	const subagentModels = resolveSubagentModels(ctx, models);
	const subagentEfforts = resolveSubagentEfforts(efforts);
	const modelFor = (role: SubagentRole): string | undefined => subagentModels[role];
	const effortFor = (role: SubagentRole) => subagentEfforts[role];
	const herdrTui = isHerdrTuiEnabled();
	const tui = (agentKey: string, tabLabel: string) => (herdrTui ? { runId, agentKey, tabLabel: useDesignReview ? tabLabel.replace(/^pbt/, "dpbt") : tabLabel, workflowPrefix: useDesignReview ? "dpbt" : "pbt" } : undefined);
	const modelSummary = Object.entries(subagentModels)
		.map(([role, model]) => `${role}=${model}`)
		.join(", ");
	const effortSummary = Object.entries(subagentEfforts)
		.map(([role, effort]) => `${role}=${effort}`)
		.join(", ");
	state.latestOutput = modelSummary
		? `Subagents (${herdrTui ? "Herdr TUI tabs" : "headless"}): ${modelSummary}; efforts: ${effortSummary}`
		: `Subagents: no authenticated model resolved; efforts: ${effortSummary}`;
	state.agentModels = subagentModels;
	state.agentEfforts = subagentEfforts;
	saveState(cwd, state, pi);
	let planHandoff: PhaseHandoff | undefined = hasPersistedPlanPaths
		? state.handoffs.find((handoff) => handoff.phase === "plan")
		: undefined;
	let designHandoff: PhaseHandoff | undefined = state.handoffs.find((handoff) => handoff.phase === "design");
	// A malformed authoring handoff must not become a resume barrier. Validate
	// persisted handoffs as well as fresh responses so resume can repair the
	// protocol record instead of jumping straight to verification.
	const isValidPersistedAuthoringHandoff = (handoff: PhaseHandoff): boolean => {
		try {
			validateAuthoringHandoff(handoff);
			return true;
		} catch {
			return false;
		}
	};
	let testAuthorHandoff: PhaseHandoff | undefined;
	let lastVerificationHandoff: PhaseHandoff | undefined;
	let testIssues: TestIssue[] = [];
	let testStatus: "pass" | "fail" = "fail";
	const inferIssueOwner = (issue: TestIssue): NonNullable<TestIssue["owner"]> => {
		if (issue.owner) return issue.owner;
		const evidence = [issue.description, issue.test, issue.location, issue.details, issue.actualBehavior, issue.relevantOutput].filter(Boolean).join(" ");
		// Older persisted runs predate the owner field. These signals identify
		// test-contract/configuration problems that the builder cannot fix in
		// production code (unsupported matchers and stale pre-redesign queries).
		if (/(unavailable|unsupported|invalid chai|tobeselected|removed legacy|authored.*test|test.*(?:stale|outdated)|cannot find.*(?:label|role|element))/i.test(evidence)) return "tester";
		return "builder";
	};
	let issueLedger: IssueLedgerEntry[] = (state.issueLedger || []).map((entry) => ({
		...entry,
		issue: { ...entry.issue, owner: inferIssueOwner(entry.issue) },
	}));
	let resumeIteration = state.iteration || 1;
	const currentCycle = state.iterationCycle || 0;
	if (state.handoffs.length) {
		const authors = state.handoffs.filter(
			(handoff) => handoff.phase === "test" && handoff.testStage === "authoring" && (handoff.iterationCycle || 0) === currentCycle && isValidPersistedAuthoringHandoff(handoff),
		);
		const verifications = state.handoffs.filter(
			(handoff) => handoff.phase === "test" && handoff.testStage === "verification" && (handoff.iterationCycle || 0) === currentCycle,
		);
		const historicalVerifications = state.handoffs.filter(
			(handoff) => handoff.phase === "test" && handoff.testStage === "verification",
		);
		const ledgerVerification = state.issueLedgerVerificationAt
			? historicalVerifications.find((handoff) => handoff.completedAt === state.issueLedgerVerificationAt)
			: undefined;
		testAuthorHandoff = authors.at(-1) || (state.issueLedger?.length
			? state.handoffs.filter((handoff) => handoff.phase === "test" && handoff.testStage === "authoring" && isValidPersistedAuthoringHandoff(handoff)).at(-1)
			: undefined);
		// A reset cycle may be created after a failed verification from an older
		// cycle. If a durable ledger exists, its source verification remains the
		// fix-loop context; otherwise historical verifications must not make a
		// fresh cycle skip its initial build.
		lastVerificationHandoff = verifications.at(-1) || ledgerVerification;
		testIssues = lastVerificationHandoff?.issues || state.issueLedger?.map((entry) => entry.issue) || [];
		testStatus = verifications.at(-1)?.status || "fail";
		// A failed verification is a completed iteration. Any other interrupted
		// phase must retry the persisted current iteration rather than skip it.
		resumeIteration =
			lastVerificationHandoff && lastVerificationHandoff.iteration === state.iteration
				? state.iteration + 1
				: Math.max(1, state.iteration);
	}
	if (resumed) {
		// The loop increments before dispatching. Rewind only the in-memory
		// cursor so an interrupted current iteration is retried, while a fully
		// verified iteration advances to the next one.
		state.iteration = resumeIteration - 1;
		saveState(cwd, state, pi, false);
	}

	const progress = (agentName: SubagentRole, phase: string) => ({
		agentName,
		phase,
		effort: effortFor(agentName),
		permissionContext: ctx,
		permissionWorkflow: useDesignReview ? "DPBT" : "PBT",
		activityLogPath: state.activityLogPath!,
		onProgress: (event: ProgressEvent) => {
			appendProgress(cwd, state, event);
			saveState(cwd, state, pi, false);
			updateUI(ctx, state);
		},
	});

	let lintConfig: LintConfig | undefined;
	const runLintGate = async (
		stage: "build" | "test-authoring" | "test-verification",
		iteration: number,
		repair: (diagnostics: string, repairAttempt: number) => Promise<void>,
	): Promise<void> => {
		if (!lintConfig) throw new Error("Project lint configuration was not loaded");
		for (let attempt = 1; attempt <= MAX_LINT_REPAIR_ATTEMPTS + 1; attempt++) {
			if (controller.signal.aborted) throw new Error("Workflow aborted");
			const phase = `${stage} lint`;
			state.phase = phase;
			state.status = "running";
			state.latestOutput = `Running project lint command: ${lintConfig.command}`;
			appendProgress(cwd, state, { timestamp: Date.now(), agent: "lint", phase, kind: "started", message: `Running configured lint command (attempt ${attempt})`, details: lintConfig.command });
			saveState(cwd, state, pi);
			updateUI(ctx, state);

			const result = await runLintCommand(cwd, lintConfig, controller.signal);
			const lintRun: LintRun = { ...result, stage, iteration, attempt, completedAt: Date.now(), iterationCycle: currentCycle };
			state.lintRuns = [...(state.lintRuns || []), lintRun];
			appendProgress(cwd, state, {
				timestamp: lintRun.completedAt,
				agent: "lint",
				phase,
				kind: result.exitCode === 0 ? "completed" : "failed",
				message: result.exitCode === 0 ? "Project lint passed" : `Project lint failed with exit code ${result.exitCode}`,
				details: result.exitCode === 0 ? result.command : renderLintFailure(result).slice(0, 2_000),
			});
			saveState(cwd, state, pi);
			updateUI(ctx, state, result.exitCode === 0 ? "Project lint passed" : renderLintFailure(result));
			if (result.exitCode === 0) return;

			const diagnostics = renderLintFailure(result);
			if (attempt > MAX_LINT_REPAIR_ATTEMPTS) {
				throw new Error(`Project lint still fails after ${MAX_LINT_REPAIR_ATTEMPTS} repair attempt(s); workflow cannot advance.\n${diagnostics}`);
			}
			state.phase = `${stage} lint repair`;
			state.latestOutput = `Sending lint failure to the ${stage === "build" ? "builder" : "tester"} in its persistent session`;
			saveState(cwd, state, pi);
			updateUI(ctx, state, diagnostics);
			await repair(diagnostics, attempt);
		}
	};

	const authorTests = async (task: string, activity: string): Promise<{ result: AgentResult; handoff: PhaseHandoff }> => {
		const run = async (authoringTask: string) => runSubagent({
			cwd,
			agentPath: projectAgentPath(cwd, "tester.md"),
			model: modelFor("tester"),
			task: authoringTask,
			// Keep bash available when the persistent tester process is first
			// started. Authoring is still prohibited from using it by the task
			// prompt, but the same process must later be able to verify suites.
			tools: ["edit", "write", "read", "grep", "find", "ls", "bash"],
			sessionPath: path.join(runDir, "test.jsonl"),
			signal: controller.signal,
			tui: tui("tester", "pbt test"),
			onOutput: (output) => updateUI(ctx, state, output),
			...progress("tester", activity),
		});

		let result = await run(task);
		try {
			const handoff = requireHandoff(result, "test", state.iteration);
			handoff.testStage = "authoring";
			handoff.iterationCycle = currentCycle;
			validateAuthoringHandoff(handoff);
			return { result, handoff };
		} catch (firstError) {
			const reason = firstError instanceof Error ? firstError.message : String(firstError);
			result = await run([
				"RECOVERY: The previous authoring response was rejected by the workflow protocol. Continue from the files and context already present in this persistent tester session; do not restate the original request, plan, or authoring task.",
				reason,
				"The test files may already have been authored. Do not run tests and do not modify production code.",
				"Inspect the test files you authored or modified, then output a corrected JSON handoff.",
				"It MUST declare testStage=authoring, include testStrategy, and list every authored/modified test file in artifacts.",
				"Use action=created for new files or action=modified for existing files (never action=updated).",
			].join("\n"));
			const handoff = requireHandoff(result, "test", state.iteration);
			handoff.testStage = "authoring";
			handoff.iterationCycle = currentCycle;
			validateAuthoringHandoff(handoff);
			return { result, handoff };
		}
	};

	const verificationHandoffFor = async (result: AgentResult, iteration: number): Promise<PhaseHandoff> => {
		try {
			const handoff = requireHandoff(result, "test", iteration);
			handoff.testStage = "verification";
			handoff.iterationCycle = currentCycle;
			validateVerificationHandoff(handoff);
			return handoff;
		} catch (verificationError) {
			const recovered = await readLatestAssistantText(path.join(runDir, "test.jsonl"));
			const reparsed = recovered ? parseHandoff(recovered, "test", iteration) : undefined;
			if (reparsed) {
				reparsed.testStage = "verification";
				reparsed.iterationCycle = currentCycle;
				try {
					validateVerificationHandoff(reparsed);
					return reparsed;
				} catch {
					// Fall through to the original protocol error.
				}
			}
			throw verificationError;
		}
	};

	try {
		lintConfig = readLintConfig(cwd);
		state.lintCommand = lintConfig.command;
		saveState(cwd, state, pi);

		// DPBT interactive mode is intentionally scoped to the design phase. The
		// approved design gives the planner a concrete specification, so DPBT
		// never starts planner clarification rounds even when this mode is on.
		const designInteractive = useDesignReview && interactive;
		const planInteractive = interactive && !useDesignReview;

		// DPBT design loop. The static preview is isolated under this run; user
		// feedback and approval are durable files written by its own review UI.
		if (useDesignReview && state.design && !state.design.approvedAt) {
			initializeDesignReview(state.design.previewDir);
			while (!state.design.approvedAt) {
				if (controller.signal.aborted) throw new Error("Workflow aborted");
				const feedback = readDesignFeedback(state.design.previewDir);
				state.design.feedback = feedback;
				const consumed = new Set(state.design.consumedFeedbackIds || []);
				const newFeedback = feedback.filter((entry) => !consumed.has(entry.id));
				// Feedback remains editable/reviewable in the preview until the user
				// explicitly asks for changes. Do not start a revision merely because
				// one comment was saved.
				const shouldDraft = !designHandoff || readReviewAction(state.design.previewDir) === "request-changes";
				if (shouldDraft) {
					state.phase = state.design.revision ? "design revision" : "design mockup";
					state.design.status = state.design.revision ? "revising" : "drafting";
					state.status = "running";
					saveState(cwd, state, pi);
					const task = buildDesignTask(request, state.design.previewDir, state.answers, Boolean(designInteractive), state.design.revision, newFeedback.length ? JSON.stringify(newFeedback) : undefined);
					const result = await runSubagent({ cwd, agentPath: projectAgentPath(cwd, "designer.md"), model: modelFor("designer"), task, tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "design.jsonl"), signal: controller.signal, tui: tui("designer", "dpbt design"), onOutput: (output) => updateUI(ctx, state, output), ...progress("designer", `design-${state.design.revision + 1}`) });
					const clarification = parseClarificationRequest(result.output, "design");
					if (designInteractive && state.design.revision === 0 && state.answers.length === 0 && !clarification) {
						throw new Error("Interactive design discovery must ask clarification questions before creating the mockup");
					}
					if (clarification) {
						if (!designInteractive) throw new Error("Simple designer returned a clarification request");
						state.status = "awaiting-clarification";
						state.questionRounds++;
						saveState(cwd, state, pi);
						updateUI(ctx, state);
						const answers = await askClarifications(ctx, clarification.questions, state.questionRounds);
						state.answers.push(...answers);
						state.status = "running";
						saveState(cwd, state, pi);
						continue;
					}
					const completedDesignHandoff = requireHandoff(result, "design", state.design.revision + 1);
					designHandoff = completedDesignHandoff;
					attachDesignReviewAssets(state.design.previewDir);
					state.design.revision++;
					state.design.designHandoff = completedDesignHandoff;
					state.design.consumedFeedbackIds = feedback.map((entry) => entry.id);
					state.handoffs.push(completedDesignHandoff);
					resetReviewRequest(state.design.previewDir);
					state.design.previewUrl = await ensureDesignPreviewServer(state.design.previewDir);
					state.design.status = "awaiting-review";
					state.phase = "design review";
					state.status = "awaiting-design-review";
					saveState(cwd, state, pi);
					updateUI(ctx, state, `Design preview ready: ${state.design.previewUrl}`);
					if (!state.design.previewOpenedAt) {
						if (openDesignPreview(state.design.previewUrl)) state.design.previewOpenedAt = Date.now();
						saveState(cwd, state, pi);
					}
					if (ctx.hasUI) ctx.ui.notify(`Review the mockup and approve it: ${state.design.previewUrl}`, "info");
				}
				while (!controller.signal.aborted) {
					const approval = readApproval(state.design.previewDir);
					if (approval) { state.design.approvedAt = approval; break; }
					if (readReviewAction(state.design.previewDir) === "request-changes") break;
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				if (controller.signal.aborted) throw new Error("Workflow aborted");
				if (!state.design.approvedAt) continue;
				state.design.status = "approved";
				state.status = "running";
				state.phase = "plan";
				fs.writeFileSync(state.design.decisionPath, ["# Approved design decisions", "", `- Preview: ${state.design.previewUrl || state.design.previewDir}`, `- Approved: ${new Date(state.design.approvedAt).toISOString()}`, "", "## Design handoff", designHandoff?.summary || "", "", "## Decisions", ...(designHandoff?.decisions || []).map((item) => `- **${item.decision}** — ${item.rationale}`), "", "## Design clarification answers", ...(state.answers.length ? state.answers.map((answer) => `- **${answer.questionId}**: ${answer.answer}${answer.unresolved ? " *(unresolved assumption)*" : ""}`) : ["- None"]), "", "## User feedback", ...feedback.map((item) => `- ${item.elements?.length ? `**${item.elements.join(", ")}**: ` : ""}${item.comment}`)].join("\n"));
				if (designHandoff && !designHandoff.artifacts.some((item) => item.path === state.design!.decisionPath)) designHandoff.artifacts.push({ path: state.design.decisionPath, description: "Approved design decisions for implementation agents", action: "created" });
				saveState(cwd, state, pi);
			}
		}

		// Plan. Simple planning is deliberately ephemeral; interactive planning
		// reuses planner.jsonl for every clarification round. On resume, the
		// persisted plan handoff is sufficient and the planner is not rerun.
		if (!planHandoff) {
		const plannerPath = projectAgentPath(cwd, planInteractive ? "planner-interactive.md" : "planner-simple.md");
		let plannerTask = buildPlanTask(request, planPaths, planInteractive ? state.answers : [], planInteractive);
		while (true) {
			if (controller.signal.aborted) throw new Error("Workflow aborted");
			state.phase = "plan";
			state.status = "running";
			saveState(cwd, state, pi);
			const plannerResult = await runSubagent({
				cwd,
				agentPath: plannerPath,
				model: modelFor("planner"),
				task: `${plannerTask}${state.design?.approvedAt ? `\n\nApproved design reference (must be honored): ${state.design.decisionPath}\nIsolated review preview: ${state.design.previewDir}` : ""}`,
				tools: ["read", "grep", "find", "ls", "bash", "write"],
				sessionPath: path.join(runDir, "planner.jsonl"),
				signal: controller.signal,
				tui: tui("planner", "pbt plan"),
				onOutput: (output) => updateUI(ctx, state, output),
				...progress("planner", "plan"),
			});
			const clarification = parseClarificationRequest(plannerResult.output, "plan");
			if (clarification) {
				if (!planInteractive) throw new Error("Simple planner returned a clarification request");
				state.status = "awaiting-clarification";
				state.questionRounds++;
				saveState(cwd, state, pi);
				updateUI(ctx, state);
				const answers = await askClarifications(ctx, clarification.questions, state.questionRounds);
				state.answers.push(...answers);
				plannerTask = buildPlanTask(request, planPaths, state.answers, planInteractive);
				state.status = "running";
				saveState(cwd, state, pi);
				continue;
			}
			planHandoff = requireHandoff(plannerResult, "plan", 1);
			try {
				validatePlanHandoff(planHandoff, planPaths);
				assertPlanOutputsExist(cwd, planPaths);
			} catch (validationError) {
				const reason = validationError instanceof Error ? validationError.message : String(validationError);
				state.phase = "plan recovery";
				state.latestOutput = `Planner output requires correction: ${reason}`;
				saveState(cwd, state, pi);
				updateUI(ctx, state, state.latestOutput);
				plannerTask = buildPlanRecoveryTask(planPaths, reason);
				continue;
			}
			planHandoff.planPath = planPaths.builderPlanPath;
			planHandoff.builderPlanPath = planPaths.builderPlanPath;
			planHandoff.testerPlanPath = planPaths.testerPlanPath;
			planHandoff.iteration = 1;
			planHandoff.iterationCycle = state.iterationCycle || 0;
			state.handoffs.push(planHandoff);
			saveState(cwd, state, pi);
			updateUI(ctx, state, plannerResult.output);
			break;
		}
		}

		// Build and test authoring start together on iteration one. Promise.all
		// is intentionally awaited before verification starts: test execution has
		// a hard builder-complete barrier.
		while (testStatus === "fail" && state.iteration < state.maxIterations) {
			state.iteration++;
			state.phase = state.iteration === 1 && !lastVerificationHandoff ? "build + test authoring" : "build fixes";
			state.status = "running";
			saveState(cwd, state, pi);
			if (!planHandoff) throw new Error("Workflow has no plan handoff before starting build phase");

			const isInitialBuild = state.iteration === 1 && !lastVerificationHandoff;
			const existingBuildHandoff = state.handoffs.filter(
				(handoff) => handoff.phase === "build" && handoff.iteration === state.iteration && (handoff.iterationCycle || 0) === currentCycle,
			).at(-1);
			const existingAuthorHandoff = state.handoffs.filter(
				(handoff) => handoff.phase === "test" && handoff.testStage === "authoring" && handoff.iteration === state.iteration && (handoff.iterationCycle || 0) === currentCycle && isValidPersistedAuthoringHandoff(handoff),
			).at(-1);
			if (existingAuthorHandoff) testAuthorHandoff = existingAuthorHandoff;
			let buildHandoff: PhaseHandoff;

			if (isInitialBuild) {
					const designContext = state.design?.approvedAt ? `\n\nApproved design reference: ${state.design.decisionPath}\nReference the isolated preview at ${state.design.previewDir}; implement its approved behavior and decisions in the app, not its review panel.` : "";
				const buildTask = buildInitialBuildTask(request, planPaths.builderPlanPath, planHandoff, state.iteration) + designContext;
				let buildResult: AgentResult | undefined;
				if (existingBuildHandoff) {
					buildResult = { exitCode: 0, output: JSON.stringify(existingBuildHandoff), stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
				}
				if (!existingBuildHandoff && !existingAuthorHandoff) {
					const authorTask = buildTestAuthoringTask(request, planPaths.testerPlanPath, planHandoff, state.iteration, false) + (state.design?.approvedAt ? `\n\nApproved design reference: ${state.design.decisionPath}\nTest the approved user-facing behavior; the preview itself is not application code.` : "");
					const parallelResults = await Promise.allSettled([
						runSubagent({
							cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
							task: buildTask, tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
							sessionPath: path.join(runDir, "build.jsonl"), signal: controller.signal, tui: tui("builder", "pbt build"),
							onOutput: (output) => updateUI(ctx, state, output), ...progress("builder", `build-${state.iteration}`),
						}),
						authorTests(authorTask, `test-authoring-${state.iteration}`),
					]);
					const buildOutcome = parallelResults[0];
					const authorOutcome = parallelResults[1];
					if (buildOutcome.status === "rejected") throw new Error(`Builder parallel subagent failed at iteration ${state.iteration}: ${buildOutcome.reason}`);
					if (authorOutcome.status === "rejected") throw new Error(`Tester authoring parallel subagent failed at iteration ${state.iteration}: ${authorOutcome.reason}`);
					buildResult = buildOutcome.value;
					const authored = authorOutcome.value;
					testAuthorHandoff = authored.handoff;
					state.handoffs.push(testAuthorHandoff);
					saveState(cwd, state, pi);
					updateUI(ctx, state, authored.result.output);
				} else if (!existingBuildHandoff) {
					buildResult = await runSubagent({
						cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
						task: buildTask, tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
						sessionPath: path.join(runDir, "build.jsonl"), signal: controller.signal, tui: tui("builder", "pbt build"),
						onOutput: (output) => updateUI(ctx, state, output), ...progress("builder", `build-${state.iteration}`),
					});
				}
				if (!buildResult) throw new Error(`Builder did not produce a result at iteration ${state.iteration}`);
				buildHandoff = existingBuildHandoff || requireHandoff(buildResult, "build", state.iteration);
				if (!existingBuildHandoff) state.handoffs.push(buildHandoff);
				if (!testAuthorHandoff || testAuthorHandoff.iteration !== state.iteration) {
					const authored = await authorTests(buildTestAuthoringTask(request, planPaths.testerPlanPath, planHandoff, state.iteration, true) + (state.design?.approvedAt ? `\n\nApproved design reference: ${state.design.decisionPath}` : ""), `test-authoring-${state.iteration}`);
					testAuthorHandoff = authored.handoff;
					state.handoffs.push(authored.handoff);
					saveState(cwd, state, pi);
				}
			} else {
				// Every failed verification creates a durable ledger. Fix one entry per
				// builder turn; a retest is forbidden until every entry is fixed.
				const verificationAt = lastVerificationHandoff?.completedAt;
				if (!issueLedger.length || state.issueLedgerVerificationAt !== verificationAt) {
					issueLedger = testIssues.map((rawIssue) => {
						const issue = { ...rawIssue, owner: inferIssueOwner(rawIssue) };
						return { issue, status: "pending", attempts: 0, updatedAt: Date.now() };
					});
					state.issueLedger = issueLedger;
					state.issueLedgerVerificationAt = verificationAt;
					saveState(cwd, state, pi);
				}
				const completedHandoff = existingBuildHandoff?.buildStage === "completed"
					? existingBuildHandoff
					: state.handoffs.slice().reverse().find(
						(handoff) => handoff.phase === "build" && handoff.buildStage === "completed" && (handoff.iterationCycle || 0) === currentCycle,
					);
				const remainingBuilderIssues = issueLedger.filter((entry) => entry.status !== "fixed" && entry.issue.owner !== "environment");
				if (completedHandoff && remainingBuilderIssues.length === 0) {
					// Environment issues are the only issues that may bypass the
					// Builder. All other issues are processed one at a time before
					// retesting; owner metadata remains diagnostic only.
					buildHandoff = completedHandoff;
				} else {
					// Dispatch exactly one issue per builder/test-maintenance turn. The
					// loop deliberately waits for and validates that handoff before it
					// selects the next ledger entry, keeping unrelated failures out of
					// the active agent prompt.
					while (true) {
						const entry = issueLedger.find((candidate) => candidate.status !== "fixed" && candidate.issue.owner !== "environment");
						if (!entry) break;
						entry.status = "in-progress";
						entry.attempts++;
						entry.updatedAt = Date.now();
						state.issueLedger = issueLedger;
						saveState(cwd, state, pi);
						// Every actionable issue found by the tester is sent to the Builder
						// one at a time. Ownership is diagnostic metadata, not a second
						// prompt route; this keeps the fix barrier deterministic.
						let fixResult = await runSubagent({
							cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
							task: buildIssueFixTask(entry.issue, state.iteration),
							tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"),
							signal: controller.signal, tui: tui("builder", "pbt build"), onOutput: (output) => updateUI(ctx, state, output),
							...progress("builder", `build-${state.iteration}-${entry.issue.id}`),
						});
						let fixHandoff = requireHandoff(fixResult, "build", state.iteration);
						fixHandoff.buildStage = "issue-fix";
						fixHandoff.iterationCycle = currentCycle;
						if (fixHandoff.issueUpdates?.length !== 1) throw new Error(`Builder must report exactly one issueUpdate for ${entry.issue.id}`);
						let update = fixHandoff.issueUpdates?.[0];
						if (!update || update.issueId !== entry.issue.id) throw new Error(`Builder reported ${update?.issueId || "no issue"} while fixing ${entry.issue.id}`);
						const lintCheckIssueTurn = async (): Promise<void> => {
							await runLintGate("build", state.iteration, async (diagnostics) => {
								fixResult = await runSubagent({
									cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
									task: buildLintRepairTask(diagnostics, state.iteration, entry.issue),
									tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"),
									signal: controller.signal, tui: tui("builder", "pbt build"), onOutput: (output) => updateUI(ctx, state, output),
									...progress("builder", `build-${state.iteration}-${entry.issue.id}-lint-repair`),
								});
								const lintFixHandoff = requireHandoff(fixResult, "build", state.iteration);
								lintFixHandoff.buildStage = "issue-fix";
								lintFixHandoff.iterationCycle = currentCycle;
								if (lintFixHandoff.issueUpdates?.length !== 1 || lintFixHandoff.issueUpdates[0].issueId !== entry.issue.id) {
									throw new Error(`Builder lint repair must report exactly one issueUpdate for ${entry.issue.id}`);
								}
								update = lintFixHandoff.issueUpdates[0];
								fixHandoff = {
									...lintFixHandoff,
									artifacts: [...new Map([...fixHandoff.artifacts, ...lintFixHandoff.artifacts].map((artifact) => [artifact.path, artifact])).values()],
									decisions: [...fixHandoff.decisions, ...lintFixHandoff.decisions],
									issueUpdates: [update],
								};
							});
						};
						await lintCheckIssueTurn();
						if (update.status === "unresolved") {
							// Give the same persistent Builder one focused continuation before
							// failing, and run the lint gate after that turn too.
							fixResult = await runSubagent({
								cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
								task: buildIssueFixRetryTask(entry.issue, state.iteration),
								tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"),
								signal: controller.signal, tui: tui("builder", "pbt build"), onOutput: (output) => updateUI(ctx, state, output),
								...progress("builder", `build-${state.iteration}-${entry.issue.id}-retry`),
							});
							fixHandoff = requireHandoff(fixResult, "build", state.iteration);
							fixHandoff.buildStage = "issue-fix";
							fixHandoff.iterationCycle = currentCycle;
							if (fixHandoff.issueUpdates?.length !== 1) throw new Error(`Builder must report exactly one issueUpdate for ${entry.issue.id}`);
							update = fixHandoff.issueUpdates?.[0];
							if (!update || update.issueId !== entry.issue.id) throw new Error(`Builder reported ${update?.issueId || "no issue"} while retrying ${entry.issue.id}`);
							await lintCheckIssueTurn();
						}
						entry.status = update.status === "fixed" ? "fixed" : "unresolved";
						entry.lastAction = update.summary;
						entry.updatedAt = Date.now();
						state.handoffs.push(fixHandoff);
						if (entry.status === "unresolved") {
							state.issueLedger = issueLedger;
							saveState(cwd, state, pi);
							throw new Error(`Builder left issue ${entry.issue.id} unresolved; resume to retry the remaining issue ledger`);
						}
						state.issueLedger = issueLedger;
						saveState(cwd, state, pi);
						updateUI(ctx, state, fixResult.output);
					}
					const remaining = issueLedger.filter((entry) => entry.status !== "fixed" && entry.issue.owner !== "environment");
					if (remaining.length > 0) throw new Error("Issue ledger still contains unresolved non-environment issues; cannot complete handoff");
					const completionResult = await runSubagent({
						cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
						task: buildCompletionTask(issueLedger, state.iteration),
						tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"),
						signal: controller.signal, tui: tui("builder", "pbt build"), onOutput: (output) => updateUI(ctx, state, output),
						...progress("builder", `build-${state.iteration}-completed`),
					});
					buildHandoff = requireHandoff(completionResult, "build", state.iteration);
					if (buildHandoff.buildStage !== "completed") throw new Error("Builder completed handoff must declare buildStage=completed");
					const completedIssueIds = new Set((buildHandoff.issueUpdates || []).filter((update) => update.status === "fixed").map((update) => update.issueId));
					if (issueLedger.some((entry) => entry.issue.owner !== "environment" && !completedIssueIds.has(entry.issue.id))) throw new Error("Builder completed handoff did not mark every non-environment ledger issue fixed");
					buildHandoff.iterationCycle = currentCycle;
					state.handoffs.push(buildHandoff);
					saveState(cwd, state, pi);
					updateUI(ctx, state, completionResult.output);
				}
			}
			await runLintGate("build", state.iteration, async (diagnostics) => {
				const lintFixResult = await runSubagent({
					cwd, agentPath: projectAgentPath(cwd, "builder.md"), model: modelFor("builder"),
					task: buildLintRepairTask(diagnostics, state.iteration),
					tools: ["edit", "write", "read", "bash", "grep", "find", "ls"], sessionPath: path.join(runDir, "build.jsonl"),
					signal: controller.signal, tui: tui("builder", "pbt build"), onOutput: (output) => updateUI(ctx, state, output),
					...progress("builder", `build-${state.iteration}-lint-repair`),
				});
				const lintFixHandoff = requireHandoff(lintFixResult, "build", state.iteration);
				lintFixHandoff.iterationCycle = currentCycle;
				state.handoffs.push(lintFixHandoff);
				buildHandoff = {
					...buildHandoff,
					summary: `${buildHandoff.summary}\nLint repair: ${lintFixHandoff.summary}`,
					artifacts: [...new Map([...buildHandoff.artifacts, ...lintFixHandoff.artifacts].map((artifact) => [artifact.path, artifact])).values()],
					decisions: [...buildHandoff.decisions, ...lintFixHandoff.decisions],
				};
				saveState(cwd, state, pi);
			});

			if (!testAuthorHandoff) throw new Error(`Tester authoring handoff is missing before verification at iteration ${state.iteration}`);
			if (testAuthorHandoff.iteration === state.iteration) await runLintGate("test-authoring", state.iteration, async (diagnostics) => {
				const lintFixResult = await runSubagent({
					cwd, agentPath: projectAgentPath(cwd, "tester.md"), model: modelFor("tester"),
					task: buildTestAuthoringLintRepairTask(diagnostics),
					tools: ["edit", "write", "read", "grep", "find", "ls", "bash"], sessionPath: path.join(runDir, "test.jsonl"),
					signal: controller.signal, tui: tui("tester", "pbt test"), onOutput: (output) => updateUI(ctx, state, output),
					...progress("tester", `test-authoring-${state.iteration}-lint-repair`),
				});
				const lintFixHandoff = requireHandoff(lintFixResult, "test", state.iteration);
				lintFixHandoff.testStage = "authoring";
				lintFixHandoff.iterationCycle = currentCycle;
				validateAuthoringHandoff(lintFixHandoff);
				state.handoffs.push(lintFixHandoff);
				testAuthorHandoff = {
					...lintFixHandoff,
					testStrategy: lintFixHandoff.testStrategy || testAuthorHandoff!.testStrategy,
					artifacts: [...new Map([...testAuthorHandoff!.artifacts, ...lintFixHandoff.artifacts].map((artifact) => [artifact.path, artifact])).values()],
				};
				saveState(cwd, state, pi);
			});
			saveState(cwd, state, pi);
			state.phase = "test verification";
			const testResult = await runSubagent({
				cwd,
				agentPath: projectAgentPath(cwd, "tester.md"),
				model: modelFor("tester"),
				task: buildTestVerificationTask(
					request,
					planPaths.testerPlanPath,
					buildHandoff,
					testAuthorHandoff,
					state.iteration,
					testIssues,
					lastVerificationHandoff,
				) + (state.design?.approvedAt ? `\n\nApproved design reference: ${state.design.decisionPath}\nVerify the built feature against these user-approved decisions.` : ""),
				tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
				sessionPath: path.join(runDir, "test.jsonl"),
				signal: controller.signal,
				// Verification uses a distinct stable Herdr agent identity so an
				// existing tester tab created during authoring without bash cannot
				// silently retain the old restricted tool set. It still reuses the
				// same persistent test.jsonl session.
				tui: tui("tester-verification", "pbt test"),
				onOutput: (output) => updateUI(ctx, state, output),
				...progress("tester", `test-verification-${state.iteration}`),
			});
			let verificationHandoff = await verificationHandoffFor(testResult, state.iteration);
			await runLintGate("test-verification", state.iteration, async (diagnostics) => {
				const lintFixResult = await runSubagent({
					cwd,
					agentPath: projectAgentPath(cwd, "tester.md"),
					model: modelFor("tester"),
					task: buildTestVerificationLintRepairTask(diagnostics, verificationHandoff),
					tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
					sessionPath: path.join(runDir, "test.jsonl"),
					signal: controller.signal,
					tui: tui("tester-verification", "pbt test"),
					onOutput: (output) => updateUI(ctx, state, output),
					...progress("tester", `test-verification-${state.iteration}-lint-repair`),
				});
				verificationHandoff = await verificationHandoffFor(lintFixResult, state.iteration);
			});
			state.handoffs.push(verificationHandoff);
			saveState(cwd, state, pi);
			updateUI(ctx, state, verificationHandoff.summary || testResult.output);
			testStatus = verificationHandoff.status || "fail";
			testIssues = verificationHandoff.issues || [];
			lastVerificationHandoff = verificationHandoff;
			if (testStatus === "pass") {
				state.issueLedger = undefined;
				state.issueLedgerVerificationAt = undefined;
			}

			if (testStatus === "pass") break;
			if (state.iteration >= state.maxIterations) {
				state.stopReason = "max-iterations";
				break;
			}
			if (detectPlateau(state)) {
				state.stopReason = "plateau";
				break;
			}
		}

		if (testStatus !== "pass" && state.stopReason !== "plateau" && state.stopReason !== "max-iterations") {
			state.stopReason = "max-iterations";
		}
		if (testStatus === "pass" && state.documentationRequested) {
			state.status = "running";
			await runDocumentationPhase(pi, ctx, state, models, controller.signal, efforts);
		}
		state.status =
			testStatus === "pass"
				? "completed"
				: state.stopReason === "plateau"
					? "plateau-reached"
					: "max-iterations-reached";
		state.completedAt = Date.now();
		saveState(cwd, state, pi);
		finishReport(pi, ctx, state);
		return state;
	} catch (error) {
		const aborted = controller.signal.aborted || /aborted/i.test(error instanceof Error ? error.message : String(error));
		state.status = aborted ? "aborted" : "failed";
		state.stopReason = aborted ? "aborted" : "error";
		const phaseCtx = `phase=${state.phase || "unknown"}, iteration=${state.iteration}`;
		state.failureReason = `${phaseCtx}: ${error instanceof Error ? error.message : String(error)}`;
		state.completedAt = Date.now();
		saveState(cwd, state, pi);
		finishReport(pi, ctx, state);
		return state;
	} finally {
		if (externalSignal) externalSignal.removeEventListener("abort", relayAbort);
		activeRuns.delete(runId);
		// Keep completed plans, but make failed empty reservations available again
		// so a later run does not permanently consume a feature-name pair.
		for (const outputPath of [planPaths.builderPlanPath, planPaths.testerPlanPath]) {
			try {
				if (fs.existsSync(path.resolve(cwd, outputPath)) && fs.statSync(path.resolve(cwd, outputPath)).size === 0) {
					fs.unlinkSync(path.resolve(cwd, outputPath));
				}
			} catch {
				// Best-effort cleanup only.
			}
		}
		releasePlanReservations(cwd, planPaths);
	}
}
