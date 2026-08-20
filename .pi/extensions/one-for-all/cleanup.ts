/** Cleanup helpers for persisted workflow subagent sessions and Herdr tabs. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowState } from "./types.js";
import { herdrCommand } from "./herdr.js";
import { runDirectory } from "./state.js";
import { stopDesignPreviewServer } from "./design-review.js";

const SESSION_FILES = ["designer.jsonl", "planner.jsonl", "build.jsonl", "test.jsonl"] as const;

export interface CleanupResult {
	runId: string;
	tabsClosed: number;
	sessionsRemoved: number;
	warnings: string[];
}

/**
 * Remove the resources owned by one completed/stopped run without removing its
 * state, activity log, or plan. Keeping those artifacts makes the run remain
 * inspectable after its live resources have been cleared.
 */
export async function cleanupRunResources(cwd: string, state: WorkflowState): Promise<CleanupResult> {
	const warnings: string[] = [];
	const tabsClosed = await closeHerdrTabsForRun(state.runId, warnings);
	const runDir = runDirectory(cwd, state.runId);
	if (state.design) stopDesignPreviewServer(state.design.previewDir);
	let sessionsRemoved = 0;

	for (const filename of SESSION_FILES) {
		const sessionPath = path.join(runDir, filename);
		try {
			if (fs.existsSync(sessionPath)) {
				fs.rmSync(sessionPath, { force: true });
				sessionsRemoved++;
			}
		} catch (error) {
			warnings.push(`could not remove ${filename}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { runId: state.runId, tabsClosed, sessionsRemoved, warnings };
}

async function closeHerdrTabsForRun(runId: string, warnings: string[]): Promise<number> {
	// Cleanup is intentionally independent of PBT_FLOW_HERDR: a user may turn
	// that setting off after a run and still need to remove its old tabs.
	if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_WORKSPACE_ID) return 0;
	const suffix = runId.split("-").at(-1) || runId;
	const agentNames = new Set(["pbt", "dpbt"].flatMap((prefix) => ["designer", "planner", "builder", "tester", "tester-verification"].map((key) => `${prefix}-${key}-${suffix}`)));
	const tabIds = new Set<string>();
	const workspaceId = process.env.HERDR_WORKSPACE_ID;

	try {
		const response = await herdrCommand(["agent", "list"], { killAfterMs: 15_000 });
		for (const agent of response?.result?.agents || []) {
			if (!agentNames.has(agent?.name)) continue;
			if (workspaceId && agent?.workspace_id !== workspaceId) continue;
			if (typeof agent?.tab_id === "string") tabIds.add(agent.tab_id);
		}
	} catch (error) {
		warnings.push(`could not inspect Herdr agents: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const response = await herdrCommand(args, { killAfterMs: 15_000 });
		const labels = new Set(["pbt", "dpbt"].flatMap((prefix) => ["design", "plan", "build", "test"].map((phase) => `${prefix} ${phase} ${suffix}`)));
		for (const tab of response?.result?.tabs || []) {
			const label = typeof tab?.label === "string" ? tab.label.replace(/^[✓✗⟳]\s+/, "") : "";
			if (labels.has(label) && typeof tab?.tab_id === "string") tabIds.add(tab.tab_id);
		}
	} catch (error) {
		warnings.push(`could not inspect Herdr tabs: ${error instanceof Error ? error.message : String(error)}`);
	}

	let closed = 0;
	for (const tabId of tabIds) {
		try {
			await herdrCommand(["tab", "close", tabId], { killAfterMs: 15_000 });
			closed++;
		} catch (error) {
			warnings.push(`could not close Herdr tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return closed;
}
