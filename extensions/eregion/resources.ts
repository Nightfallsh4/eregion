import * as fs from "node:fs";
import * as path from "node:path";
import { packagePath } from "./package-paths.js";

const GLOBAL_EXTENSION_FILES: Record<string, string[]> = {
	"guardrails": ["extensions/guardrails/index.ts", "extensions/guardrails.ts"],
	"pi-ascii": ["extensions/pi-ascii.ts"],
	"plan-only": ["extensions/plan-only.ts"],
	"session-default-model": ["extensions/session-default-model.ts"],
};

function exists(filePath: string): boolean {
	try {
		return fs.existsSync(filePath);
	} catch {
		return false;
	}
}

function globalAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || process.cwd(), ".pi", "agent");
}

function globalSkillsDir(): string {
	return path.join(process.env.HOME || process.cwd(), ".agents", "skills");
}

function globalExtensionExists(name: string): boolean {
	const globalRoot = globalAgentDir();
	return (GLOBAL_EXTENSION_FILES[name] || []).some((relative) => exists(path.join(globalRoot, relative)));
}

function projectExtensionExists(cwd: string, name: string): boolean {
	const projectRoot = path.join(cwd, ".pi", "extensions");
	return (GLOBAL_EXTENSION_FILES[name] || []).some((relative) => exists(path.join(projectRoot, relative)));
}

const PACKAGE_EXTENSION_FILES: Record<string, string[]> = {
	"one-for-all": ["one-for-all/index.ts"],
	"clarify": ["clarify/index.ts"],
	"openrouter-dynamic-models": ["openrouter-dynamic-models/index.ts"],
};

/** Return bundled global-style extensions that are not already installed. */
export function missingGlobalExtensionNames(cwd: string): string[] {
	return Object.keys(GLOBAL_EXTENSION_FILES)
		.filter((name) => !globalExtensionExists(name) && !projectExtensionExists(cwd, name));
}

/** Return package extensions that are not left over as project-local copies. */
export function missingPackageExtensionNames(cwd: string): string[] {
	const projectRoot = path.join(cwd, ".pi", "extensions");
	return Object.keys(PACKAGE_EXTENSION_FILES)
		.filter((name) => !(PACKAGE_EXTENSION_FILES[name] || []).some((relative) => exists(path.join(projectRoot, relative))));
}

function skillExistsInTree(cwd: string, skillName: string): boolean {
	let directory = path.resolve(cwd);
	while (true) {
		if (exists(path.join(directory, ".agents", "skills", skillName, "SKILL.md"))) return true;
		if (exists(path.join(directory, ".pi", "skills", skillName, "SKILL.md"))) return true;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const agentDir = globalAgentDir();
	return exists(path.join(agentDir, "skills", skillName, "SKILL.md"))
		|| exists(path.join(globalSkillsDir(), skillName, "SKILL.md"));
}

/**
 * Return each bundled skill as an individual path only when no higher-priority
 * copy exists. Individual paths avoid importing the whole fallback directory,
 * which would create collisions for only some skills.
 */
export function missingSkillPaths(cwd: string): string[] {
	const root = packagePath("skills");
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !skillExistsInTree(cwd, entry.name))
		.map((entry) => path.join(root, entry.name));
}

/** Return a bundled theme directory only when the selected names are absent. */
export function missingThemePaths(cwd: string): string[] {
	const projectThemes = path.join(cwd, ".pi", "themes");
	const globalThemes = path.join(globalAgentDir(), "themes");
	const names = ["lotr.json", "retro-gaming-blue.json"];
	return names
		.filter((name) => !exists(path.join(projectThemes, name)) && !exists(path.join(globalThemes, name)))
		.map((name) => packagePath("themes", name));
}
