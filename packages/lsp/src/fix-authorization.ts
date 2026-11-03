import { realpathSync } from "node:fs";
import { consumePermissionPathApproval, type PermissionPathApproval } from "@super-pi/coding-agent/internal/files/file-invocation";

export type FixAuthorization = PermissionPathApproval & { assertCurrent(): void; revocationSignal: AbortSignal };

export function consumeFixAuthorization(input: unknown, toolCallId: string): FixAuthorization {
 const approval = consumePermissionPathApproval(input, toolCallId, "lsp_fix");
 if (!approval || typeof approval.assertCurrent !== "function" || !(approval.revocationSignal instanceof AbortSignal)) {
  throw new Error("[POLICY_BLOCKED] LSP write authorization is missing; request current authorization before applying fixes.");
 }
 approval.revocationSignal.throwIfAborted();
 return approval as FixAuthorization;
}

/** Call only at admission and immediately before the synchronous write, never on LSP progress. */
export function assertFixAuthorization(approval: FixAuthorization | undefined, file: string): void {
 if (!approval || typeof approval.assertCurrent !== "function" || !(approval.revocationSignal instanceof AbortSignal)) {
  throw new Error("[POLICY_BLOCKED] LSP write authorization is missing.");
 }
 approval.revocationSignal.throwIfAborted();
 approval.assertCurrent();
 if (realpathSync.native(file) !== approval.canonicalTarget) throw new Error("[POLICY_BLOCKED] LSP write authorization does not match the current target.");
}
