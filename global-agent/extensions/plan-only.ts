/**
 * Plan Only Mode Extension
 *
 * A read-only mode that blocks all file writes, edits, and file creation.
 * Toggle on/off with Ctrl+Shift+P or /plan-only command.
 *
 * Blocks:
 * - write tool (file creation/overwriting)
 * - edit tool (file modifications)
 * - Destructive bash commands (rm, mv, cp, mkdir, touch, >, >>, git add, etc.)
 *
 * Installation: Place in ~/.pi/agent/extensions/plan-only.ts and run /reload
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Destructive bash patterns that modify files or the system
const DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // single > (redirect/create)
	/>>/, // append (still modifies files)
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
];

const PLAN_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "rg", "fd"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "rg", "fd"];

export default function planOnlyExtension(pi: ExtensionAPI): void {
	let planOnlyEnabled = false;
	let persistedState = false;

	// --plan-only CLI flag for starting in plan mode
	pi.registerFlag("plan-only", {
		description: "Start in plan-only mode (read-only, no file modifications)",
		type: "boolean",
		default: false,
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		// Restore persisted state first
		if (!persistedState) {
			const entries = ctx.sessionManager.getEntries();
			const stateEntry = entries
				.filter((e: any) => e.type === "custom" && e.customType === "plan-only-state")
				.pop() as { data?: { enabled: boolean } } | undefined;

			if (stateEntry?.data) {
				planOnlyEnabled = stateEntry.data.enabled ?? false;
			}
			persistedState = true;
		}

		// --plan-only CLI flag takes precedence over persisted state
		if (pi.getFlag("plan-only") === true) {
			planOnlyEnabled = true;
		}

		applyMode(ctx);
	});

	function togglePlanOnly(ctx: ExtensionContext): void {
		planOnlyEnabled = !planOnlyEnabled;
		applyMode(ctx);
		persistState();
	}

	function applyMode(ctx: ExtensionContext): void {
		if (planOnlyEnabled) {
			pi.setActiveTools(PLAN_ONLY_TOOLS);
			ctx.ui.setStatus("plan-only", ctx.ui.theme.fg("warning", "🔒 PLAN ONLY"));
		} else {
			pi.setActiveTools(FULL_TOOLS); // Restore all tools
			ctx.ui.setStatus("plan-only", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-only-state", { enabled: planOnlyEnabled });
	}

	// /plan-only command
	pi.registerCommand("plan-only", {
		description: "Toggle plan-only mode (read-only, no file modifications)",
		handler: async (_args, ctx) => togglePlanOnly(ctx),
	});

	// Hotkey: Ctrl+Alt+P (Ctrl+Shift+P conflicts with pi's built-in app.model.cycleBackward)
	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan-only mode",
		handler: async (ctx) => togglePlanOnly(ctx),
	});

	// Block write and edit tools directly
	pi.on("tool_call", async (event, ctx) => {
		if (!planOnlyEnabled) return;

		// Block the write tool (creates/overwrites files)
		if (event.toolName === "write") {
			return {
				block: true,
				reason:
					"🔒 Plan-only mode: 'write' tool is blocked. You are in read-only mode and cannot create or modify files. Use /plan-only or Ctrl+Shift+P to disable plan-only mode if you need to write files.",
			};
		}

		// Block the edit tool (modifies files)
		if (event.toolName === "edit") {
			return {
				block: true,
				reason:
					"🔒 Plan-only mode: 'edit' tool is blocked. You are in read-only mode and cannot modify files. Use /plan-only or Ctrl+Shift+P to disable plan-only mode if you need to edit files.",
			};
		}

		// Block destructive bash commands
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(command))) {
				return {
					block: true,
					reason:
						`🔒 Plan-only mode: bash command blocked because it could modify files or the system.\nCommand: ${command}\n\nUse /plan-only or Ctrl+Shift+P to disable plan-only mode first.`,
				};
			}
		}
	});

	// Inject context about plan-only mode into the system prompt
	pi.on("before_agent_start", async () => {
		if (!planOnlyEnabled) return;

		return {
			message: {
				customType: "plan-only-context",
				content: `[PLAN-ONLY MODE ACTIVE]
You are in PLAN-ONLY mode - a read-only exploration mode for safe code analysis.

RESTRICTIONS:
- You CANNOT use: write, edit (file creation and modification tools are blocked)
- You CAN use: read, bash (limited), grep, find, ls, rg, fd
- Bash commands that modify files or the system are blocked

WHAT YOU CAN DO:
- Read and explore code
- Search for patterns and files
- Ask clarifying questions
- Analyze the codebase and provide suggestions
- Create detailed plans with numbered steps

WHAT YOU CANNOT DO:
- Write new files
- Edit existing files
- Run destructive bash commands (rm, mv, cp, mkdir, touch, git add/commit, redirects, etc.)

If the user asks you to make changes, explain what changes are needed but tell them to disable plan-only mode first with /plan-only or Ctrl+Shift+P.`,
				display: false,
			},
		};
	});

	// Filter out stale plan-only context messages from LLM context when plan-only mode is disabled.
	// Otherwise, old "You are in PLAN-ONLY mode" messages remain in the session history and
	// the LLM keeps believing it's still in plan-only mode after toggling off.
	pi.on("context", async (event) => {
		if (planOnlyEnabled) return;

		return {
			messages: event.messages.filter((m: any) => {
				if (m.customType === "plan-only-context") return false;
				if (m.role !== "user") return true;

				const content = m.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN-ONLY MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c: any) => c.type === "text" && (c as any).text?.includes("[PLAN-ONLY MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});
}