import type { ExtensionAPI } from "@super-pi/coding-agent";
import type { BulkMemoryOptions } from "./memory-bulk-cleanup.js";

export function createLazyBulkMemoryHandler(options: BulkMemoryOptions): Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] {
  return async (args, ctx) => {
    if (args.trim()) { ctx.ui.notify("用法：/memory → 批量清理记忆", "warning"); return; }
    if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("请在交互终端打开 /memory → 批量清理记忆；未删除任何内容。", "info"); return; }
    const { runBulkMemoryCommand } = await import("./memory-bulk-command.js");
    await runBulkMemoryCommand(options, ctx);
  };
}
