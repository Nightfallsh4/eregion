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
import { GUARDRAIL_RELAY_ENV, startGuardrailRelay, type GuardrailRelayEndpoint } from "../global/guardrails-relay.js";

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
  /** Pi thinking/reasoning level passed to this subagent process. */
  effort?: SubagentEffort;
  task: string;
  tools: string[];
  sessionPath?: string;
  signal: AbortSignal;
  agentName: string;
  phase: string;
  activityLogPath: string;
  onOutput?: (output: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  /** Parent UI used for guardrail permission selectors in every runner mode. */
  permissionContext?: ExtensionContext;
  permissionWorkflow?: string;
  /** When present, run the phase in a visible detached Herdr tab. */
  tui?: TuiSubagentContext;
}

/** Subagent roles that can be pinned to a specific LLM provider/model. */
export type SubagentRole = "designer" | "planner" | "builder" | "tester" | "documentation";

/**
 * Per-subagent model configuration resolved from a workflow definition's
 * top-level `models` block (plus per-phase `model` overrides). Each value is
 * a `provider/modelId` identifier or a bare `modelId` resolved against the
 * default provider. An optional `default` applies to any role not pinned.
 */
export interface SubagentModels {
	default?: string;
	designer?: string;
	planner?: string;
	builder?: string;
	tester?: string;
	documentation?: string;
}

/** Pi thinking levels accepted by `--thinking`. */
export type SubagentEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Per-subagent reasoning configuration from a workflow's `efforts` block.
 * The default is deliberately high so every workflow subagent reasons at high
 * effort unless a role, phase, or environment override says otherwise.
 */
export interface SubagentEfforts {
	default?: SubagentEffort;
	designer?: SubagentEffort;
	planner?: SubagentEffort;
	builder?: SubagentEffort;
	tester?: SubagentEffort;
	documentation?: SubagentEffort;
}

export const SUBAGENT_ROLES: readonly SubagentRole[] = ["designer", "planner", "builder", "tester", "documentation"];
export const DEFAULT_SUBAGENT_EFFORT: SubagentEffort = "high";

const SUBAGENT_EFFORTS = new Set<SubagentEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Extension tools every workflow subagent may use alongside its phase-specific tools. */
const SHARED_SUBAGENT_TOOLS = ["web_search", "url_context"] as const;

/**
 * Add package-provided tools to Pi's explicit subagent allowlist.
 *
 * Passing `--tools` replaces Pi's default selection, so an extension tool is
 * unavailable unless it is named here. `url_context` is automatically hidden
 * by pi-web-search for models that do not support provider-native URL context.
 */
export function resolveSubagentTools(tools: readonly string[]): string[] {
  return [...new Set([...tools, ...SHARED_SUBAGENT_TOOLS])];
}

/** Convert a workflow/environment value to a valid Pi thinking level. */
export function parseSubagentEffort(value: unknown): SubagentEffort | undefined {
	if (typeof value !== "string") return undefined;
	const effort = value.trim().toLowerCase();
	return SUBAGENT_EFFORTS.has(effort as SubagentEffort) ? effort as SubagentEffort : undefined;
}

function envVarFor(role: SubagentRole, setting: "MODEL" | "EFFORT" = "MODEL"): string {
	return `PBT_FLOW_${setting}_${role.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;
}

/** Print a registered, authenticated model as `provider/id`. */
function printModel(ctx: ExtensionContext | ExtensionCommandContext, provider: string, modelId: string): string | undefined {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
		return `${model.provider}/${model.id}`;
	}
	return undefined;
}

/** Match a bare `modelId` against the provider catalogue (prefers any authenticated entry). */
function printBareModelId(ctx: ExtensionContext | ExtensionCommandContext, modelId: string): string | undefined {
	for (const model of ctx.modelRegistry.getAvailable()) {
		if (model.id === modelId && ctx.modelRegistry.hasConfiguredAuth(model)) {
			return `${model.provider}/${model.id}`;
		}
	}
	return undefined;
}

/**
 * Resolve a configured `provider/modelId` or bare `modelId` string to an
 * authenticated `provider/id`. Returns undefined when the value cannot be
 * found or has no configured auth, so callers fall through to the next layer.
 */
function resolveConfiguredModel(ctx: ExtensionContext | ExtensionCommandContext, raw: string): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash > 0) {
		return printModel(ctx, value.slice(0, slash), value.slice(slash + 1));
	}
	return printBareModelId(ctx, value);
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
 * Resolve an authenticated provider/model identifier for a child pi process.
 *
 * Child processes do not inherit the parent's in-memory model registry, so the
 * orchestrator must pass an explicit provider/model identifier. The resolution
 * order for a subagent role is:
 *
 * 1. `PBT_FLOW_MODEL_<ROLE>` env override (e.g. `PBT_FLOW_MODEL_BUILDER`)
 * 2. the workflow definition's per-role model (`models[role]`)
 * 3. the workflow definition's `models.default`
 * 4. the legacy `PBT_FLOW_MODEL` env override (applies to every role)
 * 5. the durable new-session default provider/model
 * 6. the first available authenticated model
 *
 * A manually selected model in the parent session is intentionally not
 * inherited: that selection belongs to the parent session only. Configured
 * values that cannot be resolved or authenticated fall through to the next
 * layer instead of failing the run.
 */
export function getSubagentModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  models: SubagentModels = {},
  role?: SubagentRole,
): string | undefined {
  if (role) {
    // 1. Per-subagent environment override.
    const roleEnv = process.env[envVarFor(role)]?.trim();
    if (roleEnv) {
      const resolved = resolveConfiguredModel(ctx, roleEnv);
      if (resolved) return resolved;
    }
    // 2. Workflow configuration pin for this role.
    const roleConfig = models[role]?.trim();
    if (roleConfig) {
      const resolved = resolveConfiguredModel(ctx, roleConfig);
      if (resolved) return resolved;
    }
  }
  // 3. Workflow configuration default.
  const defaultConfig = models.default?.trim();
  if (defaultConfig) {
    const resolved = resolveConfiguredModel(ctx, defaultConfig);
    if (resolved) return resolved;
  }
  // 4. Legacy global environment override.
  const configured = process.env.PBT_FLOW_MODEL?.trim();
  if (configured) {
    const resolved = resolveConfiguredModel(ctx, configured);
    if (resolved) return resolved;
  }

  // 5. Durable new-session default.
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

  // 6. First available authenticated model.
  const available = ctx.modelRegistry.getAvailable()[0];
  return available ? `${available.provider}/${available.id}` : undefined;
}

/**
 * Resolve the effective model for every subagent role and return it as a
 * role → `provider/id` map (using fallbacks for unconfigured roles). Used both
 * to pass per-phase models to the subagent runner and to display the active
 * configuration in the UI and persisted run state.
 */
export function resolveSubagentModels(
  ctx: ExtensionContext | ExtensionCommandContext,
  models: SubagentModels = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const role of SUBAGENT_ROLES) {
    const resolved = getSubagentModel(ctx, models, role);
    if (resolved) result[role] = resolved;
  }
  return result;
}

/**
 * Resolve the reasoning effort for a subagent role. This mirrors model
 * precedence while guaranteeing a high-effort default:
 *
 * 1. `PBT_FLOW_EFFORT_<ROLE>`
 * 2. workflow `efforts[role]`
 * 3. workflow `efforts.default`
 * 4. `PBT_FLOW_EFFORT`
 * 5. `high`
 */
export function getSubagentEffort(
  efforts: SubagentEfforts = {},
  role?: SubagentRole,
): SubagentEffort {
  if (role) {
    const roleOverride = parseSubagentEffort(process.env[envVarFor(role, "EFFORT")]);
    if (roleOverride) return roleOverride;
    if (efforts[role]) return efforts[role];
  }
  return parseSubagentEffort(efforts.default)
    || parseSubagentEffort(process.env.PBT_FLOW_EFFORT)
    || DEFAULT_SUBAGENT_EFFORT;
}

/** Resolve the effective effort for every subagent role. */
export function resolveSubagentEfforts(efforts: SubagentEfforts = {}): Record<SubagentRole, SubagentEffort> {
  return Object.fromEntries(SUBAGENT_ROLES.map((role) => [role, getSubagentEffort(efforts, role)])) as Record<SubagentRole, SubagentEffort>;
}

/** Dispatch to the requested visible TUI runner or the portable headless runner. */
export async function runSubagent(
  options: SubagentOptions,
): Promise<AgentResult> {
  if (!options.permissionContext) {
    return options.tui ? runSubagentTui(options) : runSubagentHeadless(options);
  }
  const relay = await startGuardrailRelay({
    ctx: options.permissionContext,
    label: `${options.permissionWorkflow || "PBT"} · Phase: ${options.phase.replace(/-/g, " ")} · Agent: ${options.agentName}`,
    signal: options.signal,
    sessionPath: options.sessionPath,
  });
  try {
    return options.tui ? await runSubagentTui(options) : await runSubagentHeadless(options, relay.endpoint);
  } finally {
    relay.close();
  }
}

async function runSubagentHeadless(
  options: SubagentOptions,
  relay?: GuardrailRelayEndpoint,
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
    "--thinking",
    options.effort || DEFAULT_SUBAGENT_EFFORT,
    "--append-system-prompt",
    options.agentPath,
    "--tools",
    resolveSubagentTools(options.tools).join(","),
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
      env: { ...process.env, [GUARDRAIL_RELAY_ENV]: relay ? JSON.stringify(relay) : undefined },
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
        "--thinking",
        options.effort || DEFAULT_SUBAGENT_EFFORT,
        "--append-system-prompt",
        options.agentPath,
        "--tools",
        resolveSubagentTools(options.tools).join(","),
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
  const promptStartedAt = Date.now();
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

    // Herdr's prompt waiter requires its detector to observe a state change
    // within five seconds when the prompt starts from idle. Pi can accept the
    // prompt and begin writing the session before Herdr notices that change;
    // in that case Herdr returns agent_prompt_stalled even though the visible
    // agent is actively working. Do not fail the workflow or interrupt the
    // agent just because the detector missed the transition. The session file
    // is the authoritative turn stream, so wait for its final assistant turn.
    const stalled =
      promptError instanceof HerdrError &&
      (promptError.code === "agent_prompt_stalled" ||
        /no observed state change within 5000 ms/i.test(promptError.message));
    if (stalled && !options.signal.aborted) {
      emitProgress({
        kind: "started",
        message: "Herdr did not observe the prompt transition; following the live pi session instead",
      });
      const remainingMs = Math.max(
        1_000,
        PHASE_TIMEOUT_MS - (Date.now() - promptStartedAt),
      );
      const completed = await tailer.waitForCompletedAssistant(remainingMs, options.signal);
      if (completed) {
        promptError = undefined;
        settledStatus = "idle";
      }
    }
  } finally {
    tailer.flush();
    tailer.stop();
  }

  // The 500 ms incremental poller finalizes with flush(), which silently
  // drops a trailing JSONL record if it was still being written (e.g. a large
  // final handoff). That makes AgentResult.output fall back to an earlier
  // assistant message — for a verification turn that is the "run the suite"
  // prose, not the handoff carrying status=pass/fail. Re-scan the appended
  // session window from disk once it has stabilized and take the last complete
  // assistant record as the authoritative output for the finished phase.
  const finalOutput = await tailer.captureFinalAssistantText();
  if (finalOutput) current.output = finalOutput;

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
  /** Byte offset captured when this phase's tail started; the re-scan window. */
  private windowStart = 0;

  constructor(
    private readonly filePath: string,
    private readonly onEntry: (entry: any) => void,
  ) {}

  /** Ignore a previous prompt's records in a persistent session. */
  startAtEnd(): void {
    try {
      this.windowStart = this.offset = fs.statSync(this.filePath).size;
    } catch {
      this.windowStart = this.offset = 0;
    }
  }

  /**
   * Re-read this phase's appended window from disk and return the text of the
   * LAST complete assistant record. A bounded loop waits for a trailing write
   * to finish so the final (often large JSON) handoff is not missed when the
   * phase settles right as the process is appending it.
   */
  async captureFinalAssistantText(maxWaitMs = 2_000): Promise<string> {
    let lastText = "";
    let stableReads = 0;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      let text = "";
      try {
        const size = fs.statSync(this.filePath).size;
        const from = this.windowStart > size ? 0 : this.windowStart;
        if (size > from) {
          const descriptor = fs.openSync(this.filePath, "r");
          try {
            const buffer = Buffer.alloc(size - from);
            fs.readSync(descriptor, buffer, 0, buffer.length, from);
            for (const line of buffer.toString("utf8").split("\n")) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (entry?.type !== "message" || !entry.message) continue;
                const message = entry.message as Message;
                if (message.role !== "assistant") continue;
                const assistantText = getAssistantText(message);
                if (assistantText) text = assistantText;
              } catch {
                // Skip malformed/partial records; the loop retries below.
              }
            }
          } finally {
            fs.closeSync(descriptor);
          }
        }
      } catch {
        // Session file may not be readable yet; retry until the deadline.
      }
      if (text && text === lastText) {
        stableReads += 1;
        if (stableReads >= 2) return lastText;
      } else {
        stableReads = 0;
      }
      if (text) lastText = text;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return lastText;
  }

  /**
   * Wait for the assistant turn appended after startAtEnd() to finish. This
   * is used only when Herdr's state detector reports agent_prompt_stalled.
   * Pi records the model stop reason in the session even when Herdr continues
   * to report the pane as idle, making this independent of pane detection.
   */
  async waitForCompletedAssistant(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // If the prompt was not accepted at all, do not turn a Herdr detector
    // failure into a full phase timeout. An accepted pi prompt always appends
    // its user message before the model starts, so this is a safe guard.
    const acceptanceDeadline = Math.min(deadline, Date.now() + 10_000);
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      const turn = this.readTurnState();
      if (turn.completed) return true;
      if (!turn.accepted && Date.now() >= acceptanceDeadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return !signal?.aborted && this.readTurnState().completed;
  }

  private readTurnState(): { accepted: boolean; completed: boolean } {
    let accepted = false;
    try {
      const size = fs.statSync(this.filePath).size;
      const from = this.windowStart > size ? 0 : this.windowStart;
      if (size <= from) return { accepted, completed: false };
      const descriptor = fs.openSync(this.filePath, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        fs.readSync(descriptor, buffer, 0, buffer.length, from);
        for (const line of buffer.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const message = entry?.type === "message" ? entry.message : undefined;
            if (message?.role === "user") {
              accepted = true;
              continue;
            }
            if (message?.role !== "assistant") continue;
            // Tool turns continue with another request. Any other stop reason
            // is a completed model response, including clarification turns.
            const stopReason = (message as any).stopReason;
            if (accepted && stopReason && stopReason !== "toolUse" && stopReason !== "tool_use") {
              return { accepted: true, completed: true };
            }
          } catch {
            // Ignore a partially written record; the next poll will retry it.
          }
        }
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      // The session may be rotated or temporarily unavailable.
    }
    return { accepted, completed: false };
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
      this.windowStart = this.offset = 0;
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
