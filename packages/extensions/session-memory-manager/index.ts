import { join } from "node:path";
import {
  getAgentDir,
  SessionManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@super-pi/coding-agent";
import { deleteSessions, occupiedSessionPaths, deleteSessionTrashCandidates, inspectSessionTrash,
  type DeletionFailure, type SessionTrashEntry } from "./core.ts";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.ts";
import { MAX_UI_ERROR, sanitizeSessionText } from "./ui-text.ts";
import { loadBoundedSelector, type BoundedSelectorItem } from "@super-pi/coding-agent/internal/ui/selector-loader";

const AGENT_DIR = getAgentDir();
const TRASH_DIR = join(AGENT_DIR, "@super-pi/memory", "session-trash");
const LEASE_DIR = join(AGENT_DIR, "@super-pi/memory", "session-leases");
const BYTE_FORMATTER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const SESSION_CLEAN_OVERLAY_MARGIN = 2;
const SESSION_CLEAN_OVERLAY_MAX_HEIGHT = 24;
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function shortDate(date: Date): string {
  return SHORT_DATE_FORMATTER.format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${BYTE_FORMATTER.format(bytes / 1024)} KiB`;
  return `${BYTE_FORMATTER.format(bytes / (1024 * 1024))} MiB`;
}

function trashAgeText(oldestMtimeMs: number | null): string {
  if (oldestMtimeMs === null) return "无";
  const ageDays = Math.max(0, (Date.now() - oldestMtimeMs) / (24 * 60 * 60 * 1000));
  return `${BYTE_FORMATTER.format(ageDays)} 天`;
}

export function formatTrashEntryLabel(entry: Pick<SessionTrashEntry, "name" | "size" | "mtimeMs">, index: number): string {
  const parts = entry.name.split("_");
  const sessionId = parts.length > 1 ? sanitizeSessionText(parts[1], 12) : "";
  const id = sessionId ? `ID:${sessionId}` : "ID:未知";
  return `${index + 1}. ${shortDate(new Date(entry.mtimeMs))} · ${formatBytes(entry.size)} · ${id}`;
}

export async function selectBounded<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: readonly BoundedSelectorItem<T>[],
  initialIndex?: number,
): Promise<T | undefined> {
  const { BoundedMemorySelector } = await loadBoundedSelector();
  return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
    return new BoundedMemorySelector(
      title,
      items,
      theme,
      keybindings,
      done,
      () => Math.min(SESSION_CLEAN_OVERLAY_MAX_HEIGHT, Math.max(0, tui.terminal.rows - SESSION_CLEAN_OVERLAY_MARGIN * 2)),
      initialIndex,
    );
  }, {
    overlay: true,
    overlayOptions: {
      width: 96,
      maxHeight: SESSION_CLEAN_OVERLAY_MAX_HEIGHT,
      margin: SESSION_CLEAN_OVERLAY_MARGIN,
    },
  });
}

async function confirmTrashDeletion(
  ctx: ExtensionCommandContext,
  entries: readonly SessionTrashEntry[],
): Promise<boolean> {
  const items: BoundedSelectorItem<boolean>[] = entries.map((entry, index) => ({
    value: false,
    label: formatTrashEntryLabel(entry, index),
    description: "待永久删除",
    detail: sanitizeSessionText(entry.filePath, Infinity),
    selectable: false,
  }));
  items.push(
    {
      value: true,
      label: `永久删除以上 ${entries.length} 个回收文件`,
      description: "不可恢复",
      dangerous: true,
      tone: "danger",
    },
    { value: false, label: "取消，保留全部回收文件" },
  );
  return (await selectBounded(
    ctx,
    `确认永久删除旧 Session 回收文件？\n固定回收目录：${TRASH_DIR}\n候选清单可滚动；不会删除未列出的文件。`,
    items,
    items.length - 1,
  )) === true;
}

function deletionSummary(deleted: number, failures: readonly DeletionFailure[]): string {
  const lines = [`删除成功 ${deleted} 个；删除失败 ${failures.length} 个。`];
  for (const failure of failures) lines.push(`删除失败：${sanitizeSessionText(failure.path)} — ${sanitizeSessionText(failure.error, MAX_UI_ERROR)}`);
  return lines.join("\n");
}

function newestSessionFirst(a: SessionInfo, b: SessionInfo): number { return b.modified.getTime() - a.modified.getTime(); }

async function selectSessions(ctx: ExtensionCommandContext, sessions: SessionInfo[], failures: ReadonlyMap<string, string>, checked: ReadonlySet<string>): Promise<SessionInfo[] | undefined> {
  const { BoundedMemorySelector } = await loadBoundedSelector();
  const occupied = occupiedSessionPaths(sessions, ctx.sessionManager.getSessionFile(), LEASE_DIR);
  const items: BoundedSelectorItem<SessionInfo>[] = [];
  for (const session of sessions) {
    const error = failures.get(session.path);
    items.push({ value: session,
      label: `${shortDate(session.modified)} ${sanitizeSessionText(session.name || session.firstMessage, 54) || "(空会话)"}`,
      description: error ? `删除失败：${sanitizeSessionText(error, MAX_UI_ERROR)}` : `${session.messageCount} 条 · ${sanitizeSessionText(session.id, 80)}`,
      detail: error ? `${session.path} — 删除失败：${sanitizeSessionText(error, MAX_UI_ERROR)}` : session.path,
      disabled: occupied.has(session.path), checked: checked.has(session.path),
    });
  }
  return ctx.ui.custom<SessionInfo[] | undefined>((tui, theme, keybindings, done) => {
    const selector = new BoundedMemorySelector("勾选要删除的 Session；使用中不可勾选", items, theme, keybindings, undefined,
      () => Math.min(SESSION_CLEAN_OVERLAY_MAX_HEIGHT, Math.max(0, tui.terminal.rows - SESSION_CLEAN_OVERLAY_MARGIN * 2)));
    selector.enableMultiSelect(done, session => {
      try { return !occupiedSessionPaths([session], ctx.sessionManager.getSessionFile(), LEASE_DIR).has(session.path); }
      catch (error) { ctx.ui.notify(`无法核对占用：${sanitizeSessionText(error, MAX_UI_ERROR)}`, "error"); return false; }
    });
    return selector;
  }, { overlay: true, overlayOptions: { width: 96, maxHeight: SESSION_CLEAN_OVERLAY_MAX_HEIGHT, margin: SESSION_CLEAN_OVERLAY_MARGIN } });
}

export default function sessionMemoryManager(pi: ExtensionAPI): void {
  if (!SUPPORTED_SP_VERSION_PATTERN.test(VERSION)) {
    console.warn(`@super-pi/session-memory-manager disabled: Pi ${VERSION} is unsupported (requires 1.x or 0.84.x).`);
    return;
  }
  pi.registerCommand("memory-sessions", {
    description: "勾选、删除历史 Session，查看状态并清理旧回收文件",
    handler: async (rawArgs, ctx) => {
      await ctx.waitForIdle();
      const args = rawArgs.trim();
      try {
        if (args === "clean") {
          const trash = inspectSessionTrash(TRASH_DIR);
          if (!trash.deletionBatch.length) { ctx.ui.notify("没有需要清理的旧 Session 回收文件。", "info"); return; }
          if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("请在交互界面复核清理候选。", "info"); return; }
          if (!await confirmTrashDeletion(ctx, trash.deletionBatch)) return;
          const result = deleteSessionTrashCandidates(TRASH_DIR, trash.deletionBatch, LEASE_DIR);
          ctx.ui.notify(deletionSummary(result.files, result.failures), result.failures.length ? "warning" : "info");
          return;
        }
        if (args === "status") {
          const sessions = await SessionManager.listAll();
          const occupied = occupiedSessionPaths(sessions, ctx.sessionManager.getSessionFile(), LEASE_DIR);
          const trash = inspectSessionTrash(TRASH_DIR);
          ctx.ui.notify(`Session 文件 ${sessions.length} 个，使用中 ${occupied.size} 个。\n旧回收目录 ${trash.totalFiles} 个文件、${formatBytes(trash.totalBytes)}，最老 ${trashAgeText(trash.oldestMtimeMs)}；可清理 ${trash.cleanupCandidates.length} 个。`, "info");
          return;
        }
        if (args && !args.startsWith("delete ")) { ctx.ui.notify("用法：/memory-sessions [status|clean|delete <session-id>]", "warning"); return; }
        if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("请在交互界面勾选和确认删除 Session。", "info"); return; }
        const getCurrentFile = () => ctx.sessionManager.getSessionFile();
        const failures = new Map<string, string>();
        const checked = new Set<string>();
        while (true) {
          const sessions = (await SessionManager.listAll()).sort(newestSessionFirst);
          if (!sessions.length) { ctx.ui.notify("没有历史 Session。", "info"); return; }
          let selected: SessionInfo[] | undefined;
          if (args.startsWith("delete ")) {
            const id = args.slice("delete ".length).trim();
            selected = sessions.filter(session => session.id === id);
            if (selected.length !== 1) { ctx.ui.notify(`Session ID 不存在或不唯一：${sanitizeSessionText(id, 80)}`, "warning"); return; }
          } else selected = await selectSessions(ctx, sessions, failures, checked);
          if (!selected?.length) return;
          checked.clear();
          for (const session of selected) checked.add(session.path);
          if (!await ctx.ui.confirm(`删除已选 ${selected.length} 个 Session？`, "直接删除已勾选的会话文件。使用中的会话会跳过，并报告具体失败原因。")) {
            if (args) return;
            continue;
          }
          const result = deleteSessions(selected, getCurrentFile, LEASE_DIR);
          ctx.ui.notify(deletionSummary(result.deleted.length, result.failures), result.failures.length ? "warning" : "info");
          if (args) return;
          failures.clear();
          checked.clear();
          for (const failure of result.failures) { failures.set(failure.path, failure.error); checked.add(failure.path); }
        }
      } catch (error) { ctx.ui.notify(`Session 管理失败：${sanitizeSessionText(error, MAX_UI_ERROR)}`, "error"); }
    },
  });
}
