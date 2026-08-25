/**
 * Live activity log: appends structured progress events to a JSONL file and
 * renders them for humans. Kept separate from run state so other workflows can
 * reuse the same activity.jsonl format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_DISPLAY_OUTPUT_LENGTH } from "./constants.js";
import type { ProgressEvent, WorkflowState } from "./types.js";
import { ensureDirectory, truncate } from "./util.js";

export function appendProgress(cwd: string, state: WorkflowState, event: ProgressEvent): void {
	if (!state.activityLogPath) return;
	ensureDirectory(path.dirname(state.activityLogPath));
	fs.appendFileSync(state.activityLogPath, `${JSON.stringify(event)}\n`, "utf8");
	state.currentAgent = event.agent;
	state.currentActivity = event.message;
	state.agentStatuses = {
		...(state.agentStatuses || {}),
		[event.agent]: {
			status: event.kind === "failed" ? "failed" : event.kind === "completed" ? "completed" : event.kind === "started" ? "working" : "working",
			phase: event.phase,
			activity: event.message,
			updatedAt: event.timestamp,
		},
	};
	state.lastEventAt = event.timestamp;
	state.eventCount = (state.eventCount || 0) + 1;
	state.latestOutput = truncate(`${event.agent}: ${event.message}`, MAX_DISPLAY_OUTPUT_LENGTH);
}

export function readProgress(cwd: string, state: WorkflowState, limit = 80): ProgressEvent[] {
	if (!state.activityLogPath || !fs.existsSync(state.activityLogPath)) return [];
	const lines = fs.readFileSync(state.activityLogPath, "utf8").split("\n").filter(Boolean);
	return lines
		.slice(-Math.max(1, Math.min(500, limit)))
		.map((line) => {
			try {
				return JSON.parse(line) as ProgressEvent;
			} catch {
				return null;
			}
		})
		.filter((event): event is ProgressEvent => event !== null);
}

export function formatProgressEvent(event: ProgressEvent): string {
	const time = new Date(event.timestamp).toLocaleTimeString();
	const detail = event.details ? ` ${truncate(event.details.replace(/\s+/g, " "), 220)}` : "";
	return `${time} [${event.phase}] ${event.agent} ${event.kind}: ${truncate(event.message.replace(/\s+/g, " "), 300)}${detail}`;
}
