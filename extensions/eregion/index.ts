/**
 * eregion package entrypoint.
 *
 * A single package entrypoint prevents collisions when the package is installed
 * globally and a project also has local resources. Agents and workflow
 * definitions are resolved from this package, with project-local overrides.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import oneForAll from "./one-for-all/index.js";
import clarify from "./clarify/index.js";
import openRouterDynamicModels from "./openrouter-dynamic-models/index.js";
import guardrails from "./global/guardrails.js";
import piAscii from "./global/pi-ascii.js";
import planOnly from "./global/plan-only.js";
import sessionDefaultModel from "./global/session-default-model.js";
import { missingGlobalExtensionNames, missingPackageExtensionNames, missingSkillPaths } from "./resources.js";

export default function eregion(pi: ExtensionAPI): void {
	// Global installs may still leave an older project-local copy behind. In that
	// case the package entrypoint must not register its equivalent again.
	const projectExtensions = new Set(missingPackageExtensionNames(process.cwd()));
	if (projectExtensions.has("one-for-all")) oneForAll(pi);
	if (projectExtensions.has("clarify")) clarify(pi);
	if (projectExtensions.has("openrouter-dynamic-models")) openRouterDynamicModels(pi);

	const missing = new Set(missingGlobalExtensionNames(process.cwd()));
	if (missing.has("guardrails")) guardrails(pi);
	if (missing.has("pi-ascii")) piAscii(pi);
	if (missing.has("plan-only")) planOnly(pi);
	if (missing.has("session-default-model")) sessionDefaultModel(pi);

	// Skills need name-aware fallback handling: package manifests are loaded
	// before the extension can inspect project/global skills, which would make a
	// bundled pbt skill report a collision with pi-playground/.pi/skills/pbt.
	// Add only the bundled skills whose names are not already available.
	pi.on("resources_discover", (event) => ({
		skillPaths: missingSkillPaths(event.cwd),
	}));
}
