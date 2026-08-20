import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// New pi sessions and child instances start here. A model selected by the user
// is kept in the current session, while this default remains unchanged.
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "openai/gpt-5.6-luna";

function restoreNewSessionDefault(cwd: string): void {
  const settings = SettingsManager.create(cwd);
  const global = settings.getGlobalSettings();

  if (
    global.defaultProvider !== DEFAULT_PROVIDER ||
    global.defaultModel !== DEFAULT_MODEL
  ) {
    settings.setDefaultModelAndProvider(DEFAULT_PROVIDER, DEFAULT_MODEL);
  }
}

async function selectNewSessionDefault(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const model = ctx.modelRegistry.find(DEFAULT_PROVIDER, DEFAULT_MODEL);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

  await pi.setModel(model);
  restoreNewSessionDefault(ctx.cwd);
}

export default function sessionDefaultModelExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    // New/forked sessions are created by reusing the runtime's initial model
    // in some pi versions. Explicitly select the configured default there.
    // Resumed sessions are deliberately left alone so their saved model wins.
    if (event.reason === "new" || event.reason === "fork") {
      await selectNewSessionDefault(pi, ctx);
    } else {
      // Repair any default left behind by an older pi session, including the
      // current global default if it was changed before this extension existed.
      restoreNewSessionDefault(ctx.cwd);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    // pi normally persists /model and Ctrl+P selections as the next global
    // default. Wait for pi's own queued settings write, then put the durable
    // default back without touching the active model in this session.
    if (event.source === "set" || event.source === "cycle") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      restoreNewSessionDefault(ctx.cwd);
    }
  });
}
