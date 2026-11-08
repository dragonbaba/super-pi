import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@super-pi/coding-agent";
import type { MemoryConfig } from "../types.js";
import type { ProjectInfo } from "../project.js";
import { MemoryStore } from "../store/memory-store.js";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type Target = "memory" | "user" | "failure";
const MAX_PREVIEW_CHARS = 40_000;
const MENU = ["查看用户偏好", "查看全局记忆", "查看项目记忆", "查看全局纠错", "查看项目纠错",
  "整理用户偏好", "整理全局记忆", "整理项目记忆", "整理全局纠错", "整理项目纠错",
  "确认并导入旧项目条目", "管理技能", "同步搜索索引", "清理恢复产物"];
const TARGETS: readonly Target[] = ["user", "memory", "memory", "failure", "failure"];

async function regularFile(file: string): Promise<boolean> {
  try {
    const directory = await fs.lstat(path.dirname(file));
    const entry = await fs.lstat(file);
    return directory.isDirectory() && !directory.isSymbolicLink() && entry.isFile() && !entry.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Explicit, confirmed import; old basename data is never assigned during startup. */
export async function importLegacyProjectEntries(ctx: ExtensionCommandContext, config: MemoryConfig,
  project: ProjectInfo, destination: MemoryStore): Promise<void> {
  const candidates: Array<{ file: string; target: "memory" | "failure" }> = [];
  for (const directory of project.legacyMemoryDirs) {
    for (const [name, target] of [["MEMORY.md", "memory"], ["failures.md", "failure"]] as const) {
      const file = path.join(directory, name);
      if (await regularFile(file)) candidates.push({ file, target });
    }
  }
  if (!candidates.length) { ctx.ui.notify("没有找到可导入的旧项目条目。旧技能请在技能管理中逐项核对来源和路径。", "info"); return; }
  const selected = await ctx.ui.select("选择旧文件；只在确认内容属于当前项目时导入", candidates.map((candidate) => candidate.file));
  const candidate = candidates.find((item) => item.file === selected);
  if (!candidate) return;
  const source = new MemoryStore({ ...config, memoryDir: path.dirname(candidate.file) });
  const sourceEntries = await source.readEntriesWithMetadata(candidate.target);
  const old = sourceEntries.map((entry) => entry.text);
  const metadata = new Map(sourceEntries.map((entry) => [entry.text, { ...entry, project: project.name }]));
  const before = await destination.readEntries(candidate.target);
  const after = [...new Set([...before, ...old])];
  if (after.length === before.length) { ctx.ui.notify("没有需要新增的条目，原文件保留。", "info"); return; }
  const evaluation = destination.evaluateMemoryReplacement(after, candidate.target, undefined, metadata);
  if (!evaluation.success) { ctx.ui.notify(evaluation.error, "warning"); return; }
  const preview = `来源：${candidate.file}\n目标项目：${project.root}\n目标目录：${project.memoryDir}\n`
    + "旧文件会保留；请核对每条内容的归属。技能不会随条目自动迁移。\n\n" + after.join("\n§\n");
  if (preview.length > MAX_PREVIEW_CHARS) { ctx.ui.notify("导入预览过长，请先分批整理旧文件。没有导入。", "warning"); return; }
  if (await ctx.ui.editor("旧项目条目导入预览（只读）", preview) === undefined) return;
  if (!await ctx.ui.confirm("确认这些条目属于当前项目？", `${project.root}\n将新增 ${after.length - before.length} 条；旧文件保留。`)) return;
  if (!await regularFile(candidate.file)) { ctx.ui.notify("旧文件类型或路径已变化，请重新预览。没有导入。", "warning"); return; }
  const current = await source.readEntriesWithMetadata(candidate.target);
  if (current.length !== sourceEntries.length || current.some((entry, index) => {
    const previous = sourceEntries[index]!;
    return entry.text !== previous.text || entry.created !== previous.created
      || entry.lastReferenced !== previous.lastReferenced || entry.project !== previous.project;
  })) {
    ctx.ui.notify("旧文件在预览后已变化，请重新预览。没有导入。", "warning"); return;
  }
  const result = await destination.replaceMemoryEntriesIfUnchanged(before, after, candidate.target, undefined, metadata);
  ctx.ui.notify(result.success ? `已导入 ${after.length - before.length} 条；旧文件保留。现有会话摘要仍是启动时的快照。`
    : result.error ?? "导入未完成。", result.success ? "info" : "warning");
  if (result.warning) ctx.ui.notify(result.warning, "warning");
}

export function registerMemoryCommand(pi: ExtensionAPI, options: {
  store: MemoryStore; projectStore: MemoryStore | null; config: MemoryConfig; project: ProjectInfo;
  globalDir: string; review: CommandHandler; cleanup: CommandHandler; sync: CommandHandler; skills: CommandHandler;
}): void {
  pi.registerCommand("memory", {
    description: "统一查看、整理和导入记忆；管理技能及派生搜索索引",
    handler: async (args, ctx) => {
      const overview = `全局：${options.globalDir}\n项目：${options.project.root ?? "无"}\n项目记忆：${options.project.memoryDir ?? "无"}\n`
        + "磁盘条目是当前记录；本会话摘要保持启动时快照。整理覆盖用户/全局/项目/纠错；清理仅处理恢复产物。";
      if (!ctx.hasUI) { ctx.ui.notify(overview + "\n用 memory 工具 action=list 查看完整条目；交互界面提供预览和确认。", "info"); return; }
      try {
        if (args.trim() && args.trim() !== "import") { ctx.ui.notify("用法：/memory 或 /memory import", "warning"); return; }
        const choice = args.trim() === "import" ? MENU[10] : await ctx.ui.select(overview, MENU);
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
        if (index === 10) {
          if (!options.projectStore) { ctx.ui.notify("当前没有可接收导入的项目。", "warning"); return; }
          await importLegacyProjectEntries(ctx, options.config, options.project, options.projectStore);
        } else if (index === 11) await options.skills("", ctx);
        else if (index === 12) await options.sync("", ctx);
        else if (index === 13) await options.cleanup("", ctx);
      } catch (error) { ctx.ui.notify(`记忆管理未完成：${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
}
