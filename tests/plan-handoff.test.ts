import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePlanHandoff, validateReviewPlanHandoff } from "../extensions/eregion/one-for-all/handoffs.js";
import { buildPlanRecoveryTask, buildPlanTask } from "../extensions/eregion/one-for-all/prompts.js";
import type { PhaseHandoff, PlanPaths } from "../extensions/eregion/one-for-all/types.js";

const paths: PlanPaths = {
	builderPlanPath: "acache/plans/builder-plan-feature.md",
	testerPlanPath: "acache/plans/tester-plan-feature.md",
};

function handoff(overrides: Partial<PhaseHandoff> = {}): PhaseHandoff {
	return {
		phase: "plan",
		iteration: 1,
		summary: "Paired plans written",
		artifacts: [
			{ path: paths.builderPlanPath, description: "Builder instructions", action: "created" },
			{ path: paths.testerPlanPath, description: "Tester scenarios", action: "created" },
		],
		decisions: [],
		builderPlanPath: paths.builderPlanPath,
		testerPlanPath: paths.testerPlanPath,
		completedAt: 1,
		...overrides,
	};
}

test("validates the exact paired plan paths in a planner handoff", () => {
	assert.doesNotThrow(() => validatePlanHandoff(handoff(), paths));
	assert.throws(() => validatePlanHandoff(handoff({ builderPlanPath: undefined }), paths), /builderPlanPath/i);
	assert.throws(() => validatePlanHandoff(handoff({ builderPlanPath: paths.testerPlanPath, testerPlanPath: paths.builderPlanPath }), paths), /exact/i);
	assert.throws(() => validatePlanHandoff(handoff({ artifacts: [] }), paths), /artifact/i);
});

test("requires a single review-workflow plan handoff with acceptance criteria", () => {
	const reviewPlanPath = "acache/plans/plan-feature.md";
	const reviewHandoff = handoff({
		artifacts: [{ path: reviewPlanPath, description: "Builder plan", action: "created" }],
		builderPlanPath: reviewPlanPath,
		testerPlanPath: undefined,
	});
	assert.doesNotThrow(() => validateReviewPlanHandoff(reviewHandoff, reviewPlanPath));
	assert.throws(() => validateReviewPlanHandoff(reviewHandoff, "acache/plans/other.md"), /exact/i);
	assert.throws(() => validateReviewPlanHandoff({ ...reviewHandoff, artifacts: [] }, reviewPlanPath), /artifact/i);
});

test("planner tasks require only the two role-specific files and support recovery", () => {
	const normal = buildPlanTask("Add profiles", paths, [], false);
	assert.match(normal, /builder-plan-feature\.md/);
	assert.match(normal, /tester-plan-feature\.md/);
	assert.match(normal, /Do not modify production code or tests/i);
	assert.match(normal, /implementation instructions/i);
	assert.match(normal, /test cases.*scenarios/i);

	const recovery = buildPlanRecoveryTask(paths, "Tester plan is missing");
	assert.match(recovery, /Tester plan is missing/);
	assert.match(recovery, /builder-plan-feature\.md/);
	assert.match(recovery, /tester-plan-feature\.md/);
	assert.match(recovery, /Do not modify production code or tests/i);
});
