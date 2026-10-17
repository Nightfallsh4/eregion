import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { releasePlanReservations, reservePlanPaths } from "../extensions/eregion/one-for-all/plan-paths.js";
import { assertPlanOutputsExist } from "../extensions/eregion/one-for-all/state.js";
import type { PlanPaths } from "../extensions/eregion/one-for-all/types.js";

function temporaryProject(t: { after(fn: () => void): void }): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-plan-paths-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function writePlanPair(cwd: string, paths: PlanPaths): void {
	for (const planPath of [paths.builderPlanPath, paths.testerPlanPath]) {
		const absolute = path.join(cwd, planPath);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, "# Plan\n");
	}
}

test("reserves collision-safe builder and tester plan paths as one pair", (t) => {
	const cwd = temporaryProject(t);
	const first = reservePlanPaths(cwd, "Build account settings");
	assert.deepEqual(first, {
		builderPlanPath: "acache/plans/builder-plan-account-settings.md",
		testerPlanPath: "acache/plans/tester-plan-account-settings.md",
	});
	assert.ok(fs.existsSync(path.join(cwd, first.builderPlanPath)));
	assert.ok(fs.existsSync(path.join(cwd, first.testerPlanPath)));

	fs.unlinkSync(path.join(cwd, first.testerPlanPath));
	const second = reservePlanPaths(cwd, "Build account settings");
	assert.deepEqual(second, {
		builderPlanPath: "acache/plans/builder-plan-account-settings-2.md",
		testerPlanPath: "acache/plans/tester-plan-account-settings-2.md",
	});

	fs.unlinkSync(path.join(cwd, first.builderPlanPath));
	fs.unlinkSync(path.join(cwd, second.builderPlanPath));
	fs.unlinkSync(path.join(cwd, second.testerPlanPath));
	releasePlanReservations(cwd, first);
	releasePlanReservations(cwd, second);
	const recycled = reservePlanPaths(cwd, "Build account settings");
	assert.deepEqual(recycled, first);
});

test("accepts only distinct non-empty plan files in acache/plans", (t) => {
	const cwd = temporaryProject(t);
	const paths: PlanPaths = {
		builderPlanPath: "acache/plans/builder-plan-feature.md",
		testerPlanPath: "acache/plans/tester-plan-feature.md",
	};
	writePlanPair(cwd, paths);
	assert.doesNotThrow(() => assertPlanOutputsExist(cwd, paths));

	fs.writeFileSync(path.join(cwd, paths.testerPlanPath), "");
	assert.throws(() => assertPlanOutputsExist(cwd, paths), /non-empty/i);
	fs.writeFileSync(path.join(cwd, paths.testerPlanPath), "# Tester plan\n");

	fs.rmSync(path.join(cwd, paths.builderPlanPath));
	fs.mkdirSync(path.join(cwd, paths.builderPlanPath));
	assert.throws(() => assertPlanOutputsExist(cwd, paths), /regular file/i);
	fs.rmSync(path.join(cwd, paths.builderPlanPath), { recursive: true });
	fs.writeFileSync(path.join(cwd, paths.builderPlanPath), "# Builder plan\n");

	assert.throws(
		() => assertPlanOutputsExist(cwd, { ...paths, testerPlanPath: "outside-plan.md" }),
		/acache[\\/]plans/i,
	);
	assert.throws(
		() => assertPlanOutputsExist(cwd, { ...paths, testerPlanPath: paths.builderPlanPath }),
		/distinct/i,
	);
});
