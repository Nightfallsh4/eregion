import assert from "node:assert/strict";
import { test } from "node:test";
import { validateVerificationHandoff } from "../extensions/eregion/one-for-all/handoffs.js";
import { buildInitialBuildTask, buildTestAuthoringTask, buildTestVerificationTask } from "../extensions/eregion/one-for-all/prompts.js";
import type { PhaseHandoff } from "../extensions/eregion/one-for-all/types.js";

const builderPath = "BUILDER_ONLY.md";
const testerPath = "TESTER_ONLY.md";
const plan: PhaseHandoff = { phase: "plan", iteration: 1, summary: "plans", artifacts: [], decisions: [], completedAt: 1 };
const build: PhaseHandoff = { phase: "build", iteration: 1, summary: "built", artifacts: [], decisions: [], completedAt: 1 };
const author: PhaseHandoff = { phase: "test", testStage: "authoring", iteration: 1, summary: "tests", testStrategy: "coverage", artifacts: [], decisions: [], completedAt: 1 };

test("build and test prompts expose only their own plan", () => {
	assert.match(buildInitialBuildTask("request", builderPath, plan, 1), /BUILDER_ONLY/);
	assert.doesNotMatch(buildInitialBuildTask("request", builderPath, plan, 1), /TESTER_ONLY/);
	const authoring = buildTestAuthoringTask("request", testerPath, plan, 1);
	assert.match(authoring, /TESTER_ONLY/);
	assert.doesNotMatch(authoring, /BUILDER_ONLY/);
	const verification = buildTestVerificationTask("request", testerPath, build, author, 1, [], undefined);
	assert.match(verification, /TESTER_ONLY/);
	assert.doesNotMatch(verification, /BUILDER_ONLY/);
});

test("passing verification requires cleared tester-plan conditions", () => {
	const verification: PhaseHandoff = { ...author, testStage: "verification", status: "pass", testRuns: [{ command: "bun test", exitCode: 0, stdout: "", stderr: "" }] };
	assert.throws(() => validateVerificationHandoff(verification), /clearance/i);
	const cleared = { ...verification, testerPlanClearance: [{ id: "scenario-1", status: "passed" as const, evidence: "bun test passed" }] };
	assert.doesNotThrow(() => validateVerificationHandoff(cleared));
	assert.throws(
		() => validateVerificationHandoff({ ...cleared, testRuns: [{ command: "bun test", exitCode: 1, stdout: "", stderr: "failing test" }] }),
		/successful.*test run|exit code/i,
	);
});
