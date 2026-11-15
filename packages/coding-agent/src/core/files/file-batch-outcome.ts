import { fileInvocationMustStop } from "./file-mutation-failure.mjs";
export { FileAuthorityError, fileInvocationMustStop } from "./file-mutation-failure.mjs";

/** A completed batch may contain item failures without failing its containing script. */
export function completedFileBatchFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return d.mutationReceiptVersion === 3 && d.operation === "file_batch" && d.preview !== true
    && d.complete === true && !d.reason && !d.requiresVerification && d.stopInvocation !== true && d.unknown === 0 && d.partial === 0
    && d.cancelled === 0 && d.notStarted === 0 && Number.isSafeInteger(d.failed) && (d.failed as number) > 0
    && Number.isSafeInteger(d.succeeded) && (d.succeeded as number) >= 0
    && (d.succeeded as number) + (d.failed as number) === d.itemCount;
}

/** Protocol/authority failures are invocation failures, never ordinary file mismatches. */
export function assertFileBatchItemFailure(error: unknown): void {
  if (fileInvocationMustStop(error)) throw error;
}
