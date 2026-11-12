import { createHash } from "node:crypto";
import { SHA256_PATTERN } from "./regex.ts";

// A JavaScript/JSON array has at most 2^32-1 slots. This is proof depth, not a tool target-count admission rule.
const MAX_PROOF_DEPTH = 32;
function parentHash(left: string, right: string): string {
  return createHash("sha256").update("file-manifest-v3-node:").update(left).update(right).digest("hex");
}
function emptyHashes(): readonly string[] {
  const result = [createHash("sha256").update("file-manifest-v3-empty").digest("hex")];
  for (let depth = 1; depth <= MAX_PROOF_DEPTH; depth++) result.push(parentHash(result[depth - 1], result[depth - 1]));
  return Object.freeze(result);
}
const EMPTY = emptyHashes();
export function manifestLeafHash(entryId: string, rowHash: string): string {
  return createHash("sha256").update("file-manifest-v3-leaf:").update(entryId).update(":").update(rowHash).digest("hex");
}

/** Invocation setup retains hashes only; all levels together contain less than 2N + depth entries. */
export function buildManifestLevels(leaves: string[]): string[][] {
  if (!leaves.length) throw new Error("[FILE_RESULT_INVALID] Empty prepared manifest.");
  const levels = [leaves];
  let current = leaves, depth = 0;
  while (current.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) next.push(parentHash(current[index], current[index + 1] ?? EMPTY[depth]));
    levels.push(next); current = next; depth++;
  }
  return levels;
}
/** The bounded proof is part of the durable intent DTO, never a cached result/page. */
export function manifestProof(levels: readonly (readonly string[])[], index: number): string[] {
  const result: string[] = [];
  for (let depth = 0; depth + 1 < levels.length; depth++) {
    const sibling = index % 2 === 0 ? index + 1 : index - 1;
    result.push(levels[depth][sibling] ?? EMPTY[depth]); index = Math.floor(index / 2);
  }
  return result;
}
export function verifyManifestProof(leaf: string, index: number, count: number, proof: unknown, root: unknown): boolean {
  if (!Array.isArray(proof) || proof.length > MAX_PROOF_DEPTH || typeof root !== "string" || !SHA256_PATTERN.test(root)
    || !Number.isInteger(index) || index < 0 || index >= count || typeof leaf !== "string" || !SHA256_PATTERN.test(leaf)) return false;
  let depth = 0;
  while (count > 1) {
    const sibling = proof[depth];
    if (typeof sibling !== "string" || !SHA256_PATTERN.test(sibling)) return false;
    leaf = index % 2 === 0 ? parentHash(leaf, sibling) : parentHash(sibling, leaf);
    index = Math.floor(index / 2); count = Math.ceil(count / 2); depth++;
  }
  return proof.length === depth && leaf === root;
}

/** Reverse page traversal keeps only one pending subtree hash per level (at most 32). */
export function appendReverseManifest(frontier: Array<string | null>, leaf: string, index: number, count: number): string | undefined {
  let depth = 0;
  while (count > 1) {
    if (index % 2 === 1) { frontier[depth] = leaf; return; }
    const sibling = index + 1 < count ? frontier[depth] : EMPTY[depth];
    if (!sibling) throw new Error("[FILE_RESULT_INVALID] Prepared manifest proof has a missing subtree.");
    leaf = parentHash(leaf, sibling); frontier[depth] = null;
    index = Math.floor(index / 2); count = Math.ceil(count / 2); depth++;
  }
  return leaf;
}
export function validManifestFrontier(value: unknown): value is Array<string | null> {
  if (!Array.isArray(value) || value.length > MAX_PROOF_DEPTH) return false;
  for (const hash of value) if (hash !== null && (typeof hash !== "string" || !SHA256_PATTERN.test(hash))) return false;
  return true;
}
