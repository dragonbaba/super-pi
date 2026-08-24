import { CONFIG_DIR_NAME, copyToClipboard, type ExtensionAPI } from "@super-pi/coding-agent";
import { collectSessionErrors, formatSessionErrorReport } from "./core.ts";
import { deliverErrorReport } from "./output.ts";

export default function sessionToolErrorsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("tool-errors", {
    description: "Copy a summary of errors from the current session branch",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /tool-errors", "warning");
        return;
      }

      const observations = collectSessionErrors(ctx.sessionManager.getBranch());
      const report = formatSessionErrorReport(observations, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: ctx.sessionManager.getSessionName(),
      });

      try {
        const delivered = await deliverErrorReport(ctx.cwd, CONFIG_DIR_NAME, report, ctx.mode === "tui", copyToClipboard);
        if (delivered.destination === "clipboard") {
          ctx.ui.notify(`Copied ${observations.length} current-branch error observation(s) to the clipboard.`, "info");
        } else {
          ctx.ui.notify(`Clipboard unavailable; error summary written to ${delivered.path}`, "warning");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown report delivery error.";
        ctx.ui.notify(`Could not deliver the error summary: ${message}`, "error");
      }
    },
  });
}
