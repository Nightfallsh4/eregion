import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildQualitySetupTask, QUALITY_CONFIG_PATH, readQualityConfig } from "../extensions/eregion/one-for-all/quality.js";

function withProfile(profile: unknown, assertion: (cwd: string) => void): void {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-quality-profile-"));
	try {
		if (profile !== undefined) {
			const profilePath = path.join(cwd, QUALITY_CONFIG_PATH);
			fs.mkdirSync(path.dirname(profilePath), { recursive: true });
			fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
		}
		assertion(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("quality setup task configures a visible, in-session project quality profile", () => {
	const task = buildQualitySetupTask(false);
	assert.match(task, /current session/);
	assert.match(task, /do not delegate it to a background\/subagent session/);
	assert.match(task, /\.pi[\\/]quality\.json/);
	assert.match(task, /"commands"/);
	assert.match(task, /"required"/);
});

test("forced quality setup tells the current-session agent it may replace an existing profile", () => {
	assert.match(buildQualitySetupTask(true), /Replace the existing quality setup/);
});

test("reads configured required quality commands", () => {
	withProfile({
		commands: { lint: "npm run lint", unit: "npm test", format: "npm run format:check" },
		required: ["lint", "unit"],
	}, (cwd) => {
		assert.deepEqual(readQualityConfig(cwd), {
			commands: { lint: "npm run lint", unit: "npm test", format: "npm run format:check" },
			required: ["lint", "unit"],
			timeoutMs: 1_500_000,
		});
	});
});

test("rejects a missing quality profile with setup instructions", () => {
	withProfile(undefined, (cwd) => {
		assert.throws(() => readQualityConfig(cwd), /Run \/pbt-lint-setup first.*\.pi[\\/]quality\.json/i);
	});
});

test("rejects required quality commands that are missing or duplicated", () => {
	withProfile({ commands: { lint: "npm run lint" }, required: ["lint", "unit"] }, (cwd) => {
		assert.throws(() => readQualityConfig(cwd), /required command.*unit/i);
	});
	withProfile({ commands: { lint: "npm run lint" }, required: ["lint", "lint"] }, (cwd) => {
		assert.throws(() => readQualityConfig(cwd), /duplicate/i);
	});
});

test("rejects an empty required quality command list", () => {
	withProfile({ commands: { lint: "npm run lint" }, required: [] }, (cwd) => {
		assert.throws(() => readQualityConfig(cwd), /non-empty.*required/i);
	});
});
