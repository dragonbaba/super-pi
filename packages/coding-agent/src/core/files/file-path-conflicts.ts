import { sep } from "node:path";
import type { PathIdentity } from "./native-file-core.ts";
import { WINDOWS_PATH_SEPARATOR_PATTERN } from "./regex.ts";

interface ConflictItem {
  itemId: string; target: string; paths: readonly string[]; identity?: PathIdentity;
  native?: { destination?: string; destinationIdentity?: PathIdentity; tree?: { entries: readonly { identity: PathIdentity }[] } };
  tree?: { destination?: string; destinationIdentity?: PathIdentity; tree?: { entries: readonly { identity: PathIdentity }[] } };
  creation?: { directories: readonly string[] };
}
class PathNode {
  readonly children = new Map<string, PathNode>();
  terminalExisting: string | undefined;
  terminalProspective: string | undefined;
  descendantExisting: string | undefined;
  descendantProspective: string | undefined;
}
export interface PathConflictCounters { paths: number; nodes: number; visits: number; identities: number; missingParents: number; }

function conflict(left: string, right: string): never {
  throw new Error(`[BATCH_CONFLICT] ${left} and ${right} overlap; split dependent changes into verified stages.`);
}
function addIdentity(identities: Map<string, Map<string, string>>, identity: PathIdentity, id: string, repeatedWithinItem: boolean): number {
  let device = identities.get(identity.device);
  if (!device) { device = new Map(); identities.set(identity.device, device); }
  const owner = device.get(identity.inode);
  if (owner !== undefined) {
    if (!repeatedWithinItem || owner !== id) throw new Error(`[BATCH_CONFLICT] ${id} and ${owner} share a file identity.`);
    return 0;
  }
  device.set(identity.inode, id); return 1;
}
function insert(root: PathNode, parts: readonly string[], id: string, prospective: boolean, folded: boolean, counters: PathConflictCounters): void {
  let node = root;
  for (let index = 0; index < parts.length; index++) {
    counters.visits++;
    const prefix = prospective ? node.terminalExisting ?? node.terminalProspective : node.terminalProspective;
    if (prefix !== undefined) conflict(id, prefix);
    const part = folded ? parts[index].normalize("NFC").toLowerCase() : parts[index];
    let child = node.children.get(part);
    if (!child) { child = new PathNode(); node.children.set(part, child); counters.nodes++; }
    node = child;
  }
  const childOwner = prospective ? node.descendantExisting ?? node.descendantProspective : node.descendantProspective;
  if (childOwner !== undefined) conflict(id, childOwner);
  if (prospective) node.terminalProspective = id;
  else node.terminalExisting ??= id;
  // Second bounded path walk updates subtree owners without a path-sized node array.
  node = root;
  if (prospective) node.descendantProspective ??= id;
  else node.descendantExisting ??= id;
  for (let index = 0; index < parts.length; index++) {
    counters.visits++;
    node = node.children.get(folded ? parts[index].normalize("NFC").toLowerCase() : parts[index])!;
    if (prospective) node.descendantProspective ??= id;
    else node.descendantExisting ??= id;
  }
}

/** Invocation-owned tries; no pairwise item scans, retained cache or filesystem reads. */
export function assertIndependent(items: readonly ConflictItem[]): PathConflictCounters {
  const exact = new PathNode(), folded = new PathNode(), identities = new Map<string, Map<string, string>>();
  const missingParents = new Map<string, string>();
  const counters: PathConflictCounters = { paths: 0, nodes: 2, visits: 0, identities: 0, missingParents: 0 };
  for (const item of items) {
    const native = item.tree ?? item.native;
    for (let slot = 0; slot < 2; slot++) {
      const identity = slot === 0 ? item.identity : native?.destinationIdentity;
      if (!identity) continue;
      counters.identities += addIdentity(identities, identity, item.itemId, false);
    }
    if (native?.tree) for (let index = 1; index < native.tree.entries.length; index++) counters.identities += addIdentity(identities, native.tree.entries[index].identity, item.itemId, true);
    if (item.creation) for (const path of item.creation.directories) {
      const key = path.normalize("NFC").toLowerCase(), spelling = missingParents.get(key);
      if (spelling !== undefined && spelling !== path && process.platform !== "win32") throw new Error("[BATCH_CONFLICT] Ambiguous spellings for a missing shared parent; use identical spelling.");
      if (spelling === undefined) { missingParents.set(key, path); counters.missingParents++; }
    }
    for (const path of item.paths) {
      const existing = item.identity && path === item.target || native?.destinationIdentity && path === native.destination;
      // Individual paths already have the public 4096-character bound; this is not a large-result line split.
      const parts = path.split(sep === "\\" ? WINDOWS_PATH_SEPARATOR_PATTERN : "/");
      counters.paths++;
      if (existing) insert(exact, parts, item.itemId, true, process.platform === "win32", counters);
      insert(folded, parts, item.itemId, !existing, true, counters);
    }
  }
  return counters;
}
