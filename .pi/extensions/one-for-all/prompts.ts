/**
 * Compact, phase-specific task prompts.
 *
 * Persistent agents already retain the request, plan, and previous turns. New
 * prompts therefore carry only the delta needed for the current transition.
 */

import { renderAuthoringContext, renderBuilderBarrier, renderIssue, renderPlanContext } from "./handoffs.js";
import type { IssueLedgerEntry, PhaseHandoff, TestIssue, WorkflowAnswer } from "./types.js";

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

export function buildPlanTask(request: string, planPath: string, answers: WorkflowAnswer[], interactive: boolean): string {
	if (interactive && answers.length > 0) {
		const latestRound = Math.max(...answers.map((answer) => answer.round));
		const latestAnswers = answers
			.filter((answer) => answer.round === latestRound)
			.map((answer) => `${answer.questionId}: ${answer.answer}${answer.unresolved ? " [unresolved assumption]" : ""}`)
			.join("\n");
		return [
			"Continue planning in the existing persistent planner session; prior request, repository findings, plan path, and clarification context are retained.",
			`New answers from clarification round ${latestRound}:\n${latestAnswers}`,
			"Apply these answers. If a material ambiguity remains, output only a clarification_request JSON object; otherwise write the plan and output the final plan handoff.",
		].join("\n\n");
	}
	const answerText = answers.length
		? answers.map((answer) => `${answer.questionId}: ${answer.answer}${answer.unresolved ? " [unresolved assumption]" : ""}`).join("\n")
		: "(none)";
	return [
		`Plan this request: ${request}`,
		`Write only the exact reserved plan path: ${planPath}. Variant: ${interactive ? "interactive" : "simple"}.`,
		"Explore the repository first. Do not modify production code or tests.",
		`Prior clarification answers:\n${answerText}`,
		interactive
			? "If a material ambiguity remains, output only the clarification_request JSON protocol; otherwise write the plan and output the final handoff."
			: "Do not ask questions. Infer repository-answerable details and record unresolved choices as assumptions, then write the plan and output the final handoff.",
	].join("\n\n");
}

/** Initial implementation: includes the plan delta and no issue-only rules. */
export function buildInitialBuildTask(request: string, planPath: string, planHandoff: PhaseHandoff, iteration: number): string {
	return [
		`Implement the plan for this request: ${request}`,
		`Read the exact plan at ${planPath}. Build iteration ${iteration}.`,
		`Plan context: ${renderPlanContext(planHandoff)}`,
		"This is the initial implementation. Do not modify tests, run tests, or consume tester output.",
		"Track every production artifact and key implementation decision.",
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

export function buildTestAuthoringTask(
	request: string,
	planPath: string,
	planHandoff: PhaseHandoff,
	iteration: number,
	late = false,
): string {
	return [
		`${late ? "Author" : "Independently author"} tests for this request: ${request}`,
		`Read the exact plan at ${planPath}. Test authoring iteration ${iteration}. Plan context: ${renderPlanContext(planHandoff)}`,
		late
			? "The builder has completed implementation. Inspect current implementation files as needed, but do not run tests until the verification turn."
			: "The builder is working in parallel. Do not inspect, wait for, or consume a builder handoff.",
		"Write test files and test configuration only. Do not modify production code, shared production manifests, install dependencies, or run commands during authoring.",
		"Report every authored or modified test artifact and the coverage strategy. Use action=created for new files and action=modified for existing files.",
		handoffRule,
	].join("\n\n");
}

export function buildTestVerificationTask(
	request: string,
	planPath: string,
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
			`Read the exact plan at ${planPath}. Verification iteration ${iteration}.`,
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
			"Output testStage=verification with status, testRuns, metrics, and actionable issues. Give each issue a stable ID and preserve that ID when the same failure remains.",
		])
		.join("\n\n");
}
