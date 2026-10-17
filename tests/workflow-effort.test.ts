import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getSubagentEffort, resolveSubagentEfforts } from "../extensions/eregion/one-for-all/subagent.js";
import { loadWorkflowDefinitions } from "../extensions/eregion/one-for-all/workflows.js";

test("bundled workflows configure high effort for every subagent by default", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-workflow-effort-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const definitions = loadWorkflowDefinitions(cwd);
	for (const definition of definitions) {
		assert.equal(definition.efforts?.default, "high", `${definition.id} should default to high effort`);
	}
});

test("workflow effort configuration supports role and phase overrides", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-workflow-effort-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const workflowDirectory = path.join(cwd, ".pi", "workflows");
	fs.mkdirSync(workflowDirectory, { recursive: true });
	fs.writeFileSync(path.join(workflowDirectory, "pbt-simple.json"), JSON.stringify({
		name: "pbt-simple",
		workflow: "pbt",
		runner: "pbt",
		efforts: { default: "low", planner: "xhigh" },
		build: { effort: "max" },
	}));

	const definition = loadWorkflowDefinitions(cwd).find((candidate) => candidate.id === "pbt-simple")!;
	assert.deepEqual(definition.efforts, { default: "low", planner: "xhigh", builder: "max" });
	assert.equal(definition.models?.planner, "openai/gpt-6.1-sol", "project overrides retain bundled model defaults");
	assert.deepEqual(resolveSubagentEfforts(definition.efforts), {
		designer: "low",
		planner: "xhigh",
		builder: "max",
		tester: "low",
		documentation: "low",
	});
});

test("environment effort overrides take precedence and invalid values preserve the high default", () => {
	const roleKey = "PBT_FLOW_EFFORT_BUILDER";
	const globalKey = "PBT_FLOW_EFFORT";
	const previousRole = process.env[roleKey];
	const previousGlobal = process.env[globalKey];
	try {
		delete process.env[roleKey];
		delete process.env[globalKey];
		assert.equal(getSubagentEffort({}, "builder"), "high");
		process.env[globalKey] = "medium";
		assert.equal(getSubagentEffort({}, "builder"), "medium");
		process.env[roleKey] = "xhigh";
		assert.equal(getSubagentEffort({ builder: "low" }, "builder"), "xhigh");
		process.env[roleKey] = "not-an-effort";
		process.env[globalKey] = "also-invalid";
		assert.equal(getSubagentEffort({}, "builder"), "high");
	} finally {
		if (previousRole === undefined) delete process.env[roleKey];
		else process.env[roleKey] = previousRole;
		if (previousGlobal === undefined) delete process.env[globalKey];
		else process.env[globalKey] = previousGlobal;
	}
});
