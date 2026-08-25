/**
 * Subagent process runner.
 *
 * Outside Herdr it spawns child `pi --mode json -p` processes exactly as the
 * original workflow did. Inside a Herdr-managed parent pane it can instead
 * create a detached Herdr tab, start a visible pi TUI there, submit the task
 * through Herdr, and tail that pi session file for the same structured
 * progress and handoff output.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import {
  SettingsManager,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { PHASE_TIMEOUT_MS } from "./constants.js";
import {
  HerdrAbortError,
  HerdrError,
  herdrAgentGet,
  herdrAgentInterrupt,
  herdrAgentPromptWait,
  herdrAgentStart,
  herdrTabCreate,
  herdrTabRename,
} from "./herdr.js";
import type { AgentResult, ProgressEvent } from "./types.js";
import { getAssistantText } from "./util.js";

export interface TuiSubagentContext {
  /** Stable run identifier used to make the Herdr agent name unique. */
  runId: string;
  /** Reused phase agent identity: planner, builder, or tester. */
  agentKey: string;
  /** Human-readable tab label prefix, for example "pbt build". */
  tabLabel: string;
  /** Workflow namespace used for Herdr agent names (pbt or dpbt). */
  workflowPrefix?: string;
}

export interface SubagentOptions {
  cwd: string;
  agentPath: string;
  model?: string;
  task: string;
  tools: string[];
  sessionPath?: string;
  signal: AbortSignal;
  agentName: string;
  phase: string;
  activityLogPath: string;
  onOutput?: (output: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  /** When present, run the phase in a visible detached Herdr tab. */
  tui?: TuiSubagentContext;
}

export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

/**
 * Resolve an authenticated model for child pi processes.
 *
 * Child processes do not inherit the parent's in-memory model registry, so the
 * orchestrator must pass an explicit provider/model identifier. Prefer an
 * explicitly configured override, then the durable new-session default. This
 * intentionally does not inherit a model selected manually in the parent
 * session: that selection belongs to the parent session only.
 */
export function getSubagentModel(
  ctx: ExtensionContext | ExtensionCommandContext,
): string | undefined {
  const configured = process.env.PBT_FLOW_MODEL?.trim();
  if (configured) return configured;

  const settings = SettingsManager.create(ctx.cwd);
  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  if (defaultProvider && defaultModelId) {
    const defaultModel = ctx.modelRegistry.find(
      defaultProvider,
      defaultModelId,
    );
    if (defaultModel && ctx.modelRegistry.hasConfiguredAuth(defaultModel)) {
      return `${defaultModel.provider}/${defaultModel.id}`;
    }
  }

  const available = ctx.modelRegistry.getAvailable()[0];
  return available ? `${available.provider}/${available.id}` : undefined;
}

/** Dispatch to the requested visible TUI runner or the portable headless runner. */
export async function runSubagent(
  options: SubagentOptions,
): Promise<AgentResult> {
  return options.tui ? runSubagentTui(options) : runSubagentHeadless(options);
}

async function runSubagentHeadless(
  options: SubagentOptions,
): Promise<AgentResult> {
  const args = ["--mode", "json", "-p"];
  if (options.sessionPath) args.push("--session", options.sessionPath);
  else args.push("--no-session");
  if (!options.model) {
    throw new Error(
      "No authenticated model is available for PBT subagents. Select an authenticated model in the parent session or set PBT_FLOW_MODEL=provider/model.",
    );
  }
  args.push(
    "--model",
    options.model,
    "--append-system-prompt",
    options.agentPath,
    "--tools",
    options.tools.join(","),
    `Task: ${options.task}`,
  );

  const emitProgress = (
    event: Omit<ProgressEvent, "timestamp" | "agent" | "phase">,
  ) => {
    options.onProgress?.({
      timestamp: Date.now(),
      agent: options.agentName,
      phase: options.phase,
      ...event,
    });
  };

  const current = emptyAgentResult();

  await new Promise<void>((resolve) => {
    const invocation = getPiInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let finished = false;
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5_000);
    }, PHASE_TIMEOUT_MS);

    const terminate = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5_000);
    };
    if (options.signal.aborted) terminate();
    else options.signal.addEventListener("abort", terminate, { once: true });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        emitProgress({ kind: "stderr", message: line });
        return;
      }
      if (event.type === "tool_execution_start") {
        emitProgress({
          kind: "tool-start",
          toolName: event.toolName,
          message: `${event.toolName || "tool"} started`,
          details:
            typeof event.args === "object"
              ? JSON.stringify(event.args)
              : undefined,
        });
      }
      if (event.type === "tool_execution_end") {
        emitProgress({
          kind: "tool-end",
          toolName: event.toolName,
          message: `${event.toolName || "tool"} ${event.isError ? "failed" : "completed"}`,
        });
      }
      if (event.type === "message_end" && event.message) {
        handleAssistantMessage(
          event.message as Message,
          current,
          emitProgress,
          options.onOutput,
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      current.stderr += text;
      emitProgress({ kind: "stderr", message: text });
    });
    child.on("error", (error) => {
      current.errorMessage = error.message;
      emitProgress({ kind: "failed", message: error.message });
    });
    child.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      finished = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", terminate);
      current.exitCode = code ?? 1;
      if (aborted) {
        current.stopReason = "aborted";
        current.errorMessage = "Subagent was aborted";
      } else if (timedOut) {
        current.stopReason = "timeout";
        current.errorMessage = `Subagent exceeded the ${PHASE_TIMEOUT_MS / 60_000}-minute timeout`;
      }
      emitProgress({
        kind: current.exitCode === 0 ? "completed" : "failed",
        message:
          current.exitCode === 0
            ? "agent process completed"
            : `agent process exited with code ${current.exitCode}`,
      });
      resolve();
    });
  });

  return current;
}

/**
 * Run a phase as a visible pi TUI in a detached Herdr tab. The pi session file
 * is tailed while it works, preserving live tool/output events and allowing the
 * orchestrator to consume the final JSON handoff just like headless mode.
 */
async function runSubagentTui(options: SubagentOptions): Promise<AgentResult> {
  if (!options.tui) throw new Error("TUI subagent context is required");
  if (!options.sessionPath)
    throw new Error(
      "Visible Herdr subagents require a persistent pi session path",
    );
  if (!options.model) {
    throw new Error(
      "No authenticated model is available for PBT subagents. Select an authenticated model in the parent session or set PBT_FLOW_MODEL=provider/model.",
    );
  }

  const emitProgress = (
    event: Omit<ProgressEvent, "timestamp" | "agent" | "phase">,
  ) => {
    options.onProgress?.({
      timestamp: Date.now(),
      agent: options.agentName,
      phase: options.phase,
      ...event,
    });
  };
  const current = emptyAgentResult();
  const suffix = options.tui.runId.split("-").at(-1) || options.tui.runId;
  const agentInstanceName = makeAgentInstanceName(options.tui.agentKey, suffix, options.tui.workflowPrefix);
  const tabBaseLabel = `${options.tui.tabLabel} ${suffix}`;
  let tabId: string | undefined;

  try {
    const existing = await herdrAgentGet(agentInstanceName);
    if (existing?.pane_id) {
      tabId = existing.tab_id;
      if (tabId) await herdrTabRename(tabId, `⟳ ${tabBaseLabel}`);
      emitProgress({
        kind: "started",
        message: `reusing Herdr tab ${tabId || "(unknown)"} for ${agentInstanceName}`,
      });
    } else {
      const tab = await herdrTabCreate({
        cwd: options.cwd,
        label: tabBaseLabel,
        signal: options.signal,
      });
      tabId = tab.tabId;
      await herdrTabRename(tab.tabId, `⟳ ${tabBaseLabel}`);
      emitProgress({
        kind: "started",
        message: `opened detached Herdr tab ${tab.tabId} for ${agentInstanceName}`,
      });
      const piArgs = [
        "--session",
        options.sessionPath,
        "--model",
        options.model,
        "--append-system-prompt",
        options.agentPath,
        "--tools",
        options.tools.join(","),
      ];
      await startHerdrAgentWhenShellIsReady({
        name: agentInstanceName,
        paneId: tab.paneId,
        piArgs,
        signal: options.signal,
        onRetry: (attempt, message) =>
          emitProgress({
            kind: "started",
            message: `waiting for Herdr tab shell before starting ${agentInstanceName} (attempt ${attempt}): ${message}`,
          }),
      });
    }
  } catch (error) {
    const aborted = options.signal.aborted || error instanceof HerdrAbortError;
    current.stopReason = aborted ? "aborted" : undefined;
    current.errorMessage = aborted
      ? "Subagent was aborted"
      : errorMessage(error);
    emitProgress({ kind: "failed", message: current.errorMessage });
    return current;
  }

  let sawCurrentPrompt = false;
  const tailer = new SessionTailer(options.sessionPath, (entry) => {
    if (entry?.type !== "message" || !entry.message) return;
    const message = entry.message as Message;
    if (message.role === "user") {
      sawCurrentPrompt = true;
      return;
    }
    if (!sawCurrentPrompt) return;
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content as any[]) {
        if (part?.type !== "toolCall") continue;
        emitProgress({
          kind: "tool-start",
          toolName: typeof part.name === "string" ? part.name : undefined,
          message: `${part.name || "tool"} started`,
          details:
            part.arguments && typeof part.arguments === "object"
              ? JSON.stringify(part.arguments)
              : undefined,
        });
      }
      handleAssistantMessage(message, current, emitProgress, options.onOutput);
      return;
    }
    if (message.role === "toolResult") {
      const toolResult = message as any;
      emitProgress({
        kind: "tool-end",
        toolName:
          typeof toolResult.toolName === "string"
            ? toolResult.toolName
            : undefined,
        message: `${toolResult.toolName || "tool"} ${toolResult.isError ? "failed" : "completed"}`,
      });
    }
  });
  tailer.startAtEnd();
  tailer.start();

  let promptError: Error | undefined;
  let settledStatus = "unknown";
  try {
    const settled = await herdrAgentPromptWait({
      name: agentInstanceName,
      task: `Task: ${options.task}`,
      timeoutMs: PHASE_TIMEOUT_MS,
      signal: options.signal,
    });
    settledStatus = settled.agent_status || "unknown";
  } catch (error) {
    promptError = error instanceof Error ? error : new Error(String(error));
  } finally {
    tailer.flush();
    tailer.stop();
  }

  if (promptError) {
    const aborted =
      options.signal.aborted || promptError instanceof HerdrAbortError;
    const timedOut =
      promptError instanceof HerdrError &&
      (promptError.code === "timeout" ||
        /timed?\s*out|timeout|deadline/i.test(promptError.message));
    if (aborted || timedOut) await herdrAgentInterrupt(agentInstanceName);
    current.stopReason = aborted ? "aborted" : timedOut ? "timeout" : undefined;
    current.errorMessage = aborted
      ? "Subagent was aborted"
      : timedOut
        ? `Subagent exceeded the ${PHASE_TIMEOUT_MS / 60_000}-minute timeout`
        : errorMessage(promptError);
    emitProgress({ kind: "failed", message: current.errorMessage });
    if (tabId) await herdrTabRename(tabId, `✗ ${tabBaseLabel}`);
    return current;
  }

  if (settledStatus === "blocked") {
    await herdrAgentInterrupt(agentInstanceName);
    current.errorMessage =
      "Subagent is blocked on input in its Herdr tab; inspect the tab and rerun the phase.";
    emitProgress({ kind: "failed", message: current.errorMessage });
    if (tabId) await herdrTabRename(tabId, `✗ ${tabBaseLabel}`);
    return current;
  }

  current.exitCode = 0;
  emitProgress({
    kind: "completed",
    message: `pi TUI settled (${settledStatus}) in Herdr tab ${tabId || "(unknown)"}`,
  });
  if (tabId) await herdrTabRename(tabId, `✓ ${tabBaseLabel}`);
  return current;
}

async function startHerdrAgentWhenShellIsReady(options: {
  name: string;
  paneId: string;
  piArgs: string[];
  signal: AbortSignal;
  onRetry?: (attempt: number, message: string) => void;
}): Promise<void> {
  const maxAttempts = 7;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal.aborted) throw new HerdrAbortError();
    try {
      await herdrAgentStart({
        name: options.name,
        paneId: options.paneId,
        piArgs: options.piArgs,
        signal: options.signal,
      });
      return;
    } catch (error) {
      const message = errorMessage(error);
      const shellNotReady = /not an available shell|available shell/i.test(
        message,
      );
      if (!shellNotReady || attempt === maxAttempts) throw error;
      options.onRetry?.(attempt, message);
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(
          () => {
            finished = true;
            options.signal.removeEventListener("abort", abort);
            resolve();
          },
          Math.min(250 * 2 ** (attempt - 1), 2_000),
        );
        const abort = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
          reject(new HerdrAbortError());
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

function emptyAgentResult(): AgentResult {
  return {
    exitCode: 1,
    output: "",
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
  };
}

function handleAssistantMessage(
  message: Message,
  current: AgentResult,
  emitProgress: (
    event: Omit<ProgressEvent, "timestamp" | "agent" | "phase">,
  ) => void,
  onOutput?: (output: string) => void,
): void {
  const assistantText = getAssistantText(message);
  if (assistantText) {
    current.output = assistantText;
    emitProgress({ kind: "assistant", message: assistantText });
    onOutput?.(assistantText);
  }
  if (message.role !== "assistant") return;
  current.usage.turns++;
  const usage = message.usage;
  if (usage) {
    current.usage.input += usage.input || 0;
    current.usage.output += usage.output || 0;
    current.usage.cacheRead += usage.cacheRead || 0;
    current.usage.cacheWrite += usage.cacheWrite || 0;
    current.usage.cost += usage.cost?.total || 0;
  }
  if (message.model) current.model = message.model;
  if (message.stopReason) current.stopReason = message.stopReason;
  if (message.errorMessage) current.errorMessage = message.errorMessage;
}

function makeAgentInstanceName(agentKey: string, suffix: string, workflowPrefix = "pbt"): string {
  const normalized = `${agentKey}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  return `${workflowPrefix}-${normalized}`.slice(0, 32).replace(/-+$/, "") || `${workflowPrefix}-agent`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append-only byte tailer for a pi session JSONL file. */
class SessionTailer {
  private offset = 0;
  private remainder = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly onEntry: (entry: any) => void,
  ) {}

  /** Ignore entries from previous prompts in a persistent session. */
  startAtEnd(): void {
    try {
      this.offset = fs.statSync(this.filePath).size;
    } catch {
      this.offset = 0;
    }
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  flush(): void {
    this.poll();
    const finalLine = this.remainder.trim();
    this.remainder = "";
    if (!finalLine) return;
    try {
      this.onEntry(JSON.parse(finalLine));
    } catch {
      // The writer may still be appending. The next phase will ignore old
      // session records by starting from the then-current end of file.
    }
  }

  private poll(): void {
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) return;

    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.filePath, "r");
      const byteLength = size - this.offset;
      const buffer = Buffer.alloc(byteLength);
      fs.readSync(descriptor, buffer, 0, byteLength, this.offset);
      this.offset = size;
      const lines = (this.remainder + buffer.toString("utf8")).split("\n");
      this.remainder = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.onEntry(JSON.parse(line));
        } catch {
          // Ignore malformed partial/racing lines; pi writes independent JSONL
          // records and a later poll will continue at the next record.
        }
      }
    } catch {
      // Best-effort progress is intentionally non-fatal to the phase.
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}
