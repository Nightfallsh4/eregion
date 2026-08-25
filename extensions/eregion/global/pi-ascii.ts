import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader(() => {
      // Read the current theme inside render(). Pi may create the header before
      // package-provided themes are registered during resources_discover; a
      // theme captured by the factory would leave the ASCII art using the
      // startup fallback color until the user manually changes themes.
      const a = (text: string) => ctx.ui.theme.fg("accent", text);
      const d = (text: string) => ctx.ui.theme.fg("dim", text);

      const artLines = [
        `███████╗██████╗  ███████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗`,
        `██╔════╝██╔══██╗ ██╔════╝██╔════╝ ██║██╔═══██╗████╗  ██║`,
        `█████╗  ██████╔╝ █████╗  ██║  ███╗██║██║   ██║██╔██╗ ██║`,
        `██╔══╝  ██╔══██╗ ██╔══╝  ██║   ██║██║██║   ██║██║╚██╗██║`,
        `███████╗██║  ██║ ███████╗╚██████╔╝██║╚██████╔╝██║ ╚████║`,
        `╚══════╝╚═╝  ╚═╝ ╚══════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝  ╚═══╝`,
      ];

      const artWidth = Math.max(...artLines.map((l) => l.length));

      return {
        render(width: number): string[] {
          const pad = Math.max(0, Math.floor((width - artWidth) / 2));
          const sp = " ".repeat(pad);
          return [
            "",
            ...artLines.map((line) => `${sp}${a(line)}`),
            `${sp}${d("RINGS OF POWER ARE FORGED HERE")}`,
            "",
          ];
        },
        invalidate() {},
      };
    });
  });

  pi.registerCommand("builtin-header", {
    description: "Restore built-in header with keybinding hints",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
