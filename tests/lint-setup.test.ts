import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLintSetupTask } from "../extensions/eregion/one-for-all/lint.js";

test("lint setup task is explicit about in-session setup and PBT configuration", () => {
	const task = buildLintSetupTask(false);
	assert.match(task, /current session/);
	assert.match(task, /do not delegate it to a background\/subagent session/);
	assert.match(task, /\.pi[\\/]lint\.json/);
	assert.match(task, /"command": "npm run lint"/);
});

test("forced lint setup tells the current-session agent it may replace an existing setup", () => {
	assert.match(buildLintSetupTask(true), /Replace the existing lint setup/);
});
