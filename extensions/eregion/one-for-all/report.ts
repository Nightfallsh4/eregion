/**
 * Final report rendering and delivery: builds the markdown report from the
 * accumulated state and delivers it through the session (or stdout without UI).
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isVerificationHandoff } from "./handoffs.js";
import type { ArtifactEntry, WorkflowState } from "./types.js";
import { compactErrorMessage, sanitizeTerminalText, truncate } from "./util.js";
import { updateUI } from "./ui.js";

export function buildFinalReport(state: WorkflowState): string {
	const justBuild = state.workflowName === "b" || state.workflowId === "b";
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
		`- Variant: ${justBuild ? "just-build" : state.interactive ? "interactive" : "simple"}`,
		...(justBuild ? ["- Plan: not used (single Builder phase)"] : [`- Plan: ${state.planPath}`]),
		...(state.documentationRequested ? [`- Documentation phase: ${state.handoffs.some((handoff) => handoff.phase === "documentation") ? "completed" : "requested but not completed"}`] : []),
		...(state.design ? [`- Design review: ${state.design.status}, revision ${state.design.revision}${state.design.previewUrl ? ` (${state.design.previewUrl})` : ""}`, `- Design decisions: ${state.design.decisionPath}`] : []),
		...(justBuild ? [`- Build turns: 1; lint-repair limit: ${state.maxLintRepairs || 0} (budget cycle ${state.iterationCycle || 0})`] : [`- Iterations: ${state.iteration}/${state.maxIterations} (budget cycle ${state.iterationCycle || 0})`]),
		`- Stop reason: ${state.stopReason || "none"}`,
		`- Lint command: ${state.lintCommand || "not configured"}`,
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
	if (justBuild) lines.push("Not part of the just-build workflow.");
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
	lines.push("", "## Lint quality gates");
	for (const lintRun of state.lintRuns || []) {
		lines.push(`### ${lintRun.stage} · iteration ${lintRun.iteration}, attempt ${lintRun.attempt}: ${lintRun.exitCode === 0 ? "pass" : `fail (exit ${lintRun.exitCode})`}`);
		lines.push(`- \`${lintRun.command}\``);
		if (lintRun.stdout) lines.push(`  stdout: ${truncate(lintRun.stdout.replace(/\s+/g, " "), 500)}`);
		if (lintRun.stderr) lines.push(`  stderr: ${truncate(lintRun.stderr.replace(/\s+/g, " "), 500)}`);
	}
	if (!(state.lintRuns || []).length) lines.push("No lint checks recorded.");
	if (state.failureReason) lines.push("", `Failure reason: ${state.failureReason}`);
	return lines.join("\n");
}

/** Never write directly to stdout while pi owns the interactive screen. */
export function deliverWorkflowOutput(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	content: string,
	customType = "workflow-output",
	details?: unknown,
): void {
	if (!ctx.hasUI) console.log(content);
	try {
		pi.sendMessage(
			{ customType, content: sanitizeTerminalText(content), display: true, details },
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
	} catch {
		// Persisted run state (or stdout in headless mode) remains available.
		// Do not fall back to console.log in the TUI: that corrupts its layout.
		if (ctx.hasUI) ctx.ui.notify("Workflow output could not be displayed; inspect the saved run state.", "warning");
	}
}

export function finishReport(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext, state: WorkflowState): void {
	updateUI(ctx, state);
	deliverWorkflowOutput(pi, ctx, buildFinalReport(state), "workflow-final-report", state);
	// Pi renders notifications as permanent transcript entries; they cannot be
	// dismissed on resume. The replaceable widget and report message already
	// show stopped-run diagnostics, so only announce successful completion.
	if (ctx.hasUI && state.status === "completed") {
		const destination = state.workflowName === "b" || state.workflowId === "b" ? "lint passed" : state.planPath;
		ctx.ui.notify(compactErrorMessage(`Workflow completed: ${destination}`), "info");
	}
}
