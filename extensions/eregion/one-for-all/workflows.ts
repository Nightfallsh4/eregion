/** Workflow catalog loaded from .pi/workflows/*.json.
 *
 * The catalog is deliberately separate from the PBT implementation: the
 * extension can expose several runnable workflows while PBT remains one
 * workflow among them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, asString, asNumber } from "./util.js";
import { projectWorkflowsPath } from "../package-paths.js";

export interface WorkflowDefinition {
	/** Public name used by /flow and workflow_start. */
	id: string;
	/** State/storage namespace. Variants of a workflow share this namespace. */
	workflowName: string;
	variant?: string;
	description: string;
	runner: "pbt" | "dpbt";
	interactive: boolean;
	maxIterations: number;
	configPath?: string;
}

const FALLBACKS: WorkflowDefinition[] = [
	{
		id: "pbt-simple",
		workflowName: "pbt",
		variant: "simple",
		description: "Plan, build, author tests, and verify with an automatic fix loop.",
		runner: "pbt",
		interactive: false,
		maxIterations: 5,
	},
	{
		id: "pbt-interactive",
		workflowName: "pbt",
		variant: "interactive",
		description: "The plan/build/test workflow with planner clarification rounds.",
		runner: "pbt",
		interactive: true,
		maxIterations: 5,
	},
	{
		id: "dpbt",
		workflowName: "dpbt",
		variant: "design-review",
		description: "Design an isolated reviewable mockup, get explicit approval, then plan, build, and test.",
		runner: "dpbt",
		interactive: false,
		maxIterations: 5,
	},
	{
		id: "dpbt-interactive",
		workflowName: "dpbt",
		variant: "interactive",
		description: "Ask focused product/design questions during design, then review, plan, build, and test.",
		runner: "dpbt",
		interactive: true,
		maxIterations: 5,
	},
];

function definitionFromJson(value: unknown, configPath: string): WorkflowDefinition | null {
	if (!isRecord(value)) return null;
	const id = asString(value.name)?.trim();
	if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
	const workflowName = (asString(value.workflow) || (id.startsWith("pbt") ? "pbt" : id)).trim();
	const runner = (asString(value.runner) || (workflowName === "pbt" || id.startsWith("pbt") ? "pbt" : workflowName === "dpbt" || id.startsWith("dpbt") ? "dpbt" : "")) as WorkflowDefinition["runner"] | "";
	if (runner !== "pbt" && runner !== "dpbt") return null;
	const loop = isRecord(value.loop) ? value.loop : undefined;
	const configuredIterations = loop ? asNumber(loop.maxIterations, 5) : undefined;
	return {
		id,
		workflowName,
		variant: asString(value.variant) || (id.endsWith("-interactive") ? "interactive" : id.endsWith("-simple") ? "simple" : undefined),
		description: asString(value.description) || id,
		runner,
		interactive: value.interactive === true,
		maxIterations: Math.max(1, Math.min(20, Math.floor(configuredIterations || 5))),
		configPath,
	};
}

export function loadWorkflowDefinitions(cwd: string): WorkflowDefinition[] {
	const directory = projectWorkflowsPath(cwd);
	const definitions: WorkflowDefinition[] = [];
	try {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
				const definition = definitionFromJson(parsed, path.join(directory, entry.name));
				if (definition) definitions.push(definition);
			} catch {
				// One malformed optional preset should not hide the other workflows.
			}
		}
	} catch {
		// The project may not have a workflow catalog yet.
	}
	const result = definitions.length ? definitions : FALLBACKS;
	const byId = new Map(result.map((definition) => [definition.id, definition]));
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
	return definitions.find((definition) => definition.id === name || definition.workflowName === name && definition.interactive === Boolean(interactive)) || null;
}

export function formatWorkflowCatalog(definitions: WorkflowDefinition[]): string[] {
	return definitions.map((definition) => `  ${definition.id}${definition.interactive ? " (interactive)" : ""} — ${definition.description}`);
}
