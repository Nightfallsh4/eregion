/**
 * Shared type definitions for the One For All extension.
 *
 * The handoff, state, and progress shapes here are workflow-agnostic: any
 * plan/build/test-style orchestrator can reuse them for structured handoffs
 * between subagent sessions.
 */

import type { ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface ArtifactEntry {
	path: string;
	description: string;
	action: "created" | "modified" | "deleted";
}

/** The two role-specific plan artifacts reserved for one PBT/DPBT run. */
export interface PlanPaths {
	builderPlanPath: string;
	testerPlanPath: string;
}

export interface DecisionEntry {
	decision: string;
	rationale: string;
}

export interface TestIssue {
	id: string;
	description: string;
	test: string;
	severity: "error" | "warning";
	details?: string;
	/** Optional code location (file path, line, or function) related to the issue. */
	location?: string;
	/** What the test expects to happen. */
	expectedBehavior?: string;
	/** What actually happened when the test ran. */
	actualBehavior?: string;
	/** Excerpt from test stdout/stderr that explains the failure. */
	relevantOutput?: string;
	/** Which workflow agent owns the correction, when the tester can determine it. */
	owner?: "builder" | "tester" | "environment";
}

export interface TesterPlanCondition {
	id: string;
	status: "passed" | "failed" | "blocked";
	evidence: string;
}

export interface TestRun {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface QualityProfile {
	commands: Record<string, string>;
	required: string[];
}

export interface QualityRun extends TestRun {
	/** Name of the command in `.pi/quality.json`, for example `lint` or `unit`. */
	name: string;
	stage: "build" | "test-authoring" | "test-verification" | "review" | "final-review";
	iteration: number;
	attempt: number;
	completedAt: number;
	/** Budget cycle that produced this quality result; absent on older runs (cycle 0). */
	iterationCycle?: number;
}

/** @deprecated Use QualityRun. Retained temporarily for persisted lint-only state. */
export type LintRun = QualityRun;

export interface IssueResolution {
	issueId: string;
	status: "fixed" | "unresolved";
	summary: string;
}

export interface IssueLedgerEntry {
	issue: TestIssue;
	status: "pending" | "in-progress" | "fixed" | "unresolved";
	attempts: number;
	lastAction?: string;
	updatedAt: number;
}

export interface ClarificationQuestion {
	id: string;
	question: string;
	whyItMatters: string;
	options?: string[];
	allowFreeform: boolean;
}

export interface ClarificationRequest {
	phase: "design" | "plan";
	type: "clarification_request";
	questions: ClarificationQuestion[];
}

export interface PhaseHandoff {
	phase: "design" | "plan" | "build" | "test" | "review" | "documentation";
	iteration: number;
	summary: string;
	artifacts: ArtifactEntry[];
	decisions: DecisionEntry[];
	metrics?: Record<string, number>;
	/** Legacy single-plan field retained while old persisted handoffs remain readable. */
	planPath?: string;
	builderPlanPath?: string;
	testerPlanPath?: string;
	assumptions?: string[];
	testStage?: "authoring" | "verification" | "repair";
	buildStage?: "issue-fix" | "completed";
	testRuns?: TestRun[];
	issueUpdates?: IssueResolution[];
	testStrategy?: string;
	testerPlanClearance?: TesterPlanCondition[];
	status?: "pass" | "fail";
	issues?: TestIssue[];
	/** Review-only evidence that each Builder-plan criterion was assessed. */
	reviewedAcceptanceCriteria?: string[];
	/** Review-only concise result of the Reviewer-owned Git diff inspection. */
	gitDiffSummary?: string;
	/** Commit created by a passing Reviewer after all review checks pass. */
	commitSha?: string;
	completedAt: number;
	/** Iteration budget cycle used to distinguish a reset/resumed run from older handoffs. */
	iterationCycle?: number;
}

export interface WorkflowAnswer {
	questionId: string;
	answer: string;
	wasCustom: boolean;
	unresolved?: boolean;
	round: number;
}

export interface AgentWorkflowStatus {
	status: "waiting" | "working" | "completed" | "failed";
	phase: string;
	activity: string;
	updatedAt: number;
}

export interface DesignFeedback {
	id: string;
	comment: string;
	/** All annotated elements selected for this comment; absent means general feedback. */
	elements?: string[];
	page?: string;
	createdAt: number;
}

/** DPBT's isolated, user-approved design-review record. */
export interface DesignReviewState {
	previewDir: string;
	decisionPath: string;
	status: "drafting" | "awaiting-review" | "revising" | "approved";
	revision: number;
	feedback: DesignFeedback[];
	consumedFeedbackIds?: string[];
	approvedAt?: number;
	previewUrl?: string;
	/** Records the one automatic browser launch for the initial mockup. */
	previewOpenedAt?: number;
	designHandoff?: PhaseHandoff;
}

export interface WorkflowState {
	/** Stable workflow runner namespace, for example `pbt`. */
	workflowName: string;
	/** Catalog entry that created this run, for example `pbt-simple`. */
	workflowId?: string;
	request: string;
	runId: string;
	/** Legacy single-plan path retained so older persisted runs can be migrated. */
	planPath: string;
	builderPlanPath?: string;
	testerPlanPath?: string;
	interactive: boolean;
	answers: WorkflowAnswer[];
	questionRounds: number;
	handoffs: PhaseHandoff[];
	iteration: number;
	maxIterations: number;
	/**
	 * Just-build (`/b`) runs have one implementation turn rather than a
	 * build/test iteration loop. This limits the number of quality-repair turns
	 * the same persistent Builder may receive after that turn.
	 */
	maxLintRepairs?: number;
	/** Increments when a maxed-out run is resumed with a fresh iteration budget. */
	iterationCycle?: number;
	status:
		| "running"
		| "awaiting-clarification"
		| "awaiting-design-review"
		| "completed"
		| "max-iterations-reached"
		| "plateau-reached"
		| "failed"
		| "aborted";
	phase?: string;
	currentAgent?: string;
	currentActivity?: string;
	/** Latest status for each persistent planner/builder/tester session. */
	agentStatuses?: Record<string, AgentWorkflowStatus>;
	lastEventAt?: number;
	eventCount?: number;
	activityLogPath?: string;
	latestOutput?: string;
	failureReason?: string;
	stopReason?: "plateau" | "max-iterations" | "error" | "aborted";
	startedAt: number;
	completedAt: number | null;
	/** Absolute path to the parent pi session file that started this workflow. */
	parentSessionPath?: string;
	/** Issue-by-issue durable progress for the current failed verification. */
	issueLedger?: IssueLedgerEntry[];
	/** completedAt of the verification that populated issueLedger. */
	issueLedgerVerificationAt?: number;
	/** Number of times this persisted run has been resumed. */
	resumeCount?: number;
	/** Present only for Design → Plan → Build → Test runs. */
	design?: DesignReviewState;
	lastResumedAt?: number;
	/** Resolved provider/model per subagent role (planner/designer/builder/tester) for this run. */
	agentModels?: Record<string, string>;
	/** Resolved Pi thinking/reasoning level per subagent role for this run. */
	agentEfforts?: Record<string, string>;
	/** Whether this run must finish with the optional documentation maintenance phase. */
	documentationRequested?: boolean;
	/** Project quality profile captured before the workflow starts. */
	qualityProfile?: QualityProfile;
	/** Every required quality command run, including failed repair attempts. */
	qualityRuns?: QualityRun[];
	/** Commit SHA reported by a passing Reviewer and independently verified by the orchestrator. */
	reviewCommitSha?: string;
	/** @deprecated Legacy lint-only state retained for reading old persisted runs. */
	lintCommand?: string;
	/** @deprecated Legacy lint-only state retained for reading old persisted runs. */
	lintRuns?: LintRun[];
}

export interface ProgressEvent {
	timestamp: number;
	agent: string;
	phase: string;
	kind: "started" | "tool-start" | "tool-end" | "assistant" | "stderr" | "completed" | "failed";
	message: string;
	toolName?: string;
	details?: string;
}

export interface AgentResult {
	exitCode: number;
	output: string;
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface RunControl {
	state: WorkflowState;
	controller: AbortController;
	context: ExtensionContext | ExtensionCommandContext;
}
