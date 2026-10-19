import assert from "node:assert/strict";
import { test } from "node:test";
import { isReviewerCommitCommand } from "../extensions/eregion/global/plan-only.js";

test("permits only exact Git staging and commit commands for the Reviewer exception", () => {
	assert.equal(isReviewerCommitCommand("git add -- src/a.ts && git commit -m 'review: approve'", true), true);
	assert.equal(isReviewerCommitCommand("git commit -m review", true), false);
	assert.equal(isReviewerCommitCommand("git add src/a.ts && rm -rf tmp", true), false);
	assert.equal(isReviewerCommitCommand("git add src/a.ts && git commit -m review", false), false);
});
