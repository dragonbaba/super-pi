import { basename, join } from "node:path";
import {
  getAgentDir,
  SessionManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@super-pi/coding-agent";
import {
  cleanOrphanIndex,
  cleanStaleIndex,
  databaseCounts,
  deleteSessionTrashCandidates,
  inspectSessionTrash,
  listOrphanIndexedSessions,
  listStaleIndexedSessions,
  sameFile,
  trashSession,
  type ManagedSession,
} from "./core.ts";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.ts";
import { MAX_UI_ERROR, sanitizeSessionText } from "./ui-text.ts";
import { sessionIdIsLeased, SessionLease } from "./lease.ts";
import { BoundedMemorySelector, type BoundedSelectorItem } from "./bounded-selector.ts";

const AGENT_DIR = getAgentDir();
const DATABASE_PATH = join(AGENT_DIR, "@super-pi/memory", "sessions.db");
const TRASH_DIR = join(AGENT_DIR, "@super-pi/memory", "session-trash");
const LEASE_DIR = join(AGENT_DIR, "@super-pi/memory", "session-leases");
const LEASE_STATE_KEY = Symbol.for("pi.@super-pi/session-memory-manager.lease-state");
const BYTE_FORMATTER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type GlobalLeaseState = { lease?: SessionLease };

function globalLeaseState(): GlobalLeaseState {
  const root = globalThis as typeof globalThis & { [LEASE_STATE_KEY]?: GlobalLeaseState };
  return root[LEASE_STATE_KEY] ??= {};
}

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

function sessionLabel(session: SessionInfo): string {
  const title = sanitizeSessionText(session.name || session.firstMessage, 54) || "(空会话)";
  return `${shortDate(session.modified)}  ${title}  [${session.messageCount}]  ID:${sanitizeSessionText(session.id, 80)}`;
}

async function selectBounded<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: readonly BoundedSelectorItem<T>[],
): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
    const terminalRows = Math.max(12, tui.terminal.rows);
    const maxDetailLines = terminalRows < 18 ? 2 : 4;
    const maxVisible = Math.max(2, Math.min(10, terminalRows - (8 + maxDetailLines)));
    return new BoundedMemorySelector(title, items, maxVisible, theme, keybindings, done, maxDetailLines);
  });
}

async function confirmTrashDeletion(
  ctx: ExtensionCommandContext,
  entries: readonly { filePath: string; size: number }[],
): Promise<boolean> {
  const items: BoundedSelectorItem<boolean>[] = entries.map((entry, index) => ({
    value: false,
    label: `${index + 1}. ${sanitizeSessionText(basename(entry.filePath), 512)}`,
    description: formatBytes(entry.size),
    detail: sanitizeSessionText(entry.filePath, 1024),
    selectable: false,
  }));
  items.push(
    {
      value: true,
      label: `永久删除以上 ${entries.length} 个回收文件`,
      description: "不可恢复",
      tone: "danger",
    },
    { value: false, label: "取消，保留全部回收文件" },
  );
  return (await selectBounded(
    ctx,
    `再次确认永久删除 Session 回收文件？\n固定目录：${TRASH_DIR}\n文件清单可滚动；不会删除未列出的文件。`,
    items,
  )) === true;
}

async function deleteSession(
  session: SessionInfo,
  getCurrentFile: () => string | undefined,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<string | null> {
  if (sameFile(session.path, getCurrentFile())) {
    throw new Error("不能删除当前正在使用的 Session；请先 /new 或切换到其他 Session");
  }

  const accepted = await confirm(
    "删除 Session？",
    `${sessionLabel(session)}\n\n会话将移入可恢复目录，并同步清理 Hermes 搜索索引。`,
  );
  if (!accepted) return null;
  return trashSession(session as ManagedSession, getCurrentFile, DATABASE_PATH, TRASH_DIR, LEASE_DIR);
}

export default function sessionMemoryManager(pi: ExtensionAPI): void {
  if (!SUPPORTED_SP_VERSION_PATTERN.test(VERSION)) {
    console.warn(`@super-pi/session-memory-manager disabled: Pi ${VERSION} is unsupported (requires 0.84.x).`);
    return;
  }
  pi.on("session_start", (_event, ctx) => {
    const state = globalLeaseState();
    const getSessionFile = () => ctx.sessionManager.getSessionFile();
    const getSessionId = () => ctx.sessionManager.getHeader()?.id;
    if (state.lease) state.lease.setSessionPathGetter(getSessionFile, getSessionId);
    else {
      state.lease = new SessionLease(LEASE_DIR, getSessionFile, undefined, getSessionId);
      state.lease.start();
    }
  });

  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "resume" || !event.targetSessionFile) return;
    const state = globalLeaseState();
    try {
      state.lease?.reserveSessionPath(event.targetSessionFile);
    } catch (error) {
      const detail = sanitizeSessionText(error instanceof Error ? error.message : error, MAX_UI_ERROR);
      ctx.ui.notify(`无法预留目标 Session，已取消切换：${detail}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_shutdown", (event) => {
    const state = globalLeaseState();
    if (!state.lease) return;
    if (event.targetSessionFile) {
      const target = event.targetSessionFile;
      state.lease.setSessionPathGetter(() => target, () => undefined);
      return;
    }
    if (event.reason === "reload") return;
    state.lease.stop();
    state.lease = undefined;
  });

  pi.registerCommand("memory-sessions", {
    description: "管理 Pi Session，并同步维护 Hermes 搜索索引",
    handler: async (rawArgs, ctx) => {
      await ctx.waitForIdle();
      const args = rawArgs.trim();

      try {
        if (args === "clean") {
          const currentFile = ctx.sessionManager.getSessionFile();
          const currentId = ctx.sessionManager.getHeader()?.id;
          const diskSessions = await SessionManager.listAll();
          const diskIds = new Set(diskSessions.map((session) => session.id));
          const stale = listStaleIndexedSessions(DATABASE_PATH, currentFile);
          const orphans = listOrphanIndexedSessions(DATABASE_PATH).filter((row) =>
            row.session_id !== currentId && !diskIds.has(row.session_id) && !sessionIdIsLeased(LEASE_DIR, row.session_id)
          );
          const trash = inspectSessionTrash(TRASH_DIR);
          const indexTotal = stale.length + orphans.length;
          if (indexTotal === 0 && trash.cleanupCandidates.length === 0) {
            ctx.ui.notify("没有可确认清理的失效索引、孤儿索引或超限 Session 回收文件", "info");
            return;
          }
          const previewLines: string[] = [];
          for (const row of stale) {
            if (previewLines.length >= 8) break;
            previewLines.push(`- 缺失文件 ${sanitizeSessionText(row.session_id, 80)}: ${sanitizeSessionText(row.path)}`);
          }
          for (const row of orphans) {
            if (previewLines.length >= 8) break;
            previewLines.push(`- 无文件映射 ${sanitizeSessionText(row.session_id, 80)} (${row.message_count} 条消息)`);
          }
          const omittedIndexes = Math.max(0, indexTotal - previewLines.length);
          const preview = previewLines.join("\n");
          const suffix = omittedIndexes > 0 ? `\n…另有 ${omittedIndexes} 个索引项` : "";
          const accepted = await ctx.ui.confirm(
            "确认 Session 清理计划？",
            `索引：${stale.length} 个缺失映射、${orphans.length} 个孤儿。回收站：${trash.cleanupCandidates.length} 个候选、${formatBytes(trash.cleanupCandidateBytes)}；本轮永久删除至多 ${trash.deletionBatch.length} 个。此步不会删除现存 JSONL。\n\n${preview}${suffix}`,
          );
          if (!accepted) return;
          const removedStale = cleanStaleIndex(DATABASE_PATH, stale, () => ctx.sessionManager.getSessionFile());
          const removedOrphans = cleanOrphanIndex(DATABASE_PATH, orphans, LEASE_DIR, () => ctx.sessionManager.getHeader()?.id);
          let deletedFiles = 0;
          let deletedBytes = 0;
          if (trash.deletionBatch.length > 0) {
            const permanentAccepted = await confirmTrashDeletion(ctx, trash.deletionBatch);
            if (permanentAccepted) {
              const deleted = deleteSessionTrashCandidates(TRASH_DIR, trash.deletionBatch, LEASE_DIR);
              deletedFiles = deleted.files;
              deletedBytes = deleted.bytes;
            }
          }
          ctx.ui.notify(
            `已清理 ${removedStale} 个失效映射、${removedOrphans} 个孤儿索引；永久删除 ${deletedFiles} 个回收文件（${formatBytes(deletedBytes)}）`,
            "info",
          );
          return;
        }

        if (args === "status") {
          const sessions = await SessionManager.listAll();
          const counts = databaseCounts(DATABASE_PATH);
          const trash = inspectSessionTrash(TRASH_DIR);
          const ignored = trash.ignoredFiles > 0 ? `；另有 ${trash.ignoredFiles} 个非托管普通文件，绝不自动删除` : "";
          ctx.ui.notify(
            `Session 文件 ${sessions.length} 个；索引 ${counts.sessions} 个；消息 ${counts.messages} 条\n回收站 ${trash.totalFiles} 个、${formatBytes(trash.totalBytes)}，最老 ${trashAgeText(trash.oldestMtimeMs)}；候选 ${trash.cleanupCandidates.length} 个、${formatBytes(trash.cleanupCandidateBytes)}${ignored}\n运行 /memory-sessions clean 可在有界滚动清单中复核永久删除候选。`,
            "info",
          );
          return;
        }

        const sessions = (await SessionManager.listAll()).sort(
          (a, b) => b.modified.getTime() - a.modified.getTime(),
        );
        const getCurrentFile = () => ctx.sessionManager.getSessionFile();

        if (args.startsWith("delete ")) {
          const id = args.slice("delete ".length).trim();
          const matches = sessions.filter((session) => session.id === id);
          if (matches.length !== 1) {
            ctx.ui.notify(matches.length === 0 ? `找不到 Session ID：${sanitizeSessionText(id, 80)}` : `Session ID 不唯一：${sanitizeSessionText(id, 80)}`, "warning");
            return;
          }
          const destination = await deleteSession(matches[0], getCurrentFile, (title, message) =>
            ctx.ui.confirm(title, message),
          );
          if (destination) ctx.ui.notify(`Session 已移入：${sanitizeSessionText(destination)}`, "info");
          return;
        }

        if (!ctx.hasUI || ctx.mode !== "tui") {
          const counts = databaseCounts(DATABASE_PATH);
          console.log(`Session 文件 ${sessions.length} 个；索引 ${counts.sessions} 个；消息 ${counts.messages} 条`);
          return;
        }

        const deletable = sessions.filter((session) => !sameFile(session.path, getCurrentFile()));
        if (deletable.length === 0) {
          ctx.ui.notify("没有可删除的历史 Session", "info");
          return;
        }

        const session = await selectBounded(
          ctx,
          `选择要删除的历史 Session\n共 ${deletable.length} 个；当前 Session 已排除。`,
          deletable.map((candidate) => ({
            value: candidate,
            label: `${shortDate(candidate.modified)}  ${sanitizeSessionText(candidate.name || candidate.firstMessage, 54) || "(空会话)"}`,
            description: `${candidate.messageCount} 条 · ${sanitizeSessionText(candidate.id, 80)}`,
            detail: sanitizeSessionText(candidate.path, 1024),
          })),
        );
        if (!session) return;

        const destination = await deleteSession(session, getCurrentFile, (title, message) =>
          ctx.ui.confirm(title, message),
        );
        if (destination) ctx.ui.notify(`Session 已移入可恢复目录：${sanitizeSessionText(destination)}`, "info");
      } catch (error) {
        const detail = sanitizeSessionText(error instanceof Error ? error.message : error, MAX_UI_ERROR);
        ctx.ui.notify(`Session 管理失败：${detail}`, "error");
      }
    },
  });
}
