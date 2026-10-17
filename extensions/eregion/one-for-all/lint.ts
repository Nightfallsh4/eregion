/**
 * Project-specific lint configuration and command execution for PBT/DPBT and
 * the focused just-build workflow.
 *
 * Projects store their chosen command in `.pi/lint.json`. The configured
 * command is intentionally executed through the shell so projects can use
 * package scripts and composed commands such as `npm run lint` or
 * `ruff check . && mypy src`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PHASE_TIMEOUT_MS } from "./constants.js";
import type { LintRun } from "./types.js";
import { ensureDirectory, isRecord } from "./util.js";

export const LINT_CONFIG_PATH = path.join(".pi", "lint.json");
const MAX_CAPTURED_OUTPUT = 50_000;
const DEFAULT_LINT_TIMEOUT_MS = PHASE_TIMEOUT_MS;
const MAX_LINT_TIMEOUT_MS = 60 * 60 * 1000;

export interface LintConfig {
	command: string;
	timeoutMs: number;
}

/**
 * Build the normal in-session task sent by `/pbt-lint-setup`. This is
 * intentionally a user message rather than a detached subagent task: the
 * caller can see every inspection and change, interrupt it, or steer it with
 * more context in the same Pi conversation.
 */
export function buildLintSetupTask(force: boolean): string {
	return `Configure this project's lint/static-analysis quality gate now, in this current session. Do the work yourself with the available tools; do not delegate it to a background/subagent session. I may interrupt you or provide more context while you work, so explain material choices and pause for clarification when repository evidence is ambiguous.

Inspect the repository before changing anything: manifests and lockfiles, source languages/frameworks, existing lint config files, package/task scripts, and CI conventions. Reuse an existing working project linter when appropriate; do not replace it merely because another tool is newer. If none exists, choose and set up the ecosystem-native project-local tool that best fits the actual project (for example ESLint flat config for JS/TS, Ruff for Python, or cargo clippy for Rust). For a genuine mixed-language project, use one reproducible shell command that invokes each relevant check.

Create or update every required linter config file, local dependency, lockfile, and conventional project script (normally \`lint\`). Use the repository's existing package manager; never rely on a globally installed linter. Do not modify application behavior or weaken lint rules just to hide findings. Run the final command once; repair setup/configuration errors, but leave genuine pre-existing lint findings intact and report them.

Finally, write ${LINT_CONFIG_PATH} yourself. It must contain the selected non-empty root-relative shell command and timeout, for example:
\`\`\`json
{
  "command": "npm run lint",
  "timeoutMs": ${DEFAULT_LINT_TIMEOUT_MS}
}
\`\`\`
PBT, DPBT, and just-build read this file as their required quality gate.${force ? " Replace the existing lint setup only after completing the same inspection; preserve a working existing linter when it remains the best choice." : ""}`;
}

export function readLintConfig(cwd: string): LintConfig {
	const configPath = path.join(cwd, LINT_CONFIG_PATH);
	if (!fs.existsSync(configPath)) {
		throw new Error(
			`Project linting is not configured. Run /pbt-lint-setup first so it can inspect the project and create ${LINT_CONFIG_PATH}.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${LINT_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || typeof parsed.command !== "string" || !parsed.command.trim()) {
		throw new Error(`${LINT_CONFIG_PATH} must contain a non-empty string field named "command".`);
	}
	const timeoutMs = typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs)
		? Math.max(1_000, Math.min(MAX_LINT_TIMEOUT_MS, Math.floor(parsed.timeoutMs)))
		: DEFAULT_LINT_TIMEOUT_MS;
	return { command: parsed.command.trim(), timeoutMs };
}

/** Create or replace the project lint command configuration. */
export function writeLintConfig(cwd: string, command: string, force = false): string {
	const normalizedCommand = command.trim();
	if (!normalizedCommand || normalizedCommand.includes("\0")) {
		throw new Error("Provide a non-empty lint command, such as `npm run lint`.");
	}
	const configPath = path.join(cwd, LINT_CONFIG_PATH);
	if (fs.existsSync(configPath) && !force) {
		throw new Error(`${LINT_CONFIG_PATH} already exists. Use /pbt-lint-setup --force to inspect and replace it.`);
	}
	ensureDirectory(path.dirname(configPath));
	const temporaryPath = `${configPath}.tmp-${process.pid}`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify({ command: normalizedCommand, timeoutMs: DEFAULT_LINT_TIMEOUT_MS }, null, 2)}\n`, "utf8");
	fs.renameSync(temporaryPath, configPath);
	return configPath;
}

function appendCaptured(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

/** Run the configured project command and capture diagnostics for agent repair turns. */
export async function runLintCommand(cwd: string, config: LintConfig, signal: AbortSignal): Promise<Pick<LintRun, "command" | "exitCode" | "stdout" | "stderr">> {
	if (signal.aborted) throw new Error("Workflow aborted");

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceKill: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			signal.removeEventListener("abort", abort);
		};
		const finish = (exitCode: number, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else {
				const outputSuffix = "\n[lint output truncated to the most recent 50 KB]";
				resolve({
					command: config.command,
					exitCode,
					stdout: stdout.length >= MAX_CAPTURED_OUTPUT ? `${outputSuffix}\n${stdout}` : stdout,
					stderr: stderr.length >= MAX_CAPTURED_OUTPUT ? `${outputSuffix}\n${stderr}` : stderr,
				});
			}
		};
		const sendSignal = (signalName: NodeJS.Signals) => {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, signalName);
					return;
				} catch {
					// Fall back to the shell process if the process group is already gone.
				}
			}
			try { child.kill(signalName); } catch { /* Process may already have exited. */ }
		};
		const kill = () => {
			sendSignal("SIGTERM");
			if (forceKill) clearTimeout(forceKill);
			forceKill = setTimeout(() => sendSignal("SIGKILL"), 2_000);
		};
		const abort = () => {
			// Wait for `close` so the forced SIGKILL fallback is not cleared before
			// a command that ignores SIGTERM has been terminated.
			kill();
		};

		try {
			child = spawn(config.command, {
				cwd,
				shell: true,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			stderr = appendCaptured(stderr, `Could not start lint command: ${error instanceof Error ? error.message : String(error)}`);
			finish(127);
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => { stdout = appendCaptured(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer | string) => { stderr = appendCaptured(stderr, chunk); });
		child.once("error", (error) => {
			stderr = appendCaptured(stderr, `\nCould not start lint command: ${error.message}`);
			finish(127);
		});
		child.once("close", (code) => {
			if (signal.aborted) {
				finish(130, new Error("Workflow aborted"));
				return;
			}
			if (timedOut) stderr = appendCaptured(stderr, `\nLint command timed out after ${config.timeoutMs} ms.`);
			finish(timedOut ? 124 : code ?? 1);
		});

		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		timeout = setTimeout(() => {
			timedOut = true;
			kill();
		}, config.timeoutMs);
	});
}

export function renderLintFailure(run: Pick<LintRun, "command" | "exitCode" | "stdout" | "stderr">): string {
	return JSON.stringify({
		command: run.command,
		exitCode: run.exitCode,
		stdout: run.stdout,
		stderr: run.stderr,
	}, null, 2);
}
