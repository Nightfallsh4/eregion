import assert from "node:assert/strict";
import { test } from "node:test";
import { runReviewWorkflow } from "../extensions/eregion/one-for-all/review-orchestrator.js";

test("exports the dedicated PBR/DPBR review orchestrator", () => {
	assert.equal(typeof runReviewWorkflow, "function");
});
