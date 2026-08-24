import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  consumeStructuredReadonlyWorkspaceDelegation,
  structuredReadonlyRequestHash,
  type StructuredReadonlyPathGrant,
} from "../resource-lifecycle-guard/permission-contract.ts";

export interface StructuredReadonlyWorkspacePolicy {
  canonicalRoot: string;
  canonicalCwd: string;
  authorizedRoots: readonly string[];
  source: "primary" | "additional" | "full-access-exact";
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function validSource(source: unknown): source is StructuredReadonlyPathGrant["source"] {
  return source === "primary" || source === "additional" || source === "full-access-exact";
}

function validateRootGrant(grant: StructuredReadonlyPathGrant): string {
  if (!validSource(grant.source)
    || !Number.isFinite(grant.rootDevice)
    || !Number.isFinite(grant.rootInode)) {
    throw new Error("Structured read-only path grant is invalid.");
  }
  const canonicalRoot = realpathSync(grant.canonicalRoot);
  const identity = statSync(canonicalRoot);
  if (!identity.isDirectory() || identity.dev !== grant.rootDevice || identity.ino !== grant.rootInode) {
    throw new Error("Structured read-only authorized path identity changed after authorization.");
  }
  return canonicalRoot;
}

export function consumeStructuredReadonlyWorkspacePolicy(
  input: unknown,
  toolCallId: string,
): StructuredReadonlyWorkspacePolicy {
  const delegation = consumeStructuredReadonlyWorkspaceDelegation(input);
  if (!delegation
    || delegation.schemaVersion !== 1
    || !Number.isSafeInteger(delegation.sequence)
    || delegation.sequence < 0
    || delegation.toolCallId !== toolCallId
    || delegation.requestHash !== structuredReadonlyRequestHash(input)
    || !Array.isArray(delegation.additionalRoots)
    || delegation.additionalRoots.length > 16) {
    throw new Error("Structured read-only workspace delegation is missing, invalid, or belongs to another tool call; reload the permission controller and retry.");
  }
  if (!validSource(delegation.source)) {
    throw new Error("Structured read-only workspace delegation source is invalid.");
  }
  const canonicalRoot = validateRootGrant(delegation);
  const canonicalCwd = realpathSync(delegation.canonicalCwd);
  if (!isInside(canonicalRoot, canonicalCwd)) {
    throw new Error("Structured read-only delegated cwd escapes its authorized root.");
  }
  const cwdIdentity = statSync(canonicalCwd);
  if (!cwdIdentity.isDirectory()
    || !Number.isFinite(delegation.cwdDevice)
    || !Number.isFinite(delegation.cwdInode)
    || cwdIdentity.dev !== delegation.cwdDevice
    || cwdIdentity.ino !== delegation.cwdInode) {
    throw new Error("Structured read-only workspace identity changed after authorization.");
  }
  const requestedCwd = input && typeof input === "object" && typeof (input as { cwd?: unknown }).cwd === "string"
    ? resolve(canonicalRoot, (input as { cwd: string }).cwd)
    : canonicalRoot;
  const requestedCanonical = realpathSync(requestedCwd);
  const requestedIdentity = statSync(requestedCanonical);
  if (!requestedIdentity.isDirectory()
    || requestedIdentity.dev !== cwdIdentity.dev
    || requestedIdentity.ino !== cwdIdentity.ino) {
    throw new Error("Structured read-only delegation does not match the requested canonical cwd identity.");
  }
  const authorizedRoots = [canonicalRoot];
  for (const grant of delegation.additionalRoots) {
    const additionalRoot = validateRootGrant(grant);
    if (!authorizedRoots.includes(additionalRoot)) authorizedRoots.push(additionalRoot);
  }
  return { canonicalRoot, canonicalCwd, authorizedRoots, source: delegation.source };
}
