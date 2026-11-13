import type { ExtensionAPI } from "@super-pi/coding-agent";
import type { ProjectInfo } from "../project.js";
import { MemoryStore } from "../store/memory-store.js";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type Target = "memory" | "user" | "failure";
const MAX_PREVIEW_CHARS = 40_000;
const MENU = ["查看用户偏好", "查看全局记忆", "查看项目记忆", "查看全局纠错", "查看项目纠错",
  "整理用户偏好", "整理全局记忆", "整理项目记忆", "整理全局纠错", "整理项目纠错",
  "管理技能", "同步搜索索引", "清理恢复产物", "批量清理记忆"];
const TARGETS: readonly Target[] = ["user", "memory", "memory", "failure", "failure"];

export function registerMemoryCommand(pi: ExtensionAPI, options: {
  store: MemoryStore; projectStore: MemoryStore | null; project: ProjectInfo;
  globalDir: string; review: CommandHandler; cleanup: CommandHandler; sync: CommandHandler; skills: CommandHandler; bulk: CommandHandler;
}): void {
  pi.registerCommand("memory", {
    description: "统一查看和整理记忆；管理技能及派生搜索索引",
    handler: async (args, ctx) => {
      const overview = `全局：${options.globalDir}\n项目：${options.project.root ?? "无"}\n项目记忆：${options.project.memoryDir ?? "无"}\n`
        + "磁盘条目是当前记录；本会话摘要保持启动时快照。可整理记忆、勾选批量清理，或单独清理恢复产物。";
      if (!ctx.hasUI) { ctx.ui.notify(overview + "\n用 memory 工具 action=list 查看完整条目；交互界面提供预览和确认。", "info"); return; }
      try {
        if (args.trim()) { ctx.ui.notify("用法：/memory；旧目录导入已退役，原文件保留。", "warning"); return; }
        const choice = await ctx.ui.select(overview, MENU);
        const index = MENU.indexOf(choice ?? "");
        if (index < 0) return;
        if (index < 10) {
          const kind = index % 5, target = TARGETS[kind]!;
          const isProject = kind === 2 || kind === 4;
          const store = isProject ? options.projectStore : options.store;
          if (!store) { ctx.ui.notify("当前没有项目记忆范围。", "warning"); return; }
          if (index >= 5) { await options.review(`${isProject ? "project" : "global"} ${target}`, ctx); return; }
          let offset = 0;
          while (true) {
            const page = await store.listEntries(target, offset, 20, !isProject && target === "failure" ? null : undefined);
            const text = `来源：${page.source}\n共 ${page.total} 条；本页从 ${offset + 1} 开始。\n\n`
              + page.entries.map((entry, row) => `${offset + row + 1}. ${entry.text}`).join("\n\n");
            if (text.length > MAX_PREVIEW_CHARS) { ctx.ui.notify("本页过长，请使用 memory action=list 并减小 limit。", "warning"); return; }
            if (await ctx.ui.editor("当前记忆（只读；编辑不会保存）", text) === undefined || page.nextOffset === null) return;
            if (await ctx.ui.select("继续查看？", ["下一页", "返回"]) !== "下一页") return;
            offset = page.nextOffset;
          }
        }
        if (index === 10) await options.skills("", ctx);
        else if (index === 11) await options.sync("", ctx);
        else if (index === 12) await options.cleanup("", ctx);
        else if (index === 13) await options.bulk("", ctx);
      } catch (error) { ctx.ui.notify(`记忆管理未完成：${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
}
