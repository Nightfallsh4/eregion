/** Optional workflow-final documentation maintenance phase. */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { requireHandoff } from "./handoffs.js";
import { isHerdrTuiEnabled } from "./herdr.js";
import { buildDocumentationTask } from "./prompts.js";
import { appendProgress } from "./progress.js";
import { resolveSubagentEfforts, resolveSubagentModels, runSubagent, type SubagentEfforts, type SubagentModels } from "./subagent.js";
import { saveState } from "./state.js";
import type { PhaseHandoff, ProgressEvent, WorkflowState } from "./types.js";
import { updateUI } from "./ui.js";
import { projectAgentPath } from "../package-paths.js";

function workflowPrefix(state: WorkflowState): string {
	return state.workflowName === "b" || state.workflowId === "b"
		? "b"
		: state.workflowName === "dpbt" || state.workflowId === "dpbt"
			? "dpbt"
			: "pbt";
}

/** Run the final documentation pass and persist its handoff in the workflow. */
export async function runDocumentationPhase(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	state: WorkflowState,
	models?: SubagentModels,
	signal?: AbortSignal,
	efforts?: SubagentEfforts,
): Promise<PhaseHandoff> {
	const cycle = state.iterationCycle || 0;
	const existing = state.handoffs.find((handoff) => handoff.phase === "documentation" && (handoff.iterationCycle || 0) === cycle);
	if (existing) return existing;

	const prefix = workflowPrefix(state);
	const runDir = path.dirname(state.activityLogPath!);
	const model = state.agentModels?.documentation || resolveSubagentModels(ctx, models).documentation;
	const effort = state.agentEfforts?.documentation || resolveSubagentEfforts(efforts).documentation;
	const iteration = Math.max(1, state.iteration);
	state.phase = "documentation";
	state.currentAgent = "documentation";
	state.currentActivity = "updating docs/";
	state.agentStatuses = {
		...state.agentStatuses,
		documentation: { status: "working", phase: "documentation", activity: "updating docs/", updatedAt: Date.now() },
	};
	saveState(ctx.cwd, state, pi);
	updateUI(ctx, state);

	const result = await runSubagent({
		cwd: ctx.cwd,
		agentPath: projectAgentPath(ctx.cwd, "docs.md"),
		model,
		effort,
		task: buildDocumentationTask(state.request, state.handoffs),
		tools: ["edit", "write", "read", "bash", "grep", "find", "ls"],
		sessionPath: path.join(runDir, "docs.jsonl"),
		signal: signal || new AbortController().signal,
		tui: isHerdrTuiEnabled() ? { runId: state.runId, agentKey: "documentation", tabLabel: `${prefix} docs`, workflowPrefix: prefix } : undefined,
		onOutput: (output) => updateUI(ctx, state, output),
		agentName: "documentation",
		phase: "documentation",
		activityLogPath: state.activityLogPath!,
		permissionContext: ctx,
		permissionWorkflow: prefix.toUpperCase(),
		onProgress: (event: ProgressEvent) => {
			appendProgress(ctx.cwd, state, event);
			saveState(ctx.cwd, state, pi, false);
			updateUI(ctx, state);
		},
	});
	const handoff = requireHandoff(result, "documentation", iteration);
	handoff.iterationCycle = cycle;
	state.handoffs.push(handoff);
	state.agentStatuses = {
		...state.agentStatuses,
		documentation: { status: "completed", phase: "documentation", activity: handoff.summary, updatedAt: Date.now() },
	};
	state.currentAgent = undefined;
	state.currentActivity = undefined;
	saveState(ctx.cwd, state, pi);
	updateUI(ctx, state, handoff.summary);
	return handoff;
}
