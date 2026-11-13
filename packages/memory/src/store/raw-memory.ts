import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ENTRY_DELIMITER } from "../constants.js";

const DELIMITER = Buffer.from(ENTRY_DELIMITER);
const METADATA = /^<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY = /^\[([^\]\r\n]+)\]/;
const DAY_MS = 86_400_000;

export interface RawMemoryEntry {
  ordinal: number; sha256: string; chars: number; summary: string;
  created: string | null; modified: string | null; category: string; project: string | null;
}
export interface RawMemorySnapshot {
  path: string; fingerprint: string; parentDevice: string; parentInode: string; entries: RawMemoryEntry[];
}
export interface RawMemorySelection { ordinal: number; sha256: string; }
export type RawMemoryFilter = { kind: "all" } | { kind: "age"; days: number } | { kind: "temporary"; days: number };

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function date(value: string | undefined): string | null {
  if (!value || !DATE.test(value)) return null;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function entry(bytes: Buffer, ordinal: number): RawMemoryEntry {
  const raw = bytes.toString("utf8"), marker = raw.lastIndexOf("<!--");
  const metadata = marker < 0 ? null : METADATA.exec(raw.slice(marker));
  const text = (metadata ? raw.slice(0, marker) : raw).trim();
  const newline = text.indexOf("\n");
  const summary = text.slice(0, Math.min(180, newline < 0 ? text.length : newline));
  const category = CATEGORY.exec(text.slice(0, 80))?.[1] ?? "未分类";
  const scopedProject = metadata?.[3] ? Buffer.from(metadata[3], "base64url").toString("utf8").trim().length > 0 : false;
  return { ordinal, sha256: hash(bytes), chars: raw.length,
    // A small row must not retain the original file's sliced-string backing.
    summary: Buffer.from(summary).toString("utf8"), created: date(metadata?.[1]?.trim()), modified: date(metadata?.[2]?.trim()),
    category: Buffer.from(category).toString("utf8"), project: scopedProject ? "项目标签" : null };
}

/** Explicit management only. Never creates a missing directory or follows a leaf/parent link. */
export async function readRawMemoryFile(filePath: string): Promise<{ snapshot: RawMemorySnapshot; bytes: Buffer } | null> {
  let parent, named;
  try { parent = await fs.lstat(path.dirname(filePath), { bigint: true }); named = await fs.lstat(filePath, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!parent.isDirectory() || parent.isSymbolicLink() || !named.isFile() || named.isSymbolicLink()) throw new Error("链接目录或文件不参与批量清理");
  const canonicalParent = await fs.realpath(path.dirname(filePath));
  const canonical = path.join(canonicalParent, path.basename(filePath));
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino) throw new Error("记忆文件身份已变化");
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(filePath, { bigint: true });
    if (after.dev !== current.dev || after.ino !== current.ino || current.isSymbolicLink()
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.size !== current.size || after.mtimeNs !== current.mtimeNs || after.ctimeNs !== current.ctimeNs
      || await fs.realpath(filePath) !== canonical) throw new Error("读取期间记忆文件已变化");
  } finally { await handle.close(); }
  const entries: RawMemoryEntry[] = [];
  if (bytes.length) {
    let start = 0, end: number;
    while ((end = bytes.indexOf(DELIMITER, start)) >= 0) {
      entries.push(entry(bytes.subarray(start, end), entries.length)); start = end + DELIMITER.length;
    }
    entries.push(entry(bytes.subarray(start), entries.length));
  }
  const snapshot = { path: canonical, fingerprint: hash(bytes), parentDevice: String(parent.dev), parentInode: String(parent.ino), entries };
  await assertRawMemoryParent(snapshot);
  return { snapshot, bytes };
}

export async function assertRawMemoryParent(snapshot: RawMemorySnapshot): Promise<void> {
  const parent = await fs.lstat(path.dirname(snapshot.path), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || String(parent.dev) !== snapshot.parentDevice || String(parent.ino) !== snapshot.parentInode
    || await fs.realpath(path.dirname(snapshot.path)) !== path.dirname(snapshot.path)) throw new Error("记忆目录身份已变化，跳过整个文件");
}

/** Remove disjoint contiguous selected groups. Unselected byte spans are copied verbatim. */
export function removeRawMemorySelections(bytes: Buffer, snapshot: RawMemorySnapshot, selections: readonly RawMemorySelection[]): Buffer {
  if (hash(bytes) !== snapshot.fingerprint) throw new Error("记忆文件已变化，跳过整个文件；请重新打开清理列表");
  const selected = new Set<number>();
  for (const selection of selections) {
    const row = snapshot.entries[selection.ordinal];
    if (!row || row.sha256 !== selection.sha256 || !Number.isSafeInteger(selection.ordinal)) throw new Error("记忆选择身份不匹配");
    selected.add(selection.ordinal);
  }
  const kept: Buffer[] = [];
  let start = 0, ordinal = 0, cursor = 0, groupStart = -1, groupOffset = 0;
  while (start <= bytes.length && ordinal < snapshot.entries.length) {
    const separator = bytes.indexOf(DELIMITER, start), end = separator < 0 ? bytes.length : separator;
    if (selected.has(ordinal)) {
      if (hash(bytes.subarray(start, end)) !== snapshot.entries[ordinal]!.sha256) throw new Error("记忆片段身份不匹配");
      if (groupStart < 0) { groupStart = ordinal; groupOffset = ordinal === 0 ? 0 : start - DELIMITER.length; }
      if (separator < 0 || !selected.has(ordinal + 1)) {
        if (groupOffset > cursor) kept.push(bytes.subarray(cursor, groupOffset));
        cursor = end + (groupStart === 0 && separator >= 0 ? DELIMITER.length : 0);
        groupStart = -1;
      }
    }
    ordinal++;
    if (separator < 0) break;
    start = end + DELIMITER.length;
  }
  if (cursor < bytes.length) kept.push(bytes.subarray(cursor));
  return Buffer.concat(kept);
}

export function preselectRawMemoryEntry(row: RawMemoryEntry, filter: RawMemoryFilter, now = Date.now()): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "temporary") {
    if (!row.created || row.category === "correction") return false;
    // Match the existing injection window, which is based on creation date.
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - filter.days);
    return row.created < cutoff.toISOString().slice(0, 10);
  }
  if (!row.modified) return false;
  return new Date(row.modified + "T00:00:00Z").getTime() < Math.floor(now / DAY_MS) * DAY_MS - filter.days * DAY_MS;
}
