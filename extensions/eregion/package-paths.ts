import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

/** Absolute root of the installed eregion package, regardless of install scope. */
export const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PACKAGE_MANIFEST_ROOT = path.resolve(PACKAGE_ROOT, "..");

export function packagePath(...parts: string[]): string {
	return path.join(PACKAGE_ROOT, ...parts);
}

export function projectAgentPath(cwd: string, agentName: string): string {
	const projectPath = path.join(cwd, ".pi", "agents", agentName);
	return requireFileOrPackageFallback(projectPath, packagePath("agents", agentName));
}

export function projectWorkflowsPath(cwd: string): string {
	const projectPath = path.join(cwd, ".pi", "workflows");
	return hasJsonFile(projectPath) ? projectPath : packagePath("workflows");
}

function hasJsonFile(directory: string): boolean {
	try {
		return fs.readdirSync(directory).some((entry: string) => entry.endsWith(".json"));
	} catch {
		return false;
	}
}

function requireFileOrPackageFallback(projectPath: string, packageFile: string): string {
	try {
		if (fs.statSync(projectPath).isFile()) return projectPath;
	} catch {
		// Use the packaged agent definition when the project has no local override.
	}
	return packageFile;
}
