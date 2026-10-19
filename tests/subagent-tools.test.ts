import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { test } from "node:test";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { buildPiSubagentArgs, resolveSubagentTools, SUBAGENT_ROLES } = await jiti.import<typeof import("../extensions/eregion/one-for-all/subagent.ts")>(
	"../extensions/eregion/one-for-all/subagent.ts",
	{ default: false },
);

test("preserves requested tools and exposes web search to every subagent", () => {
	assert.deepEqual(resolveSubagentTools(["read", "bash"]), [
		"read",
		"bash",
		"web_search",
		"url_context",
	]);
});

test("does not duplicate web-search tools already requested by a workflow", () => {
	assert.deepEqual(resolveSubagentTools(["read", "web_search", "url_context"]), [
		"read",
		"web_search",
		"url_context",
	]);
});

test("includes the Reviewer in the supported subagent roles", () => {
	assert.ok(SUBAGENT_ROLES.includes("reviewer"));
});

test("starts a plan-only Reviewer with the explicit final-commit exception", () => {
	const args = buildPiSubagentArgs({
		agentPath: "agents/reviewer.md",
		effort: "high",
		tools: ["read", "bash"],
		task: "Review the change",
		planOnly: true,
		reviewerCommitException: true,
	});
	assert.ok(args.includes("--plan-only"));
	assert.deepEqual(args.slice(-5), ["--tools", "read,bash,web_search,url_context", "Task: Review the change", "--plan-only", "--reviewer-commit-exception"]);
});
