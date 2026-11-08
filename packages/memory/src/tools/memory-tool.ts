/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@super-pi/coding-agent";
import { Type } from "../schema.js";
import { StringEnum } from "../typebox-compat.js";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";
import type { MemoryCategory, MemoryResult } from "../types.js";

const MAX_LIST_OUTPUT_BYTES = 50 * 1024;

type MemoryToolParams = {
  action: "add" | "replace" | "remove" | "list";
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
  scope?: "global" | "project";
  offset?: number;
  limit?: number;
};

async function changeGlobalFailure(store: MemoryStore, oldText: string, content?: string): Promise<MemoryResult> {
  const before = await store.readEntries("failure", null);
  const selector = oldText.trim();
  const matches = before.filter((entry) => selector && entry.includes(selector));
  if (matches.length !== 1) return { success: false, error: "Select exactly one global failure entry; other project records are not eligible." };
  const after = before.filter((entry) => entry !== matches[0]);
  if (content !== undefined) after.splice(before.indexOf(matches[0]!), 0, content);
  return store.replaceMemoryEntriesIfUnchanged(before, after, "failure", null);
}

function appendSyncWarning(result: MemoryResult, warning: string): MemoryResult {
  const warnings = [...(((result as any).warnings ?? []) as string[]), warning];
  const message = result.message ? `${result.message} Warning: ${warning}` : warning;
  return {
    ...result,
    message,
    warning,
    warnings,
  } as MemoryResult;
}

function formatMemoryToolText(result: MemoryResult): string {
  const evictedEntries = result.evicted_entries ?? [];
  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? "entry" : "entries"} to stay within the limit.`,
      "",
      "Rotated active memory entries:",
      "",
    ];

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
      lines.push("");
    });

    lines.push("If one of these entries should stay active, add it again.");
    if (result.usage) lines.push(`Usage: ${result.usage}`);
    return lines.join("\n").trim();
  }

  return JSON.stringify(result);
}

function sqliteProjectFor(rawTarget: "memory" | "user" | "project" | "failure", projectName?: string | null): string | null | undefined {
  if (rawTarget === "project") return projectName?.trim() || null;
  if (rawTarget === "memory") return null;
  if (rawTarget === "user") return null;
  if (rawTarget === "failure") return projectName?.trim() || null;
  return undefined;
}

function sqliteTargetFor(rawTarget: "memory" | "user" | "project" | "failure"): "memory" | "user" | "failure" {
  if (rawTarget === "project") return "memory";
  return rawTarget;
}

async function syncAddToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);

    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        target: "failure",
        project: sqliteProject ?? null,
        category: failureCategory,
        failureReason,
      });
      return null;
    }

    syncMemoryEntry(dbManager, {
      content,
      target: sqliteTarget,
      project: sqliteProject ?? null,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  newContent: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = replaceSyncedMemories(dbManager, oldText, {
      content: newContent,
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = removeSyncedMemories(dbManager, oldText, {
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncEvictionsFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  evictedEntries: string[] | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<void> {
  if (!dbManager) return;
  if (!evictedEntries || evictedEntries.length === 0) return;

  const sqliteTarget = sqliteTargetFor(rawTarget);
  const sqliteProject = sqliteProjectFor(rawTarget, projectName);

  for (const entry of evictedEntries) {
    try {
      removeExactSyncedMemories(dbManager, entry, {
        target: sqliteTarget,
        project: sqliteProject,
      });
    } catch {
      // FIFO already updated the Markdown source of truth. SQLite is only a
      // best-effort search mirror, so eviction cleanup must not fail the write.
    }
  }
}

async function reconcileProjectStoreScope(
  entries: string[],
  target: "memory" | "user" | "failure",
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null | undefined> {
  if (target !== "failure") return reconcileStoreScope(entries, "project", dbManager, projectName);
  if (!dbManager) return undefined;
  try {
    reconcileMarkdownMemoryScope(dbManager, entries, "failure", projectName?.trim() || null);
    return null;
  } catch (err) {
    return `Saved to project Markdown, but SQLite search reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function reconcileStoreScope(
  entries: string[],
  rawTarget: "memory" | "user" | "project" | "failure",
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null | undefined> {
  if (!dbManager) return undefined;
  try {
    if (rawTarget === "failure") {
      reconcileMarkdownFailureScopes(dbManager, entries, false);
      return null;
    }
    const target = sqliteTargetFor(rawTarget);
    reconcileMarkdownMemoryScope(
      dbManager,
      entries,
      target,
      sqliteProjectFor(rawTarget, projectName) ?? null,
    );
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  const reconciledStores = new WeakSet<MemoryStore>();
  if (typeof store.setMutationObserver === "function") {
    store.setMutationObserver((target, entries) => reconcileStoreScope(entries, target, dbManager, projectName));
    reconciledStores.add(store);
  }
  if (projectStore && typeof projectStore.setMutationObserver === "function") {
    projectStore.setMutationObserver((target, entries) => (
      reconcileProjectStoreScope(entries, target, dbManager, projectName)
    ));
    reconciledStores.add(projectStore);
  }

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove", "list"] as const),
      target: StringEnum(["memory", "user", "project", "failure"] as const),
      scope: Type.Optional(StringEnum(["global", "project"] as const, { description: 'For failure only. Defaults to project when available, otherwise global.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000, description: 'List page offset; follow nextOffset until null.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'List page size, default 20.' })),
      content: Type.Optional(
        Type.String({ description: "Entry content for add/replace" })
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Substring identifying entry for replace/remove",
        })
      ),
      category: Type.Optional(
        StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
          description: "Category for failure memories",
        })
      ),
      failure_reason: Type.Optional(
        Type.String({ description: "Why it failed (for failure category)" })
      ),
    }),
    async execute(_toolCallId, params: MemoryToolParams, signal, _onUpdate, _ctx) {
      const { action, target: rawTarget, content, old_text, category, failure_reason } = params;
      if (params.scope !== undefined && rawTarget !== "failure") {
        return { content: [{ type: "text", text: "scope applies only to target failure; use target user/memory for global or project for current-project notes." }], isError: true, details: {} };
      }

      // Route 'project' to projectStore using the normal MEMORY.md target.
      const target = rawTarget === "project" ? "memory" : rawTarget as "memory" | "user" | "failure";
      const projectFailure = rawTarget === "failure" && (params.scope === "project" || params.scope === undefined && projectStore !== null);
      const activeStore = rawTarget === "project" || projectFailure
        ? projectStore
        : store;

      if ((rawTarget === "project" || projectFailure) && !projectStore) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Project memory is not available (no project detected)." }) }],
          details: {},
        };
      }

      // After the guard above, activeStore is guaranteed non-null when rawTarget === 'project'
      const store_ = activeStore!;

      if (action === "list") {
        const listed = await store_.listEntries(target, params.offset ?? 0, params.limit ?? 20,
          rawTarget === "failure" && !projectFailure ? null : undefined);
        const details = { ...listed, target: rawTarget, scope: activeStore === projectStore ? "project" : "global",
          project: activeStore === projectStore ? projectName : null };
        const text = JSON.stringify(details);
        if (Buffer.byteLength(text, "utf8") > MAX_LIST_OUTPUT_BYTES) {
          return { content: [{ type: "text", text: `List page exceeds 50 KiB. Reduce limit; for a single oversized entry, read ${listed.source} directly. No entries have been truncated.` }], isError: true, details: { source: listed.source, total: listed.total, offset: listed.offset } };
        }
        return { content: [{ type: "text", text }], details };
      }

      let result: MemoryResult;
      let syncWarning: string | null = null;
      const syncHandled = reconciledStores.has(store_);
      switch (action) {
        case "add":
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "Content is required for 'add' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          // Handle failure target with category
          if (rawTarget === "failure") {
            const memoryCategory = (category || "failure") as MemoryCategory;
            result = await store_.addFailure(content, {
              category: memoryCategory,
              failureReason: failure_reason,
              project: projectFailure ? projectName?.trim() || undefined : undefined,
            });
            if (result.success && !syncHandled) {
              syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager, projectName);
            }
          } else {
            result = await store_.add(target, content, signal);
            if (result.success && !syncHandled) {
              await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager, projectName);
              syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, projectName);
            }
          }
          break;

        case "replace":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "content is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = rawTarget === "failure" && !projectFailure
            ? await changeGlobalFailure(store_, old_text, content) : await store_.replace(target, old_text, content);
          if (result.success && !syncHandled) syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager, projectName);
          break;

        case "remove":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'remove' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = rawTarget === "failure" && !projectFailure
            ? await changeGlobalFailure(store_, old_text) : await store_.remove(target, old_text);
          if (result.success && !syncHandled) syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager, projectName);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove`,
          };
      }

      if (result.success && !syncHandled && typeof store_.getRawEntriesForSync === "function") {
        const reconciliationWarning = await reconcileStoreScope(store_.getRawEntriesForSync(target), rawTarget, dbManager, projectName);
        if (reconciliationWarning !== undefined) syncWarning = reconciliationWarning;
      }

      if (syncWarning && result.success) {
        result = appendSyncWarning(result, syncWarning);
      }

      // Tag project results so the caller knows the scope
      if (rawTarget === "project" && result.success) {
        result = {
          ...result,
          target: "project",
        };
      }

      return {
        content: [{ type: "text", text: formatMemoryToolText(result) }],
        details: result,
      };
    },
  });
}
