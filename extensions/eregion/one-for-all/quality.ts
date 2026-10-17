/**
 * Project-specific quality profile parsing and command execution for PBT/DPBT
 * and the focused just-build workflow.
 *
 * Projects define reproducible checks in `.pi/quality.json`. The orchestrator,
 * not an agent handoff, executes each required command through the shell so
 * profiles may use package scripts and composed project commands.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PHASE_TIMEOUT_MS } from "./constants.js";
import type { QualityRun } from "./types.js";
import { isRecord } from "./util.js";

export const QUALITY_CONFIG_PATH = path.join(".pi", "quality.json");
const MAX_CAPTURED_OUTPUT = 50_000;
const DEFAULT_QUALITY_TIMEOUT_MS = PHASE_TIMEOUT_MS;
const MAX_QUALITY_TIMEOUT_MS = 60 * 60 * 1000;

export interface QualityConfig {
	commands: Record<string, string>;
	required: string[];
	timeoutMs: number;
}

/**
 * Build the visible, interruptible task sent by `/pbt-lint-setup`. The command
 * name is retained for compatibility, while the configured artifact is a full
 * quality profile rather than a single linter command.
 */
export function buildQualitySetupTask(force: boolean): string {
	return `Configure this project's orchestrator-owned quality profile now, in this current session. Do the work yourself with the available tools; do not delegate it to a background/subagent session. I may interrupt you or provide more context while you work, so explain material choices and pause for clarification when repository evidence is ambiguous.

Inspect the repository before changing anything: manifests and lockfiles, source languages/frameworks, existing format/lint/type-check/build/test/security config files, package/task scripts, and CI conventions. Reuse existing working project-local commands when appropriate; do not replace them merely because another tool is newer. If a necessary baseline check is absent, choose and set up the ecosystem-native project-local tool that best fits the actual project. Never rely on globally installed tools.

Create or update every required quality config file, local dependency, lockfile, and conventional project script. Define every reproducible quality command that applies to this repository, such as format, lint, typecheck, build, unit, integration, e2e, or security. Select the minimum commands that must pass before the workflow can complete as required gates. Do not modify application behavior or weaken checks just to hide findings. Run each required command once; repair setup/configuration errors, but leave genuine pre-existing findings intact and report them.

Finally, write ${QUALITY_CONFIG_PATH} yourself. It must contain non-empty named commands and a non-empty, duplicate-free required list whose names all exist in commands, for example:
\`\`\`json
{
  "commands": {
    "format": "npm run format:check",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": "npm run build",
    "unit": "npm test"
  },
  "required": ["lint", "typecheck", "build", "unit"]
}
\`\`\`
PBT, DPBT, and just-build execute every required command directly and cannot complete until they all exit successfully.${force ? " Replace the existing quality setup only after completing the same inspection; preserve working existing project checks when they remain the best choice." : ""}`;
}

function setupRequiredError(reason: string): Error {
	return new Error(`${reason} Run /pbt-lint-setup first so it can inspect the project and create ${QUALITY_CONFIG_PATH}.`);
}

export function readQualityConfig(cwd: string): QualityConfig {
	const configPath = path.join(cwd, QUALITY_CONFIG_PATH);
	if (!fs.existsSync(configPath)) {
		throw setupRequiredError(`Project quality configuration is not available at ${QUALITY_CONFIG_PATH}.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		throw setupRequiredError(`Could not read ${QUALITY_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}.`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.commands)) {
		throw setupRequiredError(`${QUALITY_CONFIG_PATH} must contain a commands object.`);
	}
	const commands: Record<string, string> = {};
	for (const [name, command] of Object.entries(parsed.commands)) {
		if (!name.trim() || typeof command !== "string" || !command.trim() || command.includes("\0")) {
			throw setupRequiredError(`${QUALITY_CONFIG_PATH} commands must use non-empty names and non-empty shell commands.`);
		}
		commands[name] = command.trim();
	}
	if (Object.keys(commands).length === 0) {
		throw setupRequiredError(`${QUALITY_CONFIG_PATH} commands must not be empty.`);
	}
	if (!Array.isArray(parsed.required) || parsed.required.length === 0 || parsed.required.some((name) => typeof name !== "string" || !name.trim())) {
		throw setupRequiredError(`${QUALITY_CONFIG_PATH} must contain a non-empty required command list.`);
	}
	const required = parsed.required.map((name) => name.trim());
	if (new Set(required).size !== required.length) {
		throw setupRequiredError(`${QUALITY_CONFIG_PATH} required command names must not contain duplicates.`);
	}
	for (const name of required) {
		if (!Object.hasOwn(commands, name)) {
			throw setupRequiredError(`${QUALITY_CONFIG_PATH} required command ${JSON.stringify(name)} is not defined in commands.`);
		}
	}
	if (parsed.timeoutMs !== undefined && (typeof parsed.timeoutMs !== "number" || !Number.isFinite(parsed.timeoutMs))) {
		throw setupRequiredError(`${QUALITY_CONFIG_PATH} timeoutMs must be a finite number when provided.`);
	}
	const timeoutMs = typeof parsed.timeoutMs === "number"
		? Math.max(1_000, Math.min(MAX_QUALITY_TIMEOUT_MS, Math.floor(parsed.timeoutMs)))
		: DEFAULT_QUALITY_TIMEOUT_MS;
	return { commands, required, timeoutMs };
}

function appendCaptured(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

/** Run one named profile command and capture diagnostics for persistent repair turns. */
export async function runQualityCommand(
	cwd: string,
	name: string,
	command: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<Pick<QualityRun, "name" | "command" | "exitCode" | "stdout" | "stderr">> {
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
				const outputSuffix = "\n[quality output truncated to the most recent 50 KB]";
				resolve({
					name,
					command,
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
		const abort = () => kill();

		try {
			child = spawn(command, {
				cwd,
				shell: true,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			stderr = appendCaptured(stderr, `Could not start quality command: ${error instanceof Error ? error.message : String(error)}`);
			finish(127);
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => { stdout = appendCaptured(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer | string) => { stderr = appendCaptured(stderr, chunk); });
		child.once("error", (error) => {
			stderr = appendCaptured(stderr, `\nCould not start quality command: ${error.message}`);
			finish(127);
		});
		child.once("close", (code) => {
			if (signal.aborted) {
				finish(130, new Error("Workflow aborted"));
				return;
			}
			if (timedOut) stderr = appendCaptured(stderr, `\nQuality command timed out after ${timeoutMs} ms.`);
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
		}, timeoutMs);
	});
}

export function renderQualityFailure(run: Pick<QualityRun, "name" | "command" | "exitCode" | "stdout" | "stderr">): string {
	return JSON.stringify({
		name: run.name,
		command: run.command,
		exitCode: run.exitCode,
		stdout: run.stdout,
		stderr: run.stderr,
	}, null, 2);
}
