/**
 * Feature-named plan path reservation.
 *
 * Reserves a deterministic `acache/plans/plan-<slug>.md` path before the planner starts so
 * concurrent runs (in the same process or in separate processes) cannot pick
 * the same filename.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_SLUG_LENGTH } from "./constants.js";
import { ensureDirectory } from "./util.js";
import type { PlanPaths } from "./types.js";

// An in-memory reservation closes the race between two commands started in the
// same pi process. The zero-byte placeholder on disk also reserves the path
// against a second process.
export const reservedPlanPaths = new Set<string>();

const FEATURE_ACTIONS = [
	"add",
	"build",
	"create",
	"design",
	"develop",
	"enable",
	"fix",
	"generate",
	"implement",
	"improve",
	"introduce",
	"make",
	"migrate",
	"refactor",
	"remove",
	"support",
	"update",
	"write",
];
const ACTION_PATTERN = FEATURE_ACTIONS.join("|");
const FEATURE_ACTION_PATTERN = new RegExp(
	`\\b(?:${ACTION_PATTERN}|set\\s+up)\\b\\s+(?:an?\\s+|the\\s+)?(.+?)(?=\\s+(?:and|then)\\s+(?:${ACTION_PATTERN}|set\\s+up)\\b|\\s+(?:at|for|from|in|inside|into|on|to|under|using|via|with|within)\\b|[,:;.!?]|$)`,
	"gi",
);

// Plans should be recognizable at a glance, not be a truncated copy of a
// sentence-length request. Six words still permits names such as
// "real-time-collaborative-whiteboard" while keeping the filename compact.
const MAX_FEATURE_WORDS = 6;
const GENERIC_CONTAINERS = new Set(["directory", "file", "folder", "project", "repository"]);
const FEATURE_NOUNS = new Set([
	"api",
	"app",
	"authentication",
	"command",
	"component",
	"dashboard",
	"endpoint",
	"feature",
	"flag",
	"flow",
	"form",
	"integration",
	"migration",
	"modal",
	"page",
	"service",
	"workflow",
]);

function slugify(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/--([a-z0-9][a-z0-9-]*)/g, "$1")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function featureCandidate(value: string): string {
	// "create a feature called profiles" and "make a directory named docs"
	// name their target after called/named. Keep that target, not its generic
	// container, in the filename.
	const namedTarget = value.match(
		/^(?:an?\s+|the\s+)?(?:feature|component|directory|file|folder|module|project)\s+(?:called|named)\s+(.+)$/i,
	);
	const words = slugify(namedTarget?.[1] ?? value)
		.split("-")
		.filter(Boolean)
		.slice(0, MAX_FEATURE_WORDS);
	return words.join("-");
}

function candidateScore(candidate: string, position: number): number {
	const words = candidate.split("-").filter(Boolean);
	if (!words.length) return Number.NEGATIVE_INFINITY;

	let score = words.length;
	if (words.some((word) => FEATURE_NOUNS.has(word))) score += 10;
	if (GENERIC_CONTAINERS.has(words[0])) score -= 10;
	// Prefer the later action when two equally specific actions occur in one
	// request: "make a folder and create an app" should name the app.
	return score + position / 1_000;
}

export function deriveFeatureSlug(request: string): string {
	let bestCandidate = "";
	let bestScore = Number.NEGATIVE_INFINITY;
	let match: RegExpExecArray | null;
	let position = 0;

	FEATURE_ACTION_PATTERN.lastIndex = 0;
	while ((match = FEATURE_ACTION_PATTERN.exec(request)) !== null) {
		const candidate = featureCandidate(match[1]);
		const score = candidateScore(candidate, position++);
		if (score > bestScore) {
			bestCandidate = candidate;
			bestScore = score;
		}
	}

	// Requests without an imperative still get a concise descriptive filename;
	// never turn an entire prose request into the plan name.
	const fallback = featureCandidate(request);
	const value = bestCandidate || fallback;
	return value.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "") || "feature";
}

export function reservePlanPath(cwd: string, request: string): string {
	const slug = deriveFeatureSlug(request);
	const root = path.resolve(cwd);
	const plansDir = path.join(root, "acache", "plans");
	let suffix = 1;
	while (true) {
		const filename = suffix === 1 ? `plan-${slug}.md` : `plan-${slug}-${suffix}.md`;
		const absolute = path.join(plansDir, filename);
		if (!fs.existsSync(absolute) && !reservedPlanPaths.has(absolute)) {
			ensureDirectory(path.dirname(absolute));
			fs.writeFileSync(absolute, "", { flag: "wx" });
			reservedPlanPaths.add(absolute);
			return path.relative(root, absolute);
		}
		suffix++;
	}
}

/**
 * Reserve the Builder and Tester plans as a single collision-safe unit. A
 * suffix is usable only if both members are free, preventing mismatched pairs
 * such as builder-plan-feature.md and tester-plan-feature-2.md.
 */
export function reservePlanPaths(cwd: string, request: string): PlanPaths {
	const slug = deriveFeatureSlug(request);
	const root = path.resolve(cwd);
	const plansDir = path.join(root, "acache", "plans");
	let suffix = 1;
	while (true) {
		const suffixPart = suffix === 1 ? "" : `-${suffix}`;
		const builderAbsolute = path.join(plansDir, `builder-plan-${slug}${suffixPart}.md`);
		const testerAbsolute = path.join(plansDir, `tester-plan-${slug}${suffixPart}.md`);
		if (
			fs.existsSync(builderAbsolute)
			|| fs.existsSync(testerAbsolute)
			|| reservedPlanPaths.has(builderAbsolute)
			|| reservedPlanPaths.has(testerAbsolute)
		) {
			suffix++;
			continue;
		}

		ensureDirectory(plansDir);
		let builderReserved = false;
		try {
			fs.writeFileSync(builderAbsolute, "", { flag: "wx" });
			reservedPlanPaths.add(builderAbsolute);
			builderReserved = true;
			fs.writeFileSync(testerAbsolute, "", { flag: "wx" });
			reservedPlanPaths.add(testerAbsolute);
			return {
				builderPlanPath: path.relative(root, builderAbsolute),
				testerPlanPath: path.relative(root, testerAbsolute),
			};
		} catch {
			if (builderReserved) {
				reservedPlanPaths.delete(builderAbsolute);
				try {
					fs.unlinkSync(builderAbsolute);
				} catch {
					// A competing process may have replaced it; retry a new suffix.
				}
			}
			suffix++;
		}
	}
}

export function releasePlanReservation(cwd: string, planPath: string): void {
	reservedPlanPaths.delete(path.resolve(cwd, planPath));
}

export function releasePlanReservations(cwd: string, paths: PlanPaths): void {
	releasePlanReservation(cwd, paths.builderPlanPath);
	releasePlanReservation(cwd, paths.testerPlanPath);
}
