/**
 * Compact, phase-specific task prompts.
 *
 * Persistent agents already retain the request, plan, and previous turns. New
 * prompts therefore carry only the delta needed for the current transition.
 */

import { renderAuthoringContext, renderBuilderBarrier, renderIssue, renderPlanContext } from "./handoffs.js";
import type { IssueLedgerEntry, PhaseHandoff, PlanPaths, TestIssue, WorkflowAnswer } from "./types.js";

const handoffRule = "End with one fenced JSON handoff matching the required phase schema.";

export function buildDesignTask(request: string, previewDir: string, answers: WorkflowAnswer[], interactive: boolean, revision: number, feedback?: string): string {
	const latestRound = answers.length ? Math.max(...answers.map((answer) => answer.round)) : 0;
	const latestAnswers = answers
		.filter((answer) => answer.round === latestRound)
		.map((answer) => `${answer.questionId}: ${answer.answer}${answer.unresolved ? " [unresolved assumption]" : ""}`)
		.join("\n");
	return [
		revision > 0 ? "Revise the isolated design preview from the user feedback submitted for this review round." : "Create an isolated, reviewable static UI mockup for this request.",
		`Request: ${request}`,
		`Preview directory: ${previewDir}`,
		...(feedback ? [`Feedback to implement now: ${feedback}`] : []),
		...(latestAnswers ? [`New answers from design clarification round ${latestRound}:\n${latestAnswers}`, "Apply these answers to the design."] : []),
		"Update only preview files and end with the design handoff.",
		interactive && revision === 0 && answers.length === 0
			? "This is the required design discovery turn. Explore the repository, then output ONLY a design clarification_request with at least one focused product/UX question. Do not create or modify the mockup yet."
			: interactive
				? "Apply the provided design answers. If a new material product/design ambiguity remains after repository exploration, output only the design clarification_request JSON protocol; otherwise create or revise the preview and output the final design handoff."
				: "Do not ask questions. Infer repository-answerable design details and record unresolved choices as design decisions, then create or revise the preview and output the final design handoff.",
	].join("\n\n");
}

export function buildDocumentationTask(request: string, handoffs: PhaseHandoff[], manual = false): string {
	const workflowContext = handoffs.length
		? JSON.stringify(handoffs.map((handoff) => ({
			phase: handoff.phase,
			iteration: handoff.iteration,
			summary: handoff.summary,
			artifacts: handoff.artifacts,
			decisions: handoff.decisions,
			assumptions: handoff.assumptions,
		})), null, 2)
		: "No workflow handoffs are available; derive the documentation from the current repository.";
	return [
		manual
			? "Perform a documentation maintenance pass for the project in the current working directory. Work directly and visibly in this session; do not delegate it to a background process or subagent."
			: "Document the completed workflow change and maintain the project documentation.",
		"This task is about the current project's documentation, not Pi or its coding-agent harness. Do not look up, read, summarize, or modify Pi CLI/SDK/extension/skill documentation, including files under /usr/lib/node_modules, unless those files are part of the current project.",
		`Workflow request: ${request}`,
		"Documentation root: docs/ in the current project (create it if it does not exist).",
		"Start by inspecting the current project repository and its existing docs/ directory. Update only docs/ in the current project; do not modify application code, tests, configuration, or the root README.",
		"Keep docs/ an intentional, concise reader-facing map of the product—not an exhaustive code encyclopedia. Remove obsolete, duplicate, empty, generated, or unnecessarily fragmented Markdown files inside docs/ when their information is no longer useful.",
		"Ensure docs/README.md is the clear entry point and links to a small, navigable structure. Organize important material under focused Markdown files such as features/, technical/, and decisions/ when applicable. Cover the product overview, significant user-facing features and behavior, material business/product/technical decisions with their rationale, architecture and integrations, and how to navigate the project. Keep individual documents focused; split only when a topic would become unwieldy. Use relative links and keep indexes current.",
		"Do not invent facts. Prefer repository evidence and the workflow context below; call out meaningful unknowns or assumptions instead of asserting them as facts.",
		`Workflow context:\n${workflowContext}`,
		"Return a documentation handoff listing every docs artifact created, modified, or deleted and the key documentation decisions.",
		handoffRule,
	].join("\n\n");
}

export function buildPlanTask(request: string, paths: PlanPaths, answers: WorkflowAnswer[], interactive: boolean): string {
	if (interactive && answers.length > 0) {
		const latestRound = Math.max(...answers.map((answer) => answer.round));
		const latestAnswers = answers
			.filter((answer) => answer.round === latestRound)
			.map((answer) => `${answer.questionId}: ${answer.answer}${answer.unresolved ? " [unresolved assumption]" : ""}`)
			.join("\n");
		return [
			"Continue planning in the existing persistent planner session; prior request, repository findings, paired plan paths, and clarification context are retained.",
			`New answers from clarification round ${latestRound}:\n${latestAnswers}`,
			"Apply these answers. If a material ambiguity remains, output only a clarification_request JSON object; otherwise write both plans and output the final plan handoff.",
		].join("\n\n");
	}
	const answerText = answers.length
		? answers.map((answer) => `${answer.questionId}: ${answer.answer}${answer.unresolved ? " [unresolved assumption]" : ""}`).join("\n")
		: "(none)";
	return [
		`Plan this request: ${request}`,
		`Create only these exact reserved plan files: Builder implementation instructions at ${paths.builderPlanPath}; Tester test cases and scenarios at ${paths.testerPlanPath}. Variant: ${interactive ? "interactive" : "simple"}.`,
		"Explore the repository first. Do not modify production code or tests.",
		"The builder plan must contain ordered implementation guidance, constraints, and acceptance criteria. The tester plan must contain stable scenario IDs, test cases, commands, coverage expectations, and pass conditions.",
		`Prior clarification answers:\n${answerText}`,
		interactive
			? "If a material ambiguity remains, output only the clarification_request JSON protocol; otherwise write both plans and output the final handoff with builderPlanPath and testerPlanPath."
			: "Do not ask questions. Infer repository-answerable details and record unresolved choices as assumptions, then write both plans and output the final handoff with builderPlanPath and testerPlanPath.",
	].join("\n\n");
}

export function buildPlanRecoveryTask(paths: PlanPaths, validationError: string): string {
	return [
		"RECOVERY: The previous plan handoff or artifacts failed the orchestrator's required validation.",
		`Validation failure: ${validationError}`,
		`Create or correct only the exact Builder plan ${paths.builderPlanPath} and Tester plan ${paths.testerPlanPath}.`,
		"Do not modify production code or tests. Return a complete replacement plan handoff with both exact path fields and both created artifacts.",
	].join("\n\n");
}

/**
 * The focused `/b` workflow deliberately skips planning and testing. It uses
 * the normal persistent Builder and handoff contract, then lets the
 * orchestrator run every required project quality command programmatically.
 */
export function buildJustBuildTask(request: string): string {
	return [
		`Implement this focused request: ${request}`,
		"This is the just-build workflow: inspect the repository and implement the request directly. There is no plan artifact, tester, or test-verification phase.",
		"Do not create, modify, or delete tests, and do not run tests. Track every production artifact and key implementation decision.",
		"After your handoff, the orchestrator will run every required project quality command directly. If any fail, you will receive their exact machine-captured diagnostics in this same persistent Builder session.",
		handoffRule,
	].join("\n\n");
}

/** Repair a `/b` quality-gate failure in the same persistent Builder session. */
export function buildJustBuildLintRepairTask(diagnostics: string, attempt: number): string {
	return [
		`Fix the required project quality-command failure from just-build repair turn ${attempt}.`,
		`Quality command output (authoritative diagnostics):\n${diagnostics}`,
		"Continue in this same Builder session. Correct only the reported quality findings, preserve runtime behavior, and do not weaken, skip, or delete tests.",
		"Do not run quality commands or tests yourself; the orchestrator reruns every required quality command after this handoff and cannot complete until all pass.",
		handoffRule,
	].join("\n\n");
}

/** Initial implementation: includes the plan delta and no issue-only rules. */
export function buildInitialBuildTask(request: string, builderPlanPath: string, planHandoff: PhaseHandoff, iteration: number): string {
	return [
		`Implement the plan for this request: ${request}`,
		`Read only the Builder plan at ${builderPlanPath}. Build iteration ${iteration}.`,
		`Plan context: ${renderPlanContext(planHandoff)}`,
		"This is the initial implementation. Do not modify tests, run tests, or consume tester output.",
		"Track every production artifact and key implementation decision.",
		handoffRule,
	].join("\n\n");
}

/** Initial Builder turn for PBR/DPBR: the Builder owns tests through TDD. */
export function buildReviewBuildTask(request: string, builderPlanPath: string, planHandoff: PhaseHandoff, iteration: number): string {
	return [
		`Implement the reviewed plan for this request: ${request}`,
		`Read the Builder plan at ${builderPlanPath}. Build iteration ${iteration}.`,
		`Plan context: ${renderPlanContext(planHandoff)}`,
		"Before changing code, load and follow superpowers:test-driven-development. Create or update all relevant tests: write a failing test, observe RED, implement the smallest change, then run the relevant and full tests through GREEN.",
		"Record every production and test artifact plus the commands and outcomes used for verification. Do not rely on a separate Tester agent.",
		"Do not stage or commit changes; final staging and commit are exclusively the Reviewer’s responsibility after approval.",
		handoffRule,
	].join("\n\n");
}

/** One issue only. The issue ID and all diagnostic fields are one atomic block. */
export function buildIssueFixTask(issue: TestIssue, iteration: number): string {
	return [
		`Fix exactly one tester issue in build iteration ${iteration}.`,
		`Active issue:\n${renderIssue(issue)}`,
		"Work only on this issue. Inspect and change the relevant implementation. If the issue explicitly identifies a stale test assertion or test configuration, a narrowly scoped test correction is allowed; otherwise do not edit tests.",
		"Do not run tests during this build turn. Do not touch unrelated issues or tests.",
		`Return buildStage=issue-fix and exactly one issueUpdates entry for issue ${issue.id}, with status fixed only after making and inspecting the change, otherwise unresolved.`,
		handoffRule,
	].join("\n\n");
}

/** Compact continuation; the previous full issue prompt is in the session. */
export function buildIssueFixRetryTask(issue: TestIssue, iteration: number): string {
	return [
		`Retry the unresolved issue ${issue.id} in build iteration ${iteration}.`,
		"Your previous handoff marked it unresolved. Continue from the existing files and prior issue context; make the smallest valid correction now.",
		"The issue-fix turn authorizes a narrowly scoped test/configuration correction when the issue requires it. Do not run tests or touch another issue.",
		`Return buildStage=issue-fix with exactly one issueUpdates entry for ${issue.id}. Use fixed only after applying and inspecting the change.`,
	].join("\n\n");
}

/** Final barrier: no issue details, only the IDs needed for protocol validation. */
export function buildCompletionTask(ledger: IssueLedgerEntry[], iteration: number): string {
	const fixedIds = ledger
		.filter((entry) => entry.status === "fixed" && entry.issue.owner !== "environment")
		.map((entry) => entry.issue.id);
	return [
		`Emit the completed builder barrier for build iteration ${iteration}.`,
		"All non-environment issues have already been handled in preceding one-issue turns. Do not revisit or enumerate their details.",
		`Non-environment fixed issue IDs: ${fixedIds.length ? fixedIds.join(", ") : "none"}. Include one fixed issueUpdates entry for each.`,
		"Make no further file changes and do not run tests. Set buildStage=completed.",
		handoffRule,
	].join("\n\n");
}

/** Repair one quality-gate failure in the persistent Builder session. */
export function buildLintRepairTask(diagnostics: string, iteration: number, issue?: TestIssue): string {
	return [
		`Fix the required project quality-command failure from build iteration ${iteration}.`,
		...(issue ? [`The active tester issue is still in scope and must remain fixed: ${renderIssue(issue)}`] : []),
		`Quality command output (authoritative diagnostics):\n${diagnostics}`,
		"Fix only the quality findings shown by this output. Preserve runtime behavior and test meaning; do not weaken, skip, or delete tests. The orchestrator will rerun every required quality command and will not advance until all exit successfully.",
		issue
			? `Return exactly one issueUpdates entry for ${issue.id}; use fixed only after addressing both the reported issue and these quality findings, otherwise unresolved.`
			: "Report the files changed and quality corrections in the build handoff.",
		handoffRule,
	].join("\n\n");
}

/** Repair quality issues in test artifacts without starting test commands during authoring. */
export function buildTestAuthoringLintRepairTask(diagnostics: string): string {
	return [
		"The orchestrator's required project quality commands failed after your test-authoring turn.",
		`Quality command output (authoritative diagnostics):\n${diagnostics}`,
		"Continue in this persistent tester session. Correct only quality findings in test files or test configuration that you authored/modified; do not change production code or weaken test behavior. Do not run quality commands or tests in this authoring repair turn; the orchestrator will rerun all required quality commands before verification.",
		"Return a corrected authoring handoff with testStage=authoring, a testStrategy, and every authored/modified test artifact.",
		handoffRule,
	].join("\n\n");
}

export function buildTestAuthoringTask(
	request: string,
	testerPlanPath: string,
	planHandoff: PhaseHandoff,
	iteration: number,
	late = false,
): string {
	return [
		`${late ? "Author" : "Independently author"} tests for this request: ${request}`,
		`Read only the Tester plan at ${testerPlanPath}. Test authoring iteration ${iteration}. Plan context: ${renderPlanContext(planHandoff)}`,
		late
			? "The builder has completed implementation. Inspect current implementation files as needed, but do not run tests until the verification turn."
			: "The builder is working in parallel. Do not inspect, wait for, or consume a builder handoff.",
		"Write test files and test configuration only. Do not modify production code, shared production manifests, install dependencies, or run commands during authoring.",
		"Report every authored or modified test artifact and the coverage strategy. Use action=created for new files and action=modified for existing files.",
		handoffRule,
	].join("\n\n");
}

/** Repair verification-owned quality findings, then rerun the same verification suites. */
export function buildTestVerificationLintRepairTask(diagnostics: string, previous: PhaseHandoff): string {
	const priorResults = JSON.stringify({ status: previous.status, testRuns: previous.testRuns, issues: previous.issues });
	return [
		"The orchestrator's required project quality commands failed after your verification turn.",
		`Quality command output (authoritative diagnostics):\n${diagnostics}`,
		"Continue in this persistent tester session. Correct only quality findings in test files or test configuration; do not change production code or weaken, skip, or delete tests. Then rerun the same authored and relevant existing suites so the verification handoff reflects the current files.",
		`Prior verification results (preserve stable issue IDs for failures that remain):\n${priorResults}`,
		"Return a fresh testStage=verification handoff with status, captured testRuns, and actionable issues. The orchestrator will rerun every required quality command and will not advance until all exit successfully.",
		handoffRule,
	].join("\n\n");
}

export function buildTestVerificationTask(
	request: string,
	testerPlanPath: string,
	buildHandoff: PhaseHandoff,
	authorHandoff: PhaseHandoff,
	iteration: number,
	_previousIssues: TestIssue[],
	previousVerification: PhaseHandoff | undefined,
): string {
	const firstVerification = !previousVerification;
	return (firstVerification
		? [
			`Verify the implementation for this request: ${request}`,
			`Read only the Tester plan at ${testerPlanPath}. Verification iteration ${iteration}.`,
			`Test authoring context: ${renderAuthoringContext(authorHandoff)}`,
			`Builder context: ${renderBuilderBarrier(buildHandoff)}`,
		]
		: [
			`Continue verification iteration ${iteration} in the existing persistent tester session; request, plan, strategy, and prior results are retained.`,
			`The builder-complete barrier has arrived. Use current files and this delta:\n${renderBuilderBarrier(buildHandoff)}`,
		])
		.concat([
			"The builder-complete barrier permits command execution now. Run authored and relevant existing suites.",
			"Capture exact commands, exit codes, stdout, and stderr. Do not weaken or rewrite tests to hide failures.",
			"Output testStage=verification with status, testRuns, metrics, testerPlanClearance, and actionable issues. Record each Tester-plan scenario ID with evidence; status=pass requires every clearance entry to be passed. Give each issue a stable ID and preserve that ID when the same failure remains.",
		])
		.join("\n\n");
}
