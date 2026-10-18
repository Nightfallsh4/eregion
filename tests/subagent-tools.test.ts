import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { test } from "node:test";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveSubagentTools } = await jiti.import<typeof import("../extensions/eregion/one-for-all/subagent.ts")>(
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
