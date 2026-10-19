import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildProjectSetupTask, findProjectSetupContext } from "../extensions/eregion/one-for-all/project-setup.js";

function withProjectDirectory(assertion: (cwd: string) => void): void {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-project-setup-"));
	try {
		assertion(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("discovers bounded root project briefs while prioritising agent instructions", () => {
	withProjectDirectory((cwd) => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Build a privacy-first expense tracker.", "utf8");
		fs.writeFileSync(path.join(cwd, "claude.MD"), "It needs an offline mode.", "utf8");
		fs.writeFileSync(path.join(cwd, "BUILD_BRIEF"), "The first users are freelancers.", "utf8");
		fs.writeFileSync(path.join(cwd, "NOTES.txt"), "Avoid a complex admin portal.", "utf8");
		fs.writeFileSync(path.join(cwd, "overview.md"), "No admin portal is needed.", "utf8");
		fs.writeFileSync(path.join(cwd, ".env"), "SECRET=do-not-share", "utf8");
		fs.writeFileSync(path.join(cwd, "id_rsa"), "PRIVATE KEY do-not-share", "utf8");
		fs.writeFileSync(path.join(cwd, "binary.md"), Buffer.from([0x66, 0x00, 0x6f]));
		fs.writeFileSync(path.join(cwd, "oversized.txt"), "x".repeat(128_000), "utf8");
		fs.mkdirSync(path.join(cwd, "node_modules"));
		fs.writeFileSync(path.join(cwd, "node_modules", "ignored.md"), "Do not read me.", "utf8");
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.writeFileSync(path.join(cwd, ".git", "ignored.md"), "Do not read me.", "utf8");

		const context = findProjectSetupContext(cwd);

		assert.deepEqual(context.map((entry) => entry.path), ["AGENTS.md", "claude.MD", "BUILD_BRIEF", "NOTES.txt", "overview.md"]);
		assert.deepEqual(context.map((entry) => entry.content), [
			"Build a privacy-first expense tracker.",
			"It needs an offline mode.",
			"The first users are freelancers.",
			"Avoid a complex admin portal.",
			"No admin portal is needed.",
		]);
	});
});

test("renders an undecided setup task that requires interactive stack selection and workflow readiness", () => {
	const task = buildProjectSetupTask("", [{ path: "AGENTS.md", content: "Build an inventory tool." }]);

	assert.match(task, /current session/i);
	assert.match(task, /brainstorming skill/i);
	assert.match(task, /clarify tool/i);
	assert.match(task, /initiali[sz]e Git/i);
	assert.match(task, /project-local.*dependenc/i);
	assert.match(task, /format.*lint.*type-check.*test.*build/is);
	assert.match(task, /\.pi[\\/]quality\.json/);
	assert.match(task, /PBT.*DPBT.*just-build/is);
	assert.match(task, /AGENTS\.md/);
	assert.match(task, /Build an inventory tool\./);
	assert.doesNotMatch(task, /React|Vite|Express|Python/i);
});

test("preserves an explicit project description without choosing its framework", () => {
	const task = buildProjectSetupTask("Create a local command-line music library manager.", []);

	assert.match(task, /Create a local command-line music library manager\./);
	assert.match(task, /material stack choices/i);
	assert.doesNotMatch(task, /React|Vite|Express|Python/i);
});

test("user documentation explains framework-agnostic project setup", () => {
	const readme = fs.readFileSync("README.md", "utf8");
	const extensionDocs = fs.readFileSync("extensions/eregion/one-for-all/docs.md", "utf8");

	for (const document of [readme, extensionDocs]) {
		assert.match(document, /\/project-setup \[description\]/);
		assert.match(document, /framework-agnostic/i);
		assert.match(document, /brainstorming.*clarify/is);
		assert.match(document, /\.pi[\\/]quality\.json/);
	}
});
