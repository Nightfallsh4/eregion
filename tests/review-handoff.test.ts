import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReviewHandoff } from "../extensions/eregion/one-for-all/handoffs.js";
import type { PhaseHandoff } from "../extensions/eregion/one-for-all/types.js";

function handoff(overrides: Partial<PhaseHandoff> = {}): PhaseHandoff {
	return {
		phase: "review",
		iteration: 1,
		summary: "Reviewed plan and diff",
		artifacts: [],
		decisions: [],
		status: "pass",
		testRuns: [{ command: "npm test", exitCode: 0, stdout: "ok", stderr: "" }],
		reviewedAcceptanceCriteria: ["Feature works"],
		gitDiffSummary: "src/feature.ts | 1 +",
		commitSha: "abcdef1",
		completedAt: 1,
		...overrides,
	};
}

test("requires evidence, successful quality runs, and a commit for a passing review", () => {
	assert.doesNotThrow(() => validateReviewHandoff(handoff()));
	assert.throws(() => validateReviewHandoff(handoff({ reviewedAcceptanceCriteria: [] })), /acceptance/i);
	assert.throws(() => validateReviewHandoff(handoff({ gitDiffSummary: undefined })), /diff/i);
	assert.throws(() => validateReviewHandoff(handoff({ commitSha: undefined })), /commit/i);
	assert.throws(() => validateReviewHandoff(handoff({ testRuns: [{ command: "npm test", exitCode: 1, stdout: "", stderr: "fail" }] })), /successful/i);
});

test("requires stable issues on a failed review but does not require a commit", () => {
	const failed = handoff({ status: "fail", commitSha: undefined, issues: [{ id: "review-1", description: "Missing test", test: "tests/x.test.ts", severity: "error" }] });
	assert.doesNotThrow(() => validateReviewHandoff(failed));
	assert.throws(() => validateReviewHandoff({ ...failed, issues: [] }), /issue/i);
});
