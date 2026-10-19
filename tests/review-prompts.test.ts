import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInitialBuildTask, buildReviewBuildTask } from "../extensions/eregion/one-for-all/prompts.js";
import type { PhaseHandoff } from "../extensions/eregion/one-for-all/types.js";

const plan: PhaseHandoff = {
	phase: "plan",
	iteration: 1,
	summary: "Review workflow plan",
	artifacts: [],
	decisions: [],
	completedAt: 1,
};

test("review workflow Builder prompt requires TDD, test ownership, and no commit", () => {
	const prompt = buildReviewBuildTask("Add profiles", "acache/plans/plan-profiles.md", plan, 1);
	assert.match(prompt, /superpowers:test-driven-development/i);
	assert.match(prompt, /create or update.*test/i);
	assert.match(prompt, /run.*test/i);
	assert.match(prompt, /do not.*commit/i);
});

test("ordinary PBT Builder prompt retains independent Tester ownership", () => {
	const prompt = buildInitialBuildTask("Add profiles", "acache/plans/builder-plan-profiles.md", plan, 1);
	assert.match(prompt, /Do not modify tests/i);
	assert.doesNotMatch(prompt, /superpowers:test-driven-development/i);
});
