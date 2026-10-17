/**
 * TUI integration: the live status widget and the interactive clarification
 * round-trip used by the interactive planner variant.
 */

import type { ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { CLARIFICATION_TIMEOUT_MS, MAX_DISPLAY_OUTPUT_LENGTH } from "./constants.js";
import { isVerificationHandoff } from "./handoffs.js";
import type { ClarificationQuestion, WorkflowAnswer, WorkflowState } from "./types.js";
import { compactErrorMessage, sanitizeTerminalText, truncate } from "./util.js";

function setWorkflowWidget(ctx: ExtensionContext | ExtensionCommandContext, lines: string[]): void {
	// Text-based widgets wrap every string. A multiline error or long issue
	// ledger can otherwise turn a small status panel into a screen-sized block.
	const safeLines = lines.map((line) => sanitizeTerminalText(line).replace(/\s+/g, " ").trim());
	if (ctx.mode === "rpc") {
		// RPC clients support string widgets, not terminal component factories.
		ctx.ui.setWidget("workflows", safeLines);
		return;
	}
	ctx.ui.setWidget("workflows", () => ({
		render: (width) => safeLines.map((line) => truncateToWidth(line, Math.max(0, width), "…")),
		invalidate() {},
	}));
}

export function updateUI(ctx: ExtensionContext | ExtensionCommandContext, state: WorkflowState, output?: string): void {
	state.latestOutput = output ? compactErrorMessage(output, MAX_DISPLAY_OUTPUT_LENGTH) : state.latestOutput;
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("workflows", compactErrorMessage(`${state.status} · ${state.runId}`));
	if (state.status !== "running" && state.status !== "awaiting-clarification" && state.status !== "awaiting-design-review") {
		const statusCommand = state.workflowName === "b" || state.workflowId === "b" ? "/b-status" : "/pbt-status";
		setWorkflowWidget(ctx, [
			`Workflow ${state.status} · ${state.runId}`,
			...(state.failureReason ? [compactErrorMessage(state.failureReason)] : []),
			`Details: ${statusCommand} ${state.runId}`,
		]);
		return;
	}
	const handoffs = state.handoffs;
	const justBuild = state.workflowName === "b" || state.workflowId === "b";
	const design = state.design;
	const plan = handoffs.find((handoff) => handoff.phase === "plan");
	const cycle = state.iterationCycle || 0;
	const currentHandoffs = handoffs.filter((handoff) => (handoff.iterationCycle || 0) === cycle);
	const build = currentHandoffs.filter((handoff) => handoff.phase === "build").at(-1);
	const author = currentHandoffs.find((handoff) => handoff.phase === "test" && handoff.testStage === "authoring");
	const test = currentHandoffs.filter(isVerificationHandoff).at(-1);
	const documentation = currentHandoffs.filter((handoff) => handoff.phase === "documentation").at(-1);
	const latestLintRun = state.lintRuns?.filter((run) => (run.iterationCycle || 0) === cycle).at(-1);
	const lines = [
		`┌─ Workflow: ${state.runId} ───────────────────────────────`,
		`│ ${justBuild ? "⏳" : plan ? "✓" : "⏳"} ${state.workflowId || state.workflowName} ${justBuild ? "(just build)" : state.interactive ? "(interactive)" : "(simple)"}${justBuild ? " · one Builder phase" : `  ${state.builderPlanPath || state.planPath}`}`,
		...(design ? [`│ ${design.approvedAt ? "✓" : "⏳"} design review ${design.status} · revision ${design.revision}${design.previewUrl ? ` · ${design.previewUrl}` : ""}`] : []),
		`│ ${build ? "✓" : "⏳"} build ${build ? `(iteration ${build.iteration})` : "(waiting)"}`,
		...(justBuild ? [] : [
			`│ ${author ? "✓" : "⏳"} test authoring ${author ? "ready" : "waiting"}`,
			`│ ${test ? (test.status === "pass" ? "✓" : "! ") : "⏳"} test verification ${test ? `${test.status} (iteration ${test.iteration})` : "waiting"}`,
		]),
		...(state.documentationRequested ? [`│ ${documentation ? "✓" : "⏳"} docs maintenance ${documentation ? "updated" : "waiting for successful workflow"}`] : []),
		`│ ${justBuild ? `Single build · Lint repairs ${state.maxLintRepairs || 0} · Budget cycle ${state.iterationCycle || 0}` : `Iteration ${state.iteration}/${state.maxIterations} · Budget cycle ${state.iterationCycle || 0}`} · Status: ${state.status}`,
		`│ Stop reason: ${state.stopReason || "none"}`,
		`│ Lint: ${latestLintRun ? `${latestLintRun.exitCode === 0 ? "passed" : "failed"} · ${latestLintRun.stage} (attempt ${latestLintRun.attempt})` : truncate(state.lintCommand || "not configured", 80)}`,
		...(justBuild ? [] : [
			`│ Issue ledger: ${state.issueLedger?.length ? state.issueLedger.map((entry) => `${entry.issue.id}=${entry.status}`).join(", ") : "none"}`,
			`│ Questions answered: ${state.answers.length} · Builder: ${state.builderPlanPath || state.planPath} · Tester: ${state.testerPlanPath || "legacy plan"}`,
		]),
	];
	if (state.currentAgent) lines.push(`│ Active: ${state.currentAgent} · ${truncate(state.currentActivity || "working", 90)}`);
	for (const [agent, status] of Object.entries(state.agentStatuses || {})) {
		lines.push(`│ ${agent}: ${status.status} · ${truncate(status.activity, 72)}`);
	}
	if (state.latestOutput && state.latestOutput !== state.currentActivity) lines.push(`│ Agent: ${state.latestOutput}`);
	if (state.status === "running" || state.status === "awaiting-clarification" || state.status === "awaiting-design-review") lines.push(`│ ${state.status === "awaiting-design-review" ? "Use the preview's Request changes or Approve design controls" : justBuild ? "Ctrl+C or /b-stop to abort" : "Ctrl+C or /pbt-stop to abort"}`);
	lines.push("└──────────────────────────────────────────────────────────");
	setWorkflowWidget(ctx, lines);
}

export async function askClarifications(
	ctx: ExtensionContext | ExtensionCommandContext,
	questions: ClarificationQuestion[],
	round: number,
): Promise<WorkflowAnswer[]> {
	const answers: WorkflowAnswer[] = [];
	for (const question of questions) {
		if (!ctx.hasUI) {
			answers.push({
				questionId: question.id,
				answer: "No interactive UI is available; proceed with an explicit assumption and risk.",
				wasCustom: false,
				unresolved: true,
				round,
			});
			continue;
		}

		const options = [...(question.options || [])];
		if (question.allowFreeform) options.push("Custom answer");
		options.push("Proceed without deciding (record an assumption)");
		const prompt = `${question.question}\n\nWhy it matters: ${question.whyItMatters}`;
		const selected = await ctx.ui.select(prompt, options, { timeout: CLARIFICATION_TIMEOUT_MS });

		if (!selected || selected === "Proceed without deciding (record an assumption)") {
			answers.push({
				questionId: question.id,
				answer: "Unresolved: proceed without deciding; record the assumption and risk in the plan.",
				wasCustom: false,
				unresolved: true,
				round,
			});
			continue;
		}
		if (selected === "Custom answer") {
			const custom = await ctx.ui.input("Custom answer:", "Describe the requirement");
			answers.push({
				questionId: question.id,
				answer: custom?.trim() || "Unresolved: custom answer was empty; record an assumption and risk.",
				wasCustom: true,
				unresolved: !custom?.trim(),
				round,
			});
		} else {
			answers.push({ questionId: question.id, answer: selected, wasCustom: false, round });
		}
	}
	return answers;
}
