import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { missingSkillPaths } from "../extensions/eregion/resources.js";

test("discovers the bundled Worktrunk skill when no higher-priority copy exists", () => {
	const expected = path.resolve(import.meta.dirname, "..", "skills", "using-worktrunk");
	assert.ok(missingSkillPaths(process.cwd()).includes(expected));
});
