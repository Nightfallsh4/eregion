import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDocumentationTask } from "../extensions/eregion/one-for-all/prompts.js";

test("documentation phase confines changes to a concise structured docs directory", () => {
	const task = buildDocumentationTask("Add saved searches", [], false);
	assert.match(task, /Documentation root: docs\//);
	assert.match(task, /Update only docs\//);
	assert.match(task, /docs\/README\.md/);
	assert.match(task, /features\//);
	assert.match(task, /technical\//);
	assert.match(task, /decisions\//);
	assert.match(task, /obsolete, duplicate, empty/);
});

test("manual documentation pass stays in the invoking session and targets the current project", () => {
	const task = buildDocumentationTask("Project-wide documentation maintenance", [], true);
	assert.match(task, /project in the current working directory/i);
	assert.match(task, /do not delegate.*background process or subagent/i);
	assert.match(task, /not Pi or its coding-agent harness/i);
	assert.match(task, /Do not look up, read, summarize, or modify Pi CLI\/SDK\/extension\/skill documentation/i);
	assert.match(task, /docs\/ in the current project/i);
	assert.match(task, /No workflow handoffs are available/);
});
