import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

function hasExplicitModelArgument(): boolean {
  const args = process.argv.slice(2);
  return args.some((arg) => arg === "--model" || arg.startsWith("--model="));
}

async function selectSavedDefault(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  // Pi persists the model selected with Ctrl+S in its global settings. Do not
  // replace that choice with a package-specific model when creating /new.
  const settings = SettingsManager.create(ctx.cwd).getGlobalSettings();
  if (!settings.defaultProvider || !settings.defaultModel) return;

  const model = ctx.modelRegistry.find(
    settings.defaultProvider,
    settings.defaultModel,
  );
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

  await pi.setModel(model);
}

export default function sessionDefaultModelExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    // Some Pi versions reuse the runtime's initial model for /new and forks.
    // Reapply the user's saved default only for those fresh sessions; resumed
    // sessions retain the model recorded in their own history.
    if (
      (event.reason === "new" || event.reason === "fork") &&
      !hasExplicitModelArgument()
    ) {
      await selectSavedDefault(pi, ctx);
    }
  });
}
