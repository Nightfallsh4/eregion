/**
 * Guardrails Extension
 *
 * Protects against two categories of access:
 *
 * 1) **Outside working directory** — When pi tries to read, write, edit, list,
 *    grep, or otherwise access files/directories outside the working directory,
 *    the user is asked for permission.
 * 2) **Sensitive files** — When pi tries to read, write, or edit sensitive files
 *    (e.g., .env, .env.*, SSH keys, credentials) even inside the working
 *    directory, the user is asked for permission.
 *
 * Exception: **pi's own install directory** (the @earendil-works/pi-coding-agent
 * package root — docs, examples, source) is always accessible without prompts,
 * including writes, edits, and output redirection.
 *
 * Exception: **always-safe paths** — /dev/null (exact), everything under /tmp
 * (prefix), and pi's install directory never prompt. Caveat: because /tmp is
 * world-writable and any local process can plant a file there, *executing* a
 * file from /tmp (via an interpreter like bash/python/node, or directly) still
 * requires permission.
 *
 * For each interception the user can:
 *   - Allow this once
 *   - Allow and don't ask again this session (remembers the path until restart)
 *   - Allow and add the path to the project or global whitelist
 *   - Reject (blocks just this operation)
 *   - Reject and stop execution (blocks and gracefully shuts down pi)
 *
 * If the user hasn't responded within 10 seconds, a desktop notification
 * fires as a reminder. Session permissions reset on restart; whitelists persist.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { resolve, normalize, basename, dirname, join } from "node:path";
import { realpathSync, existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { readGuardrailRelay, requestGuardrailPermission, selectGuardrailPermission } from "./guardrails-relay.js";

// ─────────────────────────────────────────────────────
// Sensitive file patterns
// ─────────────────────────────────────────────────────

const SENSITIVE_FILE_PATTERNS: Array<{
	name: string;
	match: (fullPath: string, fileName: string) => boolean;
}> = [
	{
		name: ".env file",
		match: (_fullPath, fileName) =>
			fileName === ".env" || /^\.env\.[a-zA-Z0-9._-]+$/.test(fileName),
	},
	{
		name: "Git credentials",
		match: (fullPath, _fileName) =>
			/\/\.git\/config$/.test(fullPath) || /\/\.git\/credentials$/.test(fullPath),
	},
	{
		name: "SSH private key",
		match: (fullPath, fileName) =>
			/\/\.ssh\//.test(fullPath) ||
			/^id_(rsa|dsa|ecdsa|ed25519)$/.test(fileName),
	},
	{
		name: "Credentials file",
		match: (fullPath, fileName) =>
			fileName === "credentials" ||
			fileName === "credentials.json" ||
			fileName === "secrets" ||
			fileName === "secrets.json" ||
			/\.pem$/.test(fileName) ||
			/\.key$/.test(fileName),
	},
	{
		name: "Cloud credentials",
		match: (fullPath, _fileName) =>
			/\/\.aws\/(credentials|config)$/.test(fullPath) ||
			/\/\.config\/gcloud\//.test(fullPath) ||
			/\/\.azure\//.test(fullPath),
	},
	{
		name: "Docker config",
		match: (fullPath, _fileName) => /\/\.docker\/config\.json$/.test(fullPath),
	},
	{
		name: "Guardrails settings",
		match: (fullPath) => fullPath === globalWhitelistFile() || /\/\.pi\/guardrails\.json$/.test(fullPath) || fullPath.endsWith(".jsonl.guardrails-relay.json"),
	},
	{
		name: "Guardrails extension",
		match: (fullPath, _fileName) =>
			/\/\.pi\/extensions\/guardrails\//.test(fullPath),
	},
];

function isSensitiveFile(absolutePath: string): string | null {
	const fileName = basename(absolutePath);
	for (const pattern of SENSITIVE_FILE_PATTERNS) {
		if (pattern.match(absolutePath, fileName)) {
			return pattern.name;
		}
	}
	return null;
}

// ─────────────────────────────────────────────────────
// Always-safe paths — never prompt for these
// ─────────────────────────────────────────────────────

const ALWAYS_SAFE_PATHS: Array<{ path: string; prefix: boolean }> = [
	// Writes to /dev/null are discarded by the kernel — zero risk.
	{ path: "/dev/null", prefix: false },
	// /tmp is world-writable scratch space, auto-cleaned on reboot.
	// Prefix match covers everything under it. NOTE: executing files
	// from /tmp is still gated separately (see analyzeBashCommand).
	{ path: "/tmp", prefix: true },
	// The installed pi package is explicitly trusted by the user, including
	// writes and edits. Prefix match covers the package and its contents.
	{ path: "/usr/lib/node_modules/@earendil-works/pi-coding-agent", prefix: true },
];

/** Paths the user approved for the remainder of this session. */
const sessionApprovedPaths = new Set<string>();

// Keep guardrails configuration separate from pi's own settings.json so it
// cannot be overwritten by Pi's settings writer. Entries are absolute paths;
// approving a directory also approves its descendants.
function globalWhitelistFile(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "guardrails.json");
}

function whitelistFile(scope: "global" | "project", cwd: string): string {
	return scope === "global" ? globalWhitelistFile() : join(cwd, ".pi", "guardrails.json");
}

function readWhitelist(file: string): string[] {
	if (!existsSync(file)) return [];
	const data: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!data || typeof data !== "object" || !Array.isArray((data as { whitelist?: unknown }).whitelist) ||
		!(data as { whitelist: unknown[] }).whitelist.every((path) => typeof path === "string" && path.startsWith("/") && normalize(path) === path)) {
		throw new Error(`Invalid guardrails whitelist in ${file}: expected { "whitelist": [absolute paths] }`);
	}
	return (data as { whitelist: string[] }).whitelist;
}

function addWhitelistedPath(scope: "global" | "project", path: string, cwd: string): void {
	const file = whitelistFile(scope, cwd);
	const whitelist = readWhitelist(file);
	const absolute = resolve(cwd, path);
	if (whitelist.includes(absolute)) return;
	whitelist.push(absolute);
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify({ whitelist }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* Nothing to clean up */ }
		throw error;
	}
}

function isApproved(absolutePath: string, cwd: string): boolean {
	const normalized = normalize(absolutePath);
	for (const path of [
		...sessionApprovedPaths,
		...readWhitelist(globalWhitelistFile()),
		...readWhitelist(whitelistFile("project", cwd)),
	]) {
		if (normalized === path || normalized.startsWith(path === "/" ? path : path + "/")) return true;
	}
	return false;
}

function isAlwaysSafe(absolutePath: string): boolean {
	const normalized = normalize(absolutePath);
	for (const safe of ALWAYS_SAFE_PATHS) {
		if (normalized === safe.path) return true;
		if (safe.prefix && normalized.startsWith(safe.path + "/")) return true;
	}
	return false;
}

// ─────────────────────────────────────────────────────
// Pi install directory — all access is always allowed
// ─────────────────────────────────────────────────────

/**
 * Resolve the directory where pi itself is installed (the package root of
 * @earendil-works/pi-coding-agent). Determined by following the real path of
 * the running CLI entry point and walking up to its package.json.
 * Returns null if it cannot be determined.
 */
function resolvePiInstallDir(): string | null {
	try {
		const entry = process.argv[1];
		if (!entry) return null;
		let dir = dirname(realpathSync(entry));
		while (true) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					if (
						pkg.name === "@earendil-works/pi-coding-agent" ||
						pkg.name === "@mariozechner/pi-coding-agent"
					) {
						return normalize(dir);
					}
				} catch {
					// Malformed package.json — keep walking up
				}
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	} catch {
		return null;
	}
}

const PI_INSTALL_DIR = resolvePiInstallDir();

/** Check whether the given absolute path is pi's install dir or inside it. */
function isPiInstallPath(absolutePath: string): boolean {
	if (!PI_INSTALL_DIR) return false;
	const normalized = normalize(absolutePath);
	return (
		normalized === PI_INSTALL_DIR ||
		normalized.startsWith(PI_INSTALL_DIR + "/")
	);
}

// ─────────────────────────────────────────────────────
// Skill file detection
// ─────────────────────────────────────────────────────

/**
 * Check whether the given absolute path is a skill file or lives inside
 * a known skills directory. Skill files are safe to read without permission
 * prompts — they are part of normal agent operation.
 */
const SKILL_DIR_MARKERS = [
	"/skills/",
];

function isSkillPath(absolutePath: string): boolean {
	const normalized = normalize(absolutePath);
	// Any SKILL.md file
	if (normalized.endsWith("/SKILL.md")) return true;
	// Any path containing /skills/
	for (const marker of SKILL_DIR_MARKERS) {
		if (normalized.includes(marker)) return true;
	}
	return false;
}

/** Remember this path for the rest of the session. */
function addSessionApprovedPath(absolutePath: string): void {
	sessionApprovedPaths.add(normalize(absolutePath));
}

// ─────────────────────────────────────────────────────
// Path utilities
// ─────────────────────────────────────────────────────

function isInsideCwd(absolutePath: string, cwd: string): boolean {
	const normalizedCwd = normalize(cwd);
	const normalizedPath = normalize(absolutePath);
	// Exactly equals cwd, or is a subdirectory/file within cwd
	if (normalizedPath === normalizedCwd) return true;
	return normalizedPath.startsWith(normalizedCwd + "/");
}

interface PathInfo {
	absolute: string;
	outside: boolean;
	sensitive: string | null;
}

function inspectPath(path: string, cwd: string): PathInfo {
	const absolute = resolve(cwd, path);
	const outside = !isInsideCwd(absolute, cwd);
	const sensitive = isSensitiveFile(absolute);
	return { absolute, outside, sensitive };
}

/**
 * Like inspectPath but exempts always-safe paths, skill files, and
 * session-approved paths from the "outside" check.
 */
function inspectPathExemptApproved(path: string, cwd: string): PathInfo | null {
	const absolute = resolve(cwd, path);
	// Always-safe paths (e.g. /dev/null)
	if (isAlwaysSafe(absolute)) return null;
	// Skill files and skill directories
	if (isSkillPath(absolute)) return null;
	// Paths the user already approved this session
	if (isApproved(absolute, cwd)) return null;
	const outside = !isInsideCwd(absolute, cwd);
	const sensitive = isSensitiveFile(absolute);
	return { absolute, outside, sensitive };
}

// ─────────────────────────────────────────────────────
// Bash command analysis
// ─────────────────────────────────────────────────────

/**
 * Commands that operate on files. We only check these for outside/sensitive paths
 * when they receive absolute or parent-relative arguments.
 */
const FILE_OPS = new Set([
	"cat", "cp", "mv", "rm", "ln", "touch", "mkdir", "chmod", "chown",
	"head", "tail", "nano", "vim", "vi",
	"diff", "patch", "tar", "unzip", "gzip", "gunzip", "rsync",
	"scp", "dd", "truncate", "fallocate",
]);

/** Listing / discovery commands — only check for outside paths, not sensitive files. */
const LIST_OPS = new Set([
	"ls", "dir", "find", "grep", "rg", "ag", "ack", "fd", "tree",
	"which", "type",
]);

interface BashIssue {
	type: "outside" | "sensitive" | "tmp-exec";
	path: string;
	description: string;
}

/**
 * Check a bash command for references to files outside cwd or sensitive files.
 * Returns the first issue detected, or null if the command is fine.
 */
function analyzeBashCommand(command: string, cwd: string): BashIssue | null {
	// Strip heredocs (content between <<EOF and EOF)
	const noHeredoc = command.replace(/<<-?\s*\w+[\s\S]*?(?=\n\s*\w+\n|$)/g, "");

	// Strip quotes — remove the quoted content to avoid matching inside strings
	const noQuotes = noHeredoc
		.replace(/'[^']*'/g, " '' ")
		.replace(/"[^"]*"/g, ' "" ')
		.replace(/`[^`]*`/g, " `` ");

	const tokens = noQuotes.split(/\s+/).filter(Boolean);

	// ── Helper: check if a path-like argument is outside or sensitive ──
	const checkArg = (arg: string): BashIssue | null => {
		// Only check absolute paths (starts with /) or parent-relative (starts with ../)
		if (!arg.startsWith("/") && !arg.startsWith("../")) return null;
		const resolved = resolve(cwd, arg);
		// Always-safe paths (e.g. /dev/null)
		if (isAlwaysSafe(resolved)) return null;
		// Any installed pi package path is explicitly trusted.
		if (isPiInstallPath(resolved)) return null;
		// Skill files and skill directories
		if (isSkillPath(resolved)) return null;
		// Paths the user already approved this session
		if (isApproved(resolved, cwd)) return null;
		const { absolute, outside, sensitive } = inspectPath(arg, cwd);
		if (outside) return { type: "outside", path: absolute, description: "outside working directory" };
		if (sensitive) return { type: "sensitive", path: absolute, description: `sensitive file: ${sensitive}` };
		return null;
	};

	// ── Helper: get the first non-flag argument after an index ──
	const firstRealArgAfter = (startIdx: number): string | undefined => {
		for (let j = startIdx + 1; j < tokens.length; j++) {
			if (!tokens[j].startsWith("-")) return tokens[j];
		}
		return undefined;
	};

	// 1) Check `cd` to an outside path
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "cd" && tokens[i + 1]) {
			const target = tokens[i + 1];
			// skip `cd -` (previous dir)
			if (target === "-") continue;

			// If target starts with / or ../, resolve and check
			if (target.startsWith("/") || target.startsWith("../")) {
				const resolved = resolve(cwd, target);
				if (isSkillPath(resolved)) continue;
				if (isPiInstallPath(resolved)) continue;
				if (isApproved(resolved, cwd)) continue;
				const { absolute, outside } = inspectPath(target, cwd);
				if (outside) {
					return { type: "outside", path: absolute, description: "outside working directory" };
				}
			}
		}
	}

	// 2) Check file-op commands with absolute or ../ paths
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!FILE_OPS.has(token)) continue;

		const arg = firstRealArgAfter(i);
		if (!arg) continue;

		// Only act if the argument itself looks like a path we care about
		if (arg.startsWith("/") || arg.startsWith("../")) {
			const result = checkArg(arg);
			if (result) return result;
		} else {
			// Relative path — check for sensitive files within cwd
			const resolved = resolve(cwd, arg);
			const sensitive = isSensitiveFile(resolved);
			if (sensitive && !isApproved(resolved, cwd)) {
				return { type: "sensitive", path: resolved, description: `sensitive file: ${sensitive}` };
			}
		}
	}

	// 3) Check list/discovery commands with absolute or ../ paths (outside only)
	for (let i = 0; i < tokens.length; i++) {
		if (!LIST_OPS.has(tokens[i])) continue;

		const arg = firstRealArgAfter(i);
		if (!arg || (!arg.startsWith("/") && !arg.startsWith("../"))) continue;

		const resolved = resolve(cwd, arg);
		if (isAlwaysSafe(resolved)) continue;
		if (isSkillPath(resolved)) continue;
		if (isPiInstallPath(resolved)) continue;
		if (isApproved(resolved, cwd)) continue;

		const { absolute, outside } = inspectPath(arg, cwd);
		if (outside) {
			return { type: "outside", path: absolute, description: "outside working directory" };
		}
	}

	// 4) Check for execution of files from /tmp. /tmp is world-writable, so any
	// local process can plant a script there — reads/writes to /tmp are
	// auto-allowed, but *running* something from /tmp always prompts.
	const INTERPRETERS = new Set([
		"bash", "sh", "zsh", "dash", "python", "python3", "node", "deno",
		"bun", "perl", "ruby", "php", "source", ".",
	]);
	const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "|&"]);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		// Interpreter followed by a /tmp script: `bash /tmp/x.sh`, `python3 /tmp/x.py`
		if (INTERPRETERS.has(token)) {
			const script = firstRealArgAfter(i);
			if (script && script.startsWith("/tmp/") && !isApproved(resolve(cwd, script), cwd)) {
				return {
					type: "tmp-exec",
					path: resolve(cwd, script),
					description: "executing a file from world-writable /tmp",
				};
			}
		}
		// Direct execution in command position: `/tmp/x.sh`, `cmd && /tmp/x.sh`
		if (
			token.startsWith("/tmp/") && !isApproved(resolve(cwd, token), cwd) &&
			(i === 0 || SHELL_OPERATORS.has(tokens[i - 1]))
		) {
			return {
				type: "tmp-exec",
				path: resolve(cwd, token),
				description: "executing a file from world-writable /tmp",
			};
		}
	}

	// 5) Check output redirection to outside or sensitive paths
	const redirectMatch = noQuotes.match(/(?:>|>>)\s*(\S+)/);
	if (redirectMatch) {
		const target = redirectMatch[1];
		if (target.startsWith("/") || target.startsWith("../")) {
			const result = checkArg(target);
			if (result) return result;
		} else {
			const resolved = resolve(cwd, target);
			const sensitive = isSensitiveFile(resolved);
			if (sensitive && !isApproved(resolved, cwd)) {
				return { type: "sensitive", path: resolved, description: `sensitive file: ${sensitive}` };
			}
		}
	}

	return null;
}

// ─────────────────────────────────────────────────────
// Decision helper
// ─────────────────────────────────────────────────────

interface AccessCheck {
	shouldBlock: boolean;
	reasonType: "outside" | "sensitive" | "tmp-exec";
	offendingPaths: string[];
	description: string;
}

function checkPath(path: string, cwd: string): AccessCheck | null {
	if (!path) return null;
	// Any detected pi installation, including the explicit system install path
	// above, is always safe for both reads and writes.
	if (isPiInstallPath(resolve(cwd, path))) return null;
	const info = inspectPathExemptApproved(path, cwd);
	if (!info) return null;
	const { absolute, outside, sensitive } = info;
	if (outside) {
		return {
			shouldBlock: true,
			reasonType: "outside",
			offendingPaths: [absolute],
			description: "outside working directory",
		};
	}
	if (sensitive) {
		return {
			shouldBlock: true,
			reasonType: "sensitive",
			offendingPaths: [absolute],
			description: `sensitive file: ${sensitive}`,
		};
	}
	return null;
}

// ─────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("guardrails-allow", {
		description: "Add a path to the project or global guardrails whitelist: /guardrails-allow project|global <path>",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(project|global)\s+(.+)$/s);
			if (!match || !match[2].trim()) {
				ctx.ui.notify("Usage: /guardrails-allow project|global <path>", "warning");
				return;
			}
			try {
				addWhitelistedPath(match[1] as "project" | "global", match[2].trim(), ctx.cwd);
				ctx.ui.notify(`Added ${resolve(ctx.cwd, match[2].trim())} to the ${match[1]} guardrails whitelist.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not update guardrails whitelist: ${String(error)}`, "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// --- read tool ---
		if (isToolCallEventType("read", event)) {
			const path = event.input.path;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "Read file", check);
			}
			return undefined;
		}

		// --- write tool ---
		if (isToolCallEventType("write", event)) {
			const path = event.input.path;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "Write file", check);
			}
			return undefined;
		}

		// --- edit tool ---
		if (isToolCallEventType("edit", event)) {
			const path = event.input.path;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "Edit file", check);
			}
			return undefined;
		}

		// --- ls tool ---
		if (isToolCallEventType("ls", event)) {
			const params = event.input as Record<string, unknown>;
			const path = (params.path ?? params.pattern ?? params.directory ?? "") as string;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "List directory", check);
			}
			return undefined;
		}

		// --- grep tool ---
		if (isToolCallEventType("grep", event)) {
			const params = event.input as Record<string, unknown>;
			const path = (params.path ?? params.pattern ?? "") as string;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "Search files (grep)", check);
			}
			return undefined;
		}

		// --- find tool ---
		if (isToolCallEventType("find", event)) {
			const params = event.input as Record<string, unknown>;
			const path = (params.path ?? params.directory ?? "") as string;
			if (path) {
				const check = checkPath(path, ctx.cwd);
				if (check) return await promptUser(ctx, "Find files", check);
			}
			return undefined;
		}

		// --- bash tool ---
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (command) {
				const issue = analyzeBashCommand(command, ctx.cwd);
				if (issue) {
					return await promptUser(ctx, "Bash command", {
						shouldBlock: true,
						reasonType: issue.type,
						offendingPaths: [issue.path],
						description: issue.description,
					});
				}
			}
			return undefined;
		}

		return undefined;
	});
}

// ─────────────────────────────────────────────────────
// User prompt (workflow children relay this selector to their parent)
// ─────────────────────────────────────────────────────

async function promptUser(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ctx: any,
	operationDescription: string,
	check: AccessCheck,
): Promise<{ block: true; reason: string } | undefined> {
	const pathList = check.offendingPaths.map((p) => `  • ${p}`).join("\n");

	let reasonLabel: string;
	if (check.reasonType === "outside") {
		reasonLabel = "outside working directory";
	} else if (check.reasonType === "tmp-exec") {
		reasonLabel = "executing a file from world-writable /tmp";
	} else {
		reasonLabel = `sensitive: ${check.description.replace(/^sensitive file: /, "")}`;
	}

	const promptText = [
		`${operationDescription} — ${reasonLabel}`,
		"",
		`  Working dir:  ${ctx.cwd}`,
		check.offendingPaths.length === 1
			? `  Target path:  ${check.offendingPaths[0]}`
			: `  Target paths:\n${pathList}`,
		"",
		`"Allow" permits this operation once.`,
	].join("\n");

	let choice: string | undefined;
	try {
		const relay = readGuardrailRelay(ctx.sessionManager?.getSessionFile?.());
		if (relay) {
			// Route before checking hasUI: JSON-mode children have no local UI.
			choice = await requestGuardrailPermission(relay, promptText, ctx.signal);
		} else if (ctx.hasUI) {
			choice = await selectGuardrailPermission(ctx, promptText);
		} else {
			return {
				block: true,
				reason: `Guardrails: ${operationDescription} blocked — ${reasonLabel} (non-interactive mode)`,
			};
		}
	} catch {
		return { block: true, reason: "Guardrails: parent permission prompt unavailable; operation blocked." };
	}

	if (choice === "Allow this once") {
		return undefined;
	}

	if (choice === "Allow and don't ask again this session") {
		for (const p of check.offendingPaths) {
			addSessionApprovedPath(p);
		}
		return undefined;
	}

	if (choice === "Allow and add path to project whitelist" || choice === "Allow and add path to global whitelist") {
		try {
			const scope = choice === "Allow and add path to project whitelist" ? "project" : "global";
			for (const path of check.offendingPaths) addWhitelistedPath(scope, path, ctx.cwd);
			return undefined;
		} catch (error) {
			ctx.ui.notify(`Could not update guardrails whitelist: ${String(error)}`, "error");
			return { block: true, reason: "Guardrails: whitelist update failed; operation blocked." };
		}
	}

	if (choice === "Reject") {
		return {
			block: true,
			reason: `Guardrails: ${operationDescription} blocked — ${reasonLabel} (rejected by user).`,
		};
	}

	if (choice === "Reject and stop execution") {
		// Abort the current agent turn immediately
		ctx.abort();
		return {
			block: true,
			reason: `Guardrails: ${operationDescription} blocked — ${reasonLabel} (rejected by user, stopping execution).`,
		};
	}

	return {
		block: true,
		reason: `Guardrails: ${operationDescription} blocked — ${reasonLabel}.`,
	};
}
