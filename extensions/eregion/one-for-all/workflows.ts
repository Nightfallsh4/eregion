/** Workflow catalog loaded from .pi/workflows/*.json.
 *
 * The catalog is deliberately separate from the PBT implementation: the
 * extension can expose several runnable workflows while PBT remains one
 * workflow among them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, asString, asNumber } from "./util.js";
import { packagePath } from "../package-paths.js";
import { parseSubagentEffort, type SubagentEfforts, type SubagentModels, type SubagentRole } from "./subagent.js";

export interface WorkflowDefinition {
	/** Public name used by /flow and workflow_start. */
	id: string;
	/** State/storage namespace. Variants of a workflow share this namespace. */
	workflowName: string;
	variant?: string;
	description: string;
	runner: "pbt" | "dpbt" | "build";
	interactive: boolean;
	maxIterations: number;
	configPath?: string;
	/** Per-subagent LLM provider/model pins declared by the workflow JSON. */
	models?: SubagentModels;
	/** Per-subagent Pi reasoning levels declared by the workflow JSON. */
	efforts?: SubagentEfforts;
}

const DEFAULT_EFFORTS: SubagentEfforts = { default: "high" };

const FALLBACKS: WorkflowDefinition[] = [
	{
		id: "pbt-simple",
		workflowName: "pbt",
		variant: "simple",
		description: "Plan, build, author tests, and verify with an automatic fix loop.",
		runner: "pbt",
		interactive: false,
		maxIterations: 5,
		efforts: DEFAULT_EFFORTS,
	},
	{
		id: "pbt-interactive",
		workflowName: "pbt",
		variant: "interactive",
		description: "The plan/build/test workflow with planner clarification rounds.",
		runner: "pbt",
		interactive: true,
		maxIterations: 5,
		efforts: DEFAULT_EFFORTS,
	},
	{
		id: "dpbt",
		workflowName: "dpbt",
		variant: "design-review",
		description: "Design an isolated reviewable mockup, get explicit approval, then plan, build, and test.",
		runner: "dpbt",
		interactive: false,
		maxIterations: 5,
		efforts: DEFAULT_EFFORTS,
	},
	{
		id: "dpbt-interactive",
		workflowName: "dpbt",
		variant: "interactive",
		description: "Ask focused product/design questions during design, then review, plan, build, and test.",
		runner: "dpbt",
		interactive: true,
		maxIterations: 5,
		efforts: DEFAULT_EFFORTS,
	},
	{
		id: "b",
		workflowName: "b",
		variant: "just-build",
		description: "Build a focused request, then run required quality-profile commands and return findings to the same Builder session.",
		runner: "build",
		interactive: false,
		maxIterations: 3,
		efforts: DEFAULT_EFFORTS,
	},
];

const PHASE_ROLE_KEYS: Record<string, SubagentRole> = {
	plan: "planner",
	design: "designer",
	build: "builder",
	test: "tester",
	documentation: "documentation",
};

/**
 * Parse the workflow's per-subagent model configuration. Supports the
 * top-level `models` block (`default`/`planner`/`designer`/`builder`/`tester`)
 * plus a per-phase `model` override inside `plan`/`design`/`build`/`test`.
 * Values are `provider/modelId` identifiers or bare `modelId`s resolved at
 * run time against the model registry. Returns undefined when nothing is set.
 */
function parseSubagentModels(value: unknown): SubagentModels | undefined {
	if (!isRecord(value)) return undefined;
	const result: SubagentModels = {};
	const modelConfig = isRecord(value.models) ? value.models : value;
	for (const key of ["default", "planner", "designer", "builder", "tester", "documentation"] as const) {
		const raw = asString(modelConfig[key]);
		if (raw?.trim()) result[key] = raw.trim();
	}
	for (const [phaseKey, role] of Object.entries(PHASE_ROLE_KEYS)) {
		const phase = isRecord(value[phaseKey]) ? value[phaseKey] : undefined;
		const raw = phase ? asString(phase.model) : undefined;
		if (raw?.trim()) result[role] = raw.trim();
	}
	return Object.keys(result).length ? result : undefined;
}

/**
 * Parse `efforts` just like `models`: a default/role map plus a per-phase
 * `effort` override. Invalid levels are ignored so a malformed local override
 * inherits the bundled preset (whose default is high) instead of breaking a
 * workflow command.
 */
function parseSubagentEfforts(value: unknown): SubagentEfforts | undefined {
	if (!isRecord(value)) return undefined;
	const result: SubagentEfforts = {};
	const effortConfig = isRecord(value.efforts) ? value.efforts : value;
	for (const key of ["default", "planner", "designer", "builder", "tester", "documentation"] as const) {
		const effort = parseSubagentEffort(effortConfig[key]);
		if (effort) result[key] = effort;
	}
	for (const [phaseKey, role] of Object.entries(PHASE_ROLE_KEYS)) {
		const phase = isRecord(value[phaseKey]) ? value[phaseKey] : undefined;
		const effort = phase ? parseSubagentEffort(phase.effort) : undefined;
		if (effort) result[role] = effort;
	}
	return Object.keys(result).length ? result : undefined;
}

function definitionFromJson(value: unknown, configPath: string): WorkflowDefinition | null {
	if (!isRecord(value)) return null;
	const id = asString(value.name)?.trim();
	if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
	const workflowName = (asString(value.workflow) || (id.startsWith("pbt") ? "pbt" : id)).trim();
	const runner = (asString(value.runner) || (workflowName === "pbt" || id.startsWith("pbt")
		? "pbt"
		: workflowName === "dpbt" || id.startsWith("dpbt")
			? "dpbt"
			: workflowName === "b" || id === "b" || id === "just-build"
				? "build"
				: "")) as WorkflowDefinition["runner"] | "";
	if (runner !== "pbt" && runner !== "dpbt" && runner !== "build") return null;
	const loop = isRecord(value.loop) ? value.loop : undefined;
	const configuredIterations = loop ? asNumber(loop.maxIterations, 5) : undefined;
	const models = parseSubagentModels(value);
	const efforts = parseSubagentEfforts(value);
	return {
		id,
		workflowName,
		variant: asString(value.variant) || (id.endsWith("-interactive") ? "interactive" : id.endsWith("-simple") ? "simple" : undefined),
		description: asString(value.description) || id,
		runner,
		interactive: value.interactive === true,
		maxIterations: Math.max(1, Math.min(20, Math.floor(configuredIterations || 5))),
		configPath,
		...(models ? { models } : {}),
		...(efforts ? { efforts } : {}),
	};
}

function collectWorkflowDirectory(directory: string): Map<string, WorkflowDefinition> {
	const definitions = new Map<string, WorkflowDefinition>();
	try {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
				const definition = definitionFromJson(parsed, path.join(directory, entry.name));
				if (definition) definitions.set(definition.id, definition);
			} catch {
				// One malformed optional preset should not hide the other workflows.
			}
		}
	} catch {
		// The directory may not exist yet.
	}
	return definitions;
}

/**
 * Load the workflow catalog as a merge of the package's bundled presets and
 * any project-local `.pi/workflows/*.json` overrides.
 *
 * The bundled presets (e.g. `dpbt.json` with its `models` block) always form
 * the baseline. A project may override any fields, but a project override that
 * does not declare its own `models` block inherits the corresponding bundled
 * preset's `models` and `efforts`. This prevents a stale older project copy
 * (which predates per-subagent configuration) from silently shadowing the
 * package's model and high-effort defaults.
 */
export function loadWorkflowDefinitions(cwd: string): WorkflowDefinition[] {
	const byId = collectWorkflowDirectory(packagePath("workflows"));
	const projectDir = path.join(cwd, ".pi", "workflows");
	for (const [id, projectDefinition] of collectWorkflowDirectory(projectDir)) {
		const base = byId.get(id);
		// An override inherits package defaults when it does not specify its own,
		// so editing a preset affects older project-local copies too.
		if (!projectDefinition.models && base?.models) {
			projectDefinition.models = base.models;
		}
		if (!projectDefinition.efforts && base?.efforts) {
			projectDefinition.efforts = base.efforts;
		}
		byId.set(id, projectDefinition);
	}
	for (const fallback of FALLBACKS) if (!byId.has(fallback.id)) byId.set(fallback.id, fallback);
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveWorkflow(cwd: string, requested?: string, interactive?: boolean): WorkflowDefinition | null {
	const definitions = loadWorkflowDefinitions(cwd);
	const name = requested?.trim();
	if (!name || name === "pbt") {
		return definitions.find((definition) => definition.workflowName === "pbt" && definition.interactive === Boolean(interactive))
			|| definitions.find((definition) => definition.workflowName === "pbt" && !definition.interactive)
			|| null;
	}
	if (name === "dpbt") return definitions.find((definition) => definition.workflowName === "dpbt" && definition.interactive === Boolean(interactive))
		|| definitions.find((definition) => definition.workflowName === "dpbt" && !definition.interactive)
		|| null;
	if (name === "b" || name === "just-build") return definitions.find((definition) => definition.runner === "build") || null;
	return definitions.find((definition) => definition.id === name || definition.workflowName === name && definition.interactive === Boolean(interactive)) || null;
}

export function formatWorkflowCatalog(definitions: WorkflowDefinition[]): string[] {
	return definitions.map((definition) => `  ${definition.id}${definition.interactive ? " (interactive)" : ""} — ${definition.description}`);
}
