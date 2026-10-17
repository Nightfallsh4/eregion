/**
 * Structured handoff protocol: parsing, normalization, rendering, and
 * validation of the JSON contracts exchanged between planner, builder, and
 * tester subagents.
 *
 * This module is deliberately free of workflow-loop logic so other workflows
 * can reuse the same handoff format.
 */

import * as fs from "node:fs";
import { MAX_PROMPT_HANDOFF_LENGTH } from "./constants.js";
import type {
	AgentResult,
	ArtifactEntry,
	ClarificationQuestion,
	ClarificationRequest,
	DecisionEntry,
	IssueResolution,
	IssueLedgerEntry,
	PhaseHandoff,
	TestIssue,
	TestRun,
	WorkflowState,
} from "./types.js";
import { asNumber, asString, isRecord, truncate } from "./util.js";

export function normalizeArtifact(value: unknown): ArtifactEntry | null {
	if (!isRecord(value) || typeof value.path !== "string") return null;
	// Models sometimes use `updated` for an existing file. Keep the persisted
	// contract small and canonical, but accept that equivalent wording so a
	// valid authoring handoff is not rejected merely because an existing test
	// file was changed rather than newly created.
	const rawAction = value.action;
	const action = rawAction === "updated" ? "modified" : rawAction;
	if (action !== "created" && action !== "modified" && action !== "deleted") return null;
	return {
		path: value.path,
		description: asString(value.description, "Workflow artifact"),
		action,
	};
}

export function normalizeDecision(value: unknown): DecisionEntry | null {
	if (!isRecord(value) || typeof value.decision !== "string") return null;
	return {
		decision: value.decision,
		rationale: asString(value.rationale, "No rationale provided"),
	};
}

export function normalizeIssue(value: unknown, index: number): TestIssue | null {
	if (!isRecord(value)) return null;
	// `description` is the canonical field. Accept `summary` as a tolerant
	// fallback because testers commonly use that equivalent field in handoffs;
	// otherwise actionable issues can disappear during normalization.
	const description = typeof value.description === "string" ? value.description : typeof value.summary === "string" ? value.summary : undefined;
	if (!description) return null;
	const recommendedAction = typeof value.recommendedAction === "string" ? `Recommended action: ${value.recommendedAction}` : undefined;
	const details = typeof value.details === "string" ? value.details : recommendedAction;
	const severity = value.severity === "warning" ? "warning" : "error";
	const stableFallbackId = `test-issue-${(asString(value.test, "relevant-test") + "-" + description).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96) || index + 1}`;
	return {
		id: asString(value.id, stableFallbackId),
		description,
		test: asString(value.test, typeof value.path === "string" ? value.path : "Relevant test suite"),
		severity,
		details,
		location: asString(value.location),
		expectedBehavior: asString(value.expectedBehavior),
		actualBehavior: asString(value.actualBehavior),
		relevantOutput: asString(value.relevantOutput),
		owner: value.owner === "builder" || value.owner === "tester" || value.owner === "environment" ? value.owner : undefined,
	};
}

export function normalizeIssueResolution(value: unknown): IssueResolution | null {
	if (!isRecord(value)) return null;
	// Models occasionally use `id` in issueUpdates because the issue itself
	// uses that field. Normalize the equivalent spelling so a useful repair
	// handoff is not discarded during resume; prompts still require canonical
	// `issueId` output.
	const issueId = typeof value.issueId === "string"
		? value.issueId
		: typeof value.id === "string"
			? value.id
			: undefined;
	if (!issueId || (value.status !== "fixed" && value.status !== "unresolved")) return null;
	return {
		issueId,
		status: value.status,
		summary: asString(value.summary, "No resolution summary provided"),
	};
}

export function normalizeTestRun(value: unknown): TestRun | null {
	if (!isRecord(value) || typeof value.command !== "string") return null;
	return {
		command: value.command,
		exitCode: asNumber(value.exitCode, 1),
		stdout: asString(value.stdout),
		stderr: asString(value.stderr),
	};
}

export function normalizeHandoff(value: unknown, phase: PhaseHandoff["phase"], iteration: number): PhaseHandoff | null {
	if (!isRecord(value) || typeof value.summary !== "string") return null;
	const artifacts = Array.isArray(value.artifacts)
		? value.artifacts.map(normalizeArtifact).filter((entry): entry is ArtifactEntry => entry !== null)
		: [];
	const decisions = Array.isArray(value.decisions)
		? value.decisions.map(normalizeDecision).filter((entry): entry is DecisionEntry => entry !== null)
		: [];
	const metrics = isRecord(value.metrics)
		? Object.entries(value.metrics).reduce<Record<string, number>>((result, [key, metric]) => {
				if (typeof metric === "number") result[key] = metric;
				return result;
			}, {})
		: undefined;
	const issues = Array.isArray(value.issues)
		? value.issues.map((issue, index) => normalizeIssue(issue, index)).filter((entry): entry is TestIssue => entry !== null)
		: undefined;
	const testRuns = Array.isArray(value.testRuns)
		? value.testRuns.map(normalizeTestRun).filter((entry): entry is TestRun => entry !== null)
		: undefined;
	const issueUpdates = Array.isArray(value.issueUpdates)
		? value.issueUpdates.map(normalizeIssueResolution).filter((entry): entry is IssueResolution => entry !== null)
		: undefined;

	return {
		phase,
		iteration,
		summary: value.summary,
		artifacts,
		decisions,
		metrics,
		planPath: typeof value.planPath === "string" ? value.planPath : undefined,
		assumptions: Array.isArray(value.assumptions)
			? value.assumptions.filter((item): item is string => typeof item === "string")
			: undefined,
		testStage: value.testStage === "authoring" || value.testStage === "verification" || value.testStage === "repair" ? value.testStage : undefined,
		buildStage: value.buildStage === "issue-fix" || value.buildStage === "completed" ? value.buildStage : undefined,
		testRuns,
		issueUpdates,
		testStrategy: typeof value.testStrategy === "string" ? value.testStrategy : undefined,
		status: value.status === "pass" || value.status === "fail" ? value.status : undefined,
		issues,
		completedAt: Date.now(),
	};
}

export function parseJsonCandidates(output: string): unknown[] {
	const candidates: unknown[] = [];
	const fenced = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
	for (let index = fenced.length - 1; index >= 0; index--) {
		try {
			candidates.push(JSON.parse(fenced[index][1]));
		} catch {
			// Try the next fenced block or fallback below.
		}
	}
	try {
		candidates.push(JSON.parse(output.trim()));
	} catch {
		// The model is allowed to include prose around its handoff.
	}
	return candidates;
}

export function parseClarificationRequest(output: string, phase: ClarificationRequest["phase"] = "plan"): ClarificationRequest | null {
	for (const candidate of parseJsonCandidates(output)) {
		if (!isRecord(candidate) || candidate.type !== "clarification_request" || candidate.phase !== phase) continue;
		if (!Array.isArray(candidate.questions) || candidate.questions.length === 0) continue;
		const questions: ClarificationQuestion[] = [];
		for (const rawQuestion of candidate.questions) {
			if (!isRecord(rawQuestion) || typeof rawQuestion.id !== "string" || typeof rawQuestion.question !== "string") continue;
			questions.push({
				id: rawQuestion.id,
				question: rawQuestion.question,
				whyItMatters: asString(rawQuestion.whyItMatters, phase === "design" ? "This affects the proposed product experience." : "This affects the implementation plan."),
				options: Array.isArray(rawQuestion.options)
					? rawQuestion.options.filter((option): option is string => typeof option === "string")
					: undefined,
				allowFreeform: rawQuestion.allowFreeform !== false,
			});
		}
		if (questions.length > 0) return { phase, type: "clarification_request", questions };
	}
	return null;
}

export function parseHandoff(output: string, phase: PhaseHandoff["phase"], iteration: number): PhaseHandoff | null {
	for (const candidate of parseJsonCandidates(output)) {
		if (isRecord(candidate) && candidate.type === "clarification_request") continue;
		const handoff = normalizeHandoff(candidate, phase, iteration);
		if (handoff) return handoff;
	}
	return null;
}

/**
 * Prompt renderers intentionally expose only the fields the receiving phase
 * needs. Handoffs remain complete in state.json; prompts should carry deltas,
 * not a second copy of the run history.
 */
function compactPromptValue(value: unknown): unknown {
	if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 2_000);
	if (Array.isArray(value)) return value.slice(0, 40).map(compactPromptValue);
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compactPromptValue(entry)]));
	}
	return value;
}

function renderPromptObject(value: Record<string, unknown>): string {
	const compact = compactPromptValue(value) as Record<string, unknown>;
	const text = JSON.stringify(compact);
	if (text.length <= MAX_PROMPT_HANDOFF_LENGTH) return text;
	// Preserve valid JSON and the highest-value fields instead of cutting a
	// potentially unusable JSON document at an arbitrary character boundary.
	return JSON.stringify({
		phase: compact.phase,
		iteration: compact.iteration,
		status: compact.status,
		buildStage: compact.buildStage,
		testStage: compact.testStage,
		summary: compact.summary,
		_note: `Prompt payload shortened from ${text.length} characters; read the referenced files for full details.`,
	});
}

export function renderHandoff(handoff: PhaseHandoff | undefined): string {
	if (!handoff) return "(none)";
	return renderPromptObject({
		phase: handoff.phase,
		iteration: handoff.iteration,
		summary: handoff.summary,
		artifacts: handoff.artifacts,
		decisions: handoff.decisions,
		assumptions: handoff.assumptions,
		planPath: handoff.planPath,
		testStage: handoff.testStage,
		buildStage: handoff.buildStage,
		status: handoff.status,
		metrics: handoff.metrics,
	});
}

export function renderPlanContext(handoff: PhaseHandoff | undefined): string {
	if (!handoff) return "(none)";
	return renderPromptObject({
		summary: handoff.summary,
		decisions: handoff.decisions,
		assumptions: handoff.assumptions,
		planPath: handoff.planPath,
	});
}

export function renderAuthoringContext(handoff: PhaseHandoff | undefined): string {
	if (!handoff) return "(none)";
	return renderPromptObject({
		testStrategy: handoff.testStrategy,
		artifacts: handoff.artifacts.map(({ path, action }) => ({ path, action })),
	});
}

export function renderBuilderBarrier(handoff: PhaseHandoff | undefined): string {
	if (!handoff) return "(none)";
	return renderPromptObject({
		iteration: handoff.iteration,
		buildStage: handoff.buildStage,
		summary: handoff.summary,
		artifacts: handoff.artifacts.map(({ path, action }) => ({ path, action })),
		issueUpdates: handoff.issueUpdates?.map(({ issueId, status }) => ({ issueId, status })),
	});
}

export function renderIssue(issue: TestIssue | undefined): string {
	if (!issue) return "(none)";
	return renderPromptObject({
		id: issue.id,
		severity: issue.severity,
		description: issue.description,
		test: issue.test,
		location: issue.location,
		expectedBehavior: issue.expectedBehavior,
		actualBehavior: issue.actualBehavior,
		relevantOutput: issue.relevantOutput,
		details: issue.details,
		owner: issue.owner,
	});
}

export function renderIssues(issues: TestIssue[]): string {
	if (issues.length === 0) return "(none)";
	return issues.map((issue) => renderIssue(issue)).join("\n");
}

export function fallbackHandoff(output: string, phase: PhaseHandoff["phase"], iteration: number, planPath?: string): PhaseHandoff {
	return {
		phase,
		iteration,
		summary: output.trim() || `${phase} agent completed without a structured handoff.`,
		artifacts: [],
		decisions: [],
		planPath,
		completedAt: Date.now(),
	};
}

export function requireHandoff(result: AgentResult, phase: PhaseHandoff["phase"], iteration: number, planPath?: string): PhaseHandoff {
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout") {
		const preview = result.errorMessage?.trim()
			|| result.stderr?.trim()
			|| result.output?.trim()?.slice(0, 800)
			|| `exit code ${result.exitCode}`;
		const details = [
			`phase=${phase}`,
			`iteration=${iteration}`,
			`exitCode=${result.exitCode}`,
			`stopReason=${result.stopReason || "unknown"}`,
			`errorMessage=${result.errorMessage || "none"}`,
			`stderrLength=${result.stderr?.length || 0}`,
			`outputLength=${result.output?.length || 0}`,
			`model=${result.model || "unknown"}`,
		].join(", ");
		throw new Error(
			`${phase} subagent failed at iteration ${iteration}: ${preview} [${details}]`,
		);
	}
	return parseHandoff(result.output, phase, iteration) || fallbackHandoff(result.output, phase, iteration, planPath);
}

/**
 * Re-read a subagent's persisted session JSONL from disk and return the text of
 * the LAST complete assistant message. This is an authoritative source that is
 * independent of the live tailer/`AgentResult.output` capture, which can drop a
 * trailing handoff record if it was still being written when the agent settled.
 */
export async function readLatestAssistantText(sessionPath: string, maxWaitMs = 2_000): Promise<string> {
	let lastText = "";
	let stableReads = 0;
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		let text = "";
		try {
			const size = fs.statSync(sessionPath).size;
			const descriptor = fs.openSync(sessionPath, "r");
			try {
				const buffer = Buffer.alloc(size);
				fs.readSync(descriptor, buffer, 0, size, 0);
				const lines = buffer.toString("utf8").split("\n");
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					let entry: unknown;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
					const role = entry.message.role;
					if (role !== "assistant") continue;
					const assistant = getAssistantMessageFrom(entry.message as { role: string; content?: unknown });
					if (assistant) {
						text = assistant;
						break;
					}
				}
			} finally {
				fs.closeSync(descriptor);
			}
		} catch {
			// Session file may not exist/be readable yet; retry until the deadline.
		}
		if (text && text === lastText) {
			stableReads += 1;
			if (stableReads >= 2) return lastText;
		} else {
			stableReads = 0;
		}
		if (text) lastText = text;
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
	return lastText;
}

/** Normalize a string built from an assistant Message content part. */
function getAssistantMessageFrom(message: { role: string; content?: unknown }): string {
	const content = message.content;
	if (message.role !== "assistant" || !Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Re-parse a captured AgentResult, falling back to the persisted session file
 * when the captured output lost the trailing handoff. Unlike plain
 * `requireHandoff`, this prefers a parseable handoff over a fallback bash when
 * the exit code path is healthy but the tailer dropped the final JSON record.
 */
export async function verifyWithSessionFallback(
	result: AgentResult,
	phase: PhaseHandoff["phase"],
	iteration: number,
	sessionPath: string,
	planPath?: string,
): Promise<PhaseHandoff> {
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout") {
		return requireHandoff(result, phase, iteration, planPath);
	}
	// Prefer the last complete assistant record from the session file, which is
	// authoritative and independent of the live capture that may have raced.
	const recovered = await readLatestAssistantText(sessionPath);
	if (recovered) {
		const parsed = parseHandoff(recovered, phase, iteration);
		if (parsed) return parsed;
	}
	return requireHandoff(result, phase, iteration, planPath);
}

export function validateAuthoringHandoff(handoff: PhaseHandoff): void {
	if (handoff.testStage !== "authoring") throw new Error("Tester authoring handoff must declare testStage=authoring");
	if (!handoff.testStrategy) throw new Error("Tester authoring handoff must include a testStrategy");
	if (!handoff.artifacts.some((artifact) => /test|spec/i.test(artifact.path))) {
		throw new Error("Tester authoring handoff must list at least one authored test artifact");
	}
}

export function validateVerificationHandoff(handoff: PhaseHandoff): void {
	if (handoff.testStage !== "verification") throw new Error("Tester verification handoff must declare testStage=verification");
	if (handoff.status !== "pass" && handoff.status !== "fail") {
		throw new Error("Tester verification handoff must include status=pass or status=fail");
	}
	if (!handoff.testRuns || handoff.testRuns.length === 0) {
		throw new Error("Tester verification handoff must include captured testRuns");
	}
	const ids = (handoff.issues || []).map((issue) => issue.id);
	if (new Set(ids).size !== ids.length) {
		throw new Error("Tester verification issues must have unique stable ids");
	}
}

export function isVerificationHandoff(handoff: PhaseHandoff): boolean {
	return handoff.phase === "test" && handoff.testStage === "verification";
}

export function latestVerification(state: WorkflowState): PhaseHandoff | undefined {
	return [...state.handoffs].reverse().find(isVerificationHandoff);
}

export function detectPlateau(state: WorkflowState): boolean {
	const currentCycle = state.iterationCycle || 0;
	const testHandoffs = state.handoffs.filter(
		(handoff) => isVerificationHandoff(handoff) && (handoff.iterationCycle || 0) === currentCycle,
	);
	if (testHandoffs.length < 2) return false;

	const last = testHandoffs[testHandoffs.length - 1];
	const previous = testHandoffs[testHandoffs.length - 2];
	const lastIssues = last.issues || [];
	const previousIssues = previous.issues || [];

	// A repeated failure count is not enough to prove that the builder made no
	// progress: two runs can fail the same number of tests for different
	// reasons. Also, infrastructure/tooling failures may have no actionable
	// issue list at all. Only stop early when the same actionable issues are
	// reported consecutively.
	if (lastIssues.length === 0 || previousIssues.length === 0) return false;
	const fingerprint = (issues: TestIssue[]) =>
		issues
			.map((issue) =>
				[
					issue.severity,
					issue.test,
					issue.description,
					issue.details || "",
					issue.location || "",
					issue.expectedBehavior || "",
					issue.actualBehavior || "",
				]
					.join("|")
					.replace(/\s+/g, " ")
					.trim()
					.toLowerCase(),
			)
			.sort()
			.join("\n");

	return fingerprint(lastIssues) === fingerprint(previousIssues);
}
