import type { ExtensionCommandContext } from "@super-pi/coding-agent";
import { loadBoundedSelector, type BoundedSelectorItem } from "@super-pi/coding-agent/internal/ui/selector-loader";
import { sanitizeSessionText } from "@super-pi/coding-agent/internal/ui/selector-text";
import { listBulkMemory, executeBulkMemoryCleanup, summarizeBulkSelection, type BulkMemoryOptions, type BulkMemoryRow, type BulkMemoryScope } from "./memory-bulk-cleanup.js";
import { preselectRawMemoryEntry, type RawMemoryFilter } from "../store/raw-memory.js";

const SCOPES = ["用户偏好", "全局记忆", "当前项目记忆", "全局纠错", "当前项目纠错", "所有项目"];
const SCOPE_IDS: BulkMemoryScope[] = ["user", "global", "project", "global-failure", "project-failure", "all-projects"];
const FILTERS = ["全部", "超过 30 天未修改", "超过 90 天未修改", "超过 180 天未修改", "自定义未修改天数"];
const TEMPORARY = "已过注入窗口的临时失败";
const OVERLAY = { overlay: true, overlayOptions: { width: 112, maxHeight: 24, margin: 2 } } as const;
const MEMORY_LABELS = { list: "记忆", detail: "所选记忆详情", hint: "空格 勾选/取消；筛选仅预选，可手动增减" };
function canSelectMemory(): boolean { return true; }

async function filterFor(ctx: ExtensionCommandContext, failures: boolean, windowDays: number): Promise<RawMemoryFilter | undefined> {
  const choices = [...FILTERS]; if (failures) choices.push(TEMPORARY);
  const selected = await ctx.ui.select("选择预选条件（未修改天数按最后修改日期；临时失败按现有创建日期注入窗口）", choices);
  if (!selected) return;
  if (selected === "全部") return { kind: "all" };
  if (selected === TEMPORARY) return { kind: "temporary", days: windowDays };
  if (selected === FILTERS[4]) {
    const raw = await ctx.ui.input("超过多少天未修改？（0 或正整数；日期未知不预选）", "30");
    if (raw === undefined) return;
    const days = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(days) || days < 0) { ctx.ui.notify("天数必须是 0 或正整数，未删除任何内容。", "warning"); return; }
    return { kind: "age", days };
  }
  const index = FILTERS.indexOf(selected);
  return index > 0 && index < 4 ? { kind: "age", days: [30, 90, 180][index - 1]! } : undefined;
}

export function prepareBulkMemoryRows(rows: readonly BulkMemoryRow[], filter: RawMemoryFilter, now: number): BoundedSelectorItem<BulkMemoryRow>[] {
  const items: BoundedSelectorItem<BulkMemoryRow>[] = [];
  for (const row of rows) {
    const { file, entry } = row, created = entry.created ?? "日期未知", modified = entry.modified ?? "日期未知";
    items.push({ value: row,
      label: `${sanitizeSessionText(file.source, 16)} ${sanitizeSessionText(entry.category, 12)} 建${created} 改${modified} ${entry.chars}字 ${entry.summary || "（空片段）"}`,
      detail: `来源：${file.snapshot.path}；类别：${entry.category}；创建：${created}；最后修改：${modified}；字符数：${entry.chars}；${entry.summary}`,
      checked: (filter.kind !== "temporary" || file.target === "failure") && preselectRawMemoryEntry(entry, filter, now) });
  }
  return items;
}

async function selectRows(ctx: ExtensionCommandContext, rows: readonly BulkMemoryRow[], filter: RawMemoryFilter): Promise<BulkMemoryRow[] | undefined> {
  const { BoundedMemorySelector } = await loadBoundedSelector();
  const items = prepareBulkMemoryRows(rows, filter, Date.now());
  try {
    return await ctx.ui.custom<BulkMemoryRow[] | undefined>((tui, theme, keybindings, done) => {
      const selector = new BoundedMemorySelector("勾选记忆；Delete 提交后仍会显示确认清单\n日期未知不会按天数预选；原文件变化时整文件跳过", items, theme, keybindings, undefined,
        () => Math.min(24, Math.max(0, tui.terminal.rows - 4)));
      selector.enableMultiSelect(done, canSelectMemory, MEMORY_LABELS);
      return selector;
    }, OVERLAY);
  } finally { items.length = 0; }
}

async function confirmRows(ctx: ExtensionCommandContext, rows: readonly BulkMemoryRow[]): Promise<boolean> {
  const { BoundedMemorySelector } = await loadBoundedSelector();
  const summary = summarizeBulkSelection(rows), items: BoundedSelectorItem<boolean>[] = [];
  for (const file of summary.files) items.push({ value: false, label: `${file.count} 条 · ${file.characters} 字符 · ${file.file.snapshot.path}`,
    detail: file.file.snapshot.path, selectable: false });
  items.push({ value: true, label: `删除已选 ${summary.count} 条`, dangerous: true }, { value: false, label: "取消，保留全部记忆" });
  try {
    return (await ctx.ui.custom<boolean | undefined>((tui, theme, keybindings, done) => new BoundedMemorySelector(
      `确认删除 ${summary.count} 条记忆、${summary.files.length} 个文件中的 ${summary.characters} 字符？\n只删除选中片段；文件有外部改动时跳过，未选内容保留原始字节。`,
      items, theme, keybindings, done, () => Math.min(24, Math.max(0, tui.terminal.rows - 4)), items.length - 1), OVERLAY)) === true;
  } finally { items.length = 0; summary.files.length = 0; }
}

async function showWarnings(ctx: ExtensionCommandContext, warnings: readonly string[]): Promise<void> {
  const { BoundedMemorySelector } = await loadBoundedSelector();
  const items: BoundedSelectorItem<boolean>[] = [];
  for (const warning of warnings) items.push({ value: false, label: warning, detail: warning, selectable: false });
  items.push({ value: false, label: "关闭报告" });
  try {
    await ctx.ui.custom<boolean | undefined>((tui, theme, keybindings, done) => new BoundedMemorySelector(
      "清理报告（可逐项浏览）\n搜索索引未同步时可能仍搜到已删条目；用 /memory → 同步搜索索引 恢复。", items,
      theme, keybindings, done, () => Math.min(24, Math.max(0, tui.terminal.rows - 4)), items.length - 1), OVERLAY);
  } finally { items.length = 0; }
}

export async function runBulkMemoryCommand(options: BulkMemoryOptions, ctx: ExtensionCommandContext): Promise<void> {
  const scopeName = await ctx.ui.select("批量清理记忆：选择范围（不会自动删除过期条目）", SCOPES);
  const index = SCOPES.indexOf(scopeName ?? ""), scope = SCOPE_IDS[index];
  if (!scope) return;
  const filter = await filterFor(ctx, scope === "global-failure" || scope === "project-failure" || scope === "all-projects", options.config.failureInjectionMaxAgeDays);
  if (!filter) return;
  const list = await listBulkMemory(options, scope);
  try {
    if (list.legacyDirectories) ctx.ui.notify(`另有 ${list.legacyDirectories} 个旧目录未列出；本次不会读取或删除。`, "info");
    if (!list.rows.length) { ctx.ui.notify("此范围没有可清理的记忆。", "info"); if (list.warnings.length) await showWarnings(ctx, list.warnings); return; }
    const selected = await selectRows(ctx, list.rows, filter);
    if (!selected?.length) return;
    try {
      if (!await confirmRows(ctx, selected)) return;
      const report = await executeBulkMemoryCleanup(options, selected);
      ctx.ui.notify(`已从 Markdown 删除 ${report.deleted} 条，释放 ${report.characters} 字符；更新 ${report.changedFiles} 个文件，跳过 ${report.skippedFiles} 个文件。\n本会话启动摘要仍保持原快照。`, report.warnings.length ? "warning" : "info");
      if (report.warnings.length) ctx.ui.notify("搜索索引未同步时，memory_search 可能仍搜到已删条目；请用 /memory → 同步搜索索引 恢复。", "warning");
      for (const warning of report.warnings) list.warnings.push(warning);
      if (list.warnings.length) await showWarnings(ctx, list.warnings);
    } finally { selected.length = 0; }
  } finally { list.rows.length = 0; list.files.length = 0; list.warnings.length = 0; }
}
