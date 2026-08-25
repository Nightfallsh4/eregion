/**
 * TUI integration: the live status widget and the interactive clarification
 * round-trip used by the interactive planner variant.
 */

import type { ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { CLARIFICATION_TIMEOUT_MS, MAX_DISPLAY_OUTPUT_LENGTH } from "./constants.js";
import { latestVerification } from "./handoffs.js";
import type { ClarificationQuestion, WorkflowAnswer, WorkflowState } from "./types.js";
import { truncate } from "./util.js";

export function updateUI(ctx: ExtensionContext | ExtensionCommandContext, state: WorkflowState, output?: string): void {
	state.latestOutput = output ? truncate(output.replace(/\s+/g, " ").trim(), MAX_DISPLAY_OUTPUT_LENGTH) : state.latestOutput;
	if (!ctx.hasUI) return;
	const handoffs = state.handoffs;
	const design = state.design;
	const plan = handoffs.find((handoff) => handoff.phase === "plan");
	const build = handoffs.filter((handoff) => handoff.phase === "build").at(-1);
	const author = handoffs.find((handoff) => handoff.phase === "test" && handoff.testStage === "authoring");
	const test = latestVerification(state);
	const lines = [
		`┌─ Workflow: ${state.runId} ───────────────────────────────`,
		`│ ${plan ? "✓" : "⏳"} ${state.workflowId || state.workflowName} ${state.interactive ? "(interactive)" : "(simple)"}  ${state.planPath}`,
		...(design ? [`│ ${design.approvedAt ? "✓" : "⏳"} design review ${design.status} · revision ${design.revision}${design.previewUrl ? ` · ${design.previewUrl}` : ""}`] : []),
		`│ ${build ? "✓" : "⏳"} build ${build ? `(iteration ${build.iteration})` : "(waiting)"}`,
		`│ ${author ? "✓" : "⏳"} test authoring ${author ? "ready" : "waiting"}`,
		`│ ${test ? (test.status === "pass" ? "✓" : "! ") : "⏳"} test verification ${test ? `${test.status} (iteration ${test.iteration})` : "waiting"}`,
		`│ Iteration ${state.iteration}/${state.maxIterations} · Budget cycle ${state.iterationCycle || 0} · Status: ${state.status}`,
		`│ Stop reason: ${state.stopReason || "none"}`,
		`│ Issue ledger: ${state.issueLedger?.length ? state.issueLedger.map((entry) => `${entry.issue.id}=${entry.status}`).join(", ") : "none"}`,
		`│ Questions answered: ${state.answers.length} · Plan: ${state.planPath}`,
	];
	if (state.currentAgent) lines.push(`│ Active: ${state.currentAgent} · ${truncate(state.currentActivity || "working", 90)}`);
	for (const [agent, status] of Object.entries(state.agentStatuses || {})) {
		lines.push(`│ ${agent}: ${status.status} · ${truncate(status.activity, 72)}`);
	}
	if (state.latestOutput && state.latestOutput !== state.currentActivity) lines.push(`│ Agent: ${state.latestOutput}`);
	if (state.status === "running" || state.status === "awaiting-clarification" || state.status === "awaiting-design-review") lines.push(`│ ${state.status === "awaiting-design-review" ? "Use the preview's Request changes or Approve design controls" : "Ctrl+C or /pbt-stop to abort"}`);
	lines.push("└──────────────────────────────────────────────────────────");
	ctx.ui.setWidget("workflows", lines);
	ctx.ui.setStatus("workflows", `${state.status} · ${state.runId}`);
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
