/**
 * Run registry and state persistence: creates run IDs, saves/loads
 * `state.json`, tracks in-process active runs, validates planner output paths,
 * and summarizes/inspects runs.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { LEGACY_RUNS_DIR, RUNS_DIR } from "./constants.js";
import { formatProgressEvent, readProgress } from "./progress.js";
import type { PlanPaths, RunControl, WorkflowState } from "./types.js";
import { ensureDirectory, isRecord } from "./util.js";

export const activeRuns = new Map<string, RunControl>();

// Older PBT versions stored runs below .pi/. Keep reading that location
// so existing workflows remain visible and resumable after the storage layout
// moved to acache/.
const LEGACY_DOT_PI_RUNS_DIR = path.join(".pi", "pbt-flow-runs");

function runRoots(cwd: string): string[] {
	return [path.join(cwd, RUNS_DIR), path.join(cwd, LEGACY_RUNS_DIR), path.join(cwd, LEGACY_DOT_PI_RUNS_DIR)];
}

export function runDirectory(cwd: string, runId: string): string {
	const roots = runRoots(cwd);
	for (const root of roots) {
		if (fs.existsSync(path.join(root, runId))) return path.join(root, runId);
	}
	return path.join(cwd, RUNS_DIR, runId);
}

function storageDirectory(cwd: string, runId: string): string {
	return runDirectory(cwd, runId);
}

export function createRunId(): string {
	return `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function stateFilePath(cwd: string, runId: string): string {
	return path.join(storageDirectory(cwd, runId), "state.json");
}

export function saveState(cwd: string, state: WorkflowState, pi: ExtensionAPI, mirrorToSession = true): void {
	const runDir = storageDirectory(cwd, state.runId);
	ensureDirectory(runDir);
	const target = path.join(runDir, "state.json");
	const temporary = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
	fs.renameSync(temporary, target);
	if (!mirrorToSession) return;
	try {
		pi.appendEntry("workflow-run", state);
	} catch {
		// Disk state is authoritative; an extension entry is a convenience for
		// /resume and should not make a completed run fail.
	}
}

export function loadState(cwd: string, runId: string): WorkflowState | null {
	try {
		const raw = fs.readFileSync(stateFilePath(cwd, runId), "utf8");
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? (parsed as unknown as WorkflowState) : null;
	} catch {
		return null;
	}
}

export function listStates(cwd: string): WorkflowState[] {
	const statesById = new Map<string, WorkflowState>();
	for (const directory of runRoots(cwd)) {
		if (!fs.existsSync(directory)) continue;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || statesById.has(entry.name)) continue;
			const state = loadState(cwd, entry.name);
			if (state) statesById.set(entry.name, state);
		}
	}
	return [...statesById.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function assertPlanExists(cwd: string, planPath: string): void {
	const absolute = path.resolve(cwd, planPath);
	const relative = path.relative(cwd, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Planner returned an unsafe plan path: ${planPath}`);
	}
	if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size === 0) {
		throw new Error(`Planner did not write a non-empty plan to ${planPath}`);
	}
}

/** Verify both reserved role plans are distinct, safe, regular, and populated. */
export function assertPlanOutputsExist(cwd: string, paths: PlanPaths): void {
	if (paths.builderPlanPath === paths.testerPlanPath) {
		throw new Error("Builder and tester plan paths must be distinct");
	}
	const root = path.resolve(cwd);
	const plansDirectory = path.join(root, "acache", "plans");
	for (const [role, planPath] of [["Builder", paths.builderPlanPath], ["Tester", paths.testerPlanPath]] as const) {
		const absolute = path.resolve(root, planPath);
		const projectRelative = path.relative(root, absolute);
		const plansRelative = path.relative(plansDirectory, absolute);
		if (
			projectRelative.startsWith("..")
			|| path.isAbsolute(projectRelative)
			|| plansRelative.startsWith("..")
			|| path.isAbsolute(plansRelative)
		) {
			throw new Error(`${role} plan must be inside acache/plans: ${planPath}`);
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(absolute);
		} catch {
			throw new Error(`${role} plan is missing: ${planPath}`);
		}
		if (!stat.isFile()) throw new Error(`${role} plan must be a regular file: ${planPath}`);
		if (stat.size === 0) throw new Error(`${role} plan must be non-empty: ${planPath}`);
	}
}

export function summarizeState(state: WorkflowState): string {
	const latest = state.handoffs.at(-1);
	const justBuild = state.workflowName === "b" || state.workflowId === "b";
	return [
		`${state.runId} · ${state.status} · ${justBuild ? "just-build" : state.interactive ? "interactive" : "simple"}`,
		`request: ${state.request}`,
		justBuild
			? "plan: not used (single Builder phase)"
			: state.builderPlanPath && state.testerPlanPath
				? `Builder plan: ${state.builderPlanPath}\nTester plan: ${state.testerPlanPath}`
				: `plan: ${state.planPath}`, 
		justBuild
			? `build turns: 1; lint-repair limit: ${state.maxLintRepairs || 0} (budget cycle ${state.iterationCycle || 0})`
			: `iteration: ${state.iteration}/${state.maxIterations} (budget cycle ${state.iterationCycle || 0})`,
		`stop: ${state.stopReason || "none"}`,
		`lint: ${state.lintCommand || "not configured"} (${(state.lintRuns || []).filter((run) => run.exitCode === 0).length} pass / ${(state.lintRuns || []).filter((run) => run.exitCode !== 0).length} fail)`,
		`issue ledger: ${state.issueLedger?.length ? state.issueLedger.map((entry) => `${entry.issue.id}=${entry.status}`).join(", ") : "none"}`,
		`phase: ${state.phase || "unknown"}`,
		`agents: ${Object.entries(state.agentStatuses || {})
			.map(([agent, status]) => `${agent}=${status.status} (${status.phase})`)
			.join(", ") || "none"}`,
		`models: ${Object.entries(state.agentModels || {})
			.map(([role, model]) => `${role}=${model}`)
			.join(", ") || "unresolved"}`,
		`efforts: ${Object.entries(state.agentEfforts || {})
			.map(([role, effort]) => `${role}=${effort}`)
			.join(", ") || "high (default)"}`,
		latest ? `latest: ${latest.phase}${latest.testStage ? `/${latest.testStage}` : ""} — ${latest.summary}` : "latest: none",
	].join("\n");
}

export function inspectState(state: WorkflowState, cwd: string, limit = 40): string {
	const events = readProgress(cwd, state, limit);
	return `${summarizeState(state)}${state.failureReason ? `\nfailure: ${state.failureReason}` : ""}\nactive: ${state.currentAgent || "none"}\nactivity: ${state.currentActivity || "none"}\nactivity log: ${state.activityLogPath || "none"}\nevents: ${state.eventCount || 0}\n\n${events.length ? events.map(formatProgressEvent).join("\n") : "(no activity recorded)"}`;
}

export function stateForArgument(cwd: string, runId: string | undefined): WorkflowState | null {
	if (runId) return loadState(cwd, runId);
	const active = [...activeRuns.values()].at(-1)?.state;
	return active || listStates(cwd)[0] || null;
}

/** Return a persisted run that can be resumed, preferring the newest one. */
export function resumableStateForArgument(cwd: string, runId?: string): WorkflowState | null {
	const requested = runId ? loadState(cwd, runId) : null;
	if (runId) return requested && isResumableState(requested) ? requested : null;
	return listStates(cwd).find(isResumableState) || null;
}

export function isResumableState(state: WorkflowState): boolean {
	return (
		state.status === "running" ||
		state.status === "awaiting-clarification" ||
		state.status === "awaiting-design-review" ||
		state.status === "failed" ||
		state.status === "aborted" ||
		state.status === "max-iterations-reached" ||
		state.status === "plateau-reached"
	);
}
