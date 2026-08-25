/**
 * Final report rendering and delivery: builds the markdown report from the
 * accumulated state and delivers it via stdout, the TUI, and the session.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isVerificationHandoff } from "./handoffs.js";
import type { ArtifactEntry, WorkflowState } from "./types.js";
import { truncate } from "./util.js";
import { updateUI } from "./ui.js";

export function buildFinalReport(state: WorkflowState): string {
	const allArtifacts = new Map<string, ArtifactEntry>();
	for (const handoff of state.handoffs) {
		for (const artifact of handoff.artifacts) allArtifacts.set(artifact.path, artifact);
	}
	const lines = [
		`# Workflow ${state.status}`,
		"",
		`- Request: ${state.request}`,
		`- Run: ${state.runId}`,
		`- Workflow: ${state.workflowId || state.workflowName}`,
		`- Variant: ${state.interactive ? "interactive" : "simple"}`,
		`- Plan: ${state.planPath}`,
		...(state.design ? [`- Design review: ${state.design.status}, revision ${state.design.revision}${state.design.previewUrl ? ` (${state.design.previewUrl})` : ""}`, `- Design decisions: ${state.design.decisionPath}`] : []),
		`- Iterations: ${state.iteration}/${state.maxIterations} (budget cycle ${state.iterationCycle || 0})`,
		`- Stop reason: ${state.stopReason || "none"}`,
		`- Issue ledger: ${state.issueLedger?.length ? state.issueLedger.map((entry) => `${entry.issue.id}=${entry.status} (${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"})`).join(", ") : "none"}`,
		"",
		"## Handoffs",
	];
	for (const handoff of state.handoffs) {
		lines.push(`### ${handoff.phase}${handoff.testStage ? ` (${handoff.testStage})` : ""} · cycle ${handoff.iterationCycle || 0}, iteration ${handoff.iteration}`);
		lines.push(handoff.summary);
		if (handoff.status) lines.push(`Status: ${handoff.status}`);
		if (handoff.issues?.length) lines.push(`Issues: ${handoff.issues.length}`);
	}
	lines.push("", "## Files", ...([...allArtifacts.values()].map((artifact) => `- ${artifact.action}: ${artifact.path} — ${artifact.description}`)));
	const verificationRuns = state.handoffs.filter(isVerificationHandoff);
	lines.push("", "## Test verification");
	for (const handoff of verificationRuns) {
		lines.push(`### Cycle ${handoff.iterationCycle || 0}, iteration ${handoff.iteration}: ${handoff.status || "unknown"}`);
		for (const run of handoff.testRuns || []) {
			lines.push(`- \`${run.command}\` → exit ${run.exitCode}`);
			if (run.stdout) lines.push(`  stdout: ${truncate(run.stdout.replace(/\s+/g, " "), 500)}`);
			if (run.stderr) lines.push(`  stderr: ${truncate(run.stderr.replace(/\s+/g, " "), 500)}`);
		}
		for (const issue of handoff.issues || []) {
			lines.push(`- [${issue.severity}] ${issue.description} (${issue.test})`);
			if (issue.location) lines.push(`  - Location: ${issue.location}`);
			if (issue.owner) lines.push(`  - Owner: ${issue.owner}`);
			if (issue.expectedBehavior) lines.push(`  - Expected: ${issue.expectedBehavior}`);
			if (issue.actualBehavior) lines.push(`  - Actual: ${issue.actualBehavior}`);
			if (issue.relevantOutput) lines.push(`  - Output: ${truncate(issue.relevantOutput.replace(/\s+/g, " "), 300)}`);
			if (issue.details) lines.push(`  - Details: ${issue.details}`);
		}
	}
	if (state.failureReason) lines.push("", `Failure reason: ${state.failureReason}`);
	return lines.join("\n");
}

export function finishReport(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext, state: WorkflowState): void {
	const report = buildFinalReport(state);
	updateUI(ctx, state);
	console.log(report);
	if (ctx.hasUI) {
		ctx.ui.notify(`Workflow ${state.status}: ${state.planPath}`, state.status === "completed" ? "info" : "warning");
	}
	try {
		pi.sendMessage(
			{ customType: "workflow-final-report", content: report, display: true, details: state },
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
	} catch {
		// A report printed to stdout and saved in state is sufficient in modes
		// where the session cannot accept a custom message.
	}
}
