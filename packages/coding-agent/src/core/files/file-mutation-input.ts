import { nativeItemCount, nativeItemInput, validateNativeInvocation, type NativeFileInvocationInput } from "./file-operation-input.ts";

/** Request setup helpers shared by authorization, path conversion and execution.
 * They project at most one top-level target and never copy the whole call. */
export function isFileMutationOperation(operation: string): boolean {
  return operation === "edit" || operation === "write" || operation === "copy" || operation === "delete" || operation === "move" || operation === "file_batch";
}
export function validateFileMutationTargets(operation: string, input: unknown): void {
  if (operation === "file_batch") {
    const value = input as { operations?: unknown } | undefined;
    if (!Array.isArray(value?.operations) || !value.operations.length) throw new Error("[TOOL_ARGS_INVALID] Expected nonempty file_batch operations.");
    // Authorization resolves all target roles before the execution owner's full
    // schema/body validation. Malformed bodies never hide a path-rule denial.
    for (const item of value.operations) if (!item || typeof item !== "object" || Array.isArray(item)
      || !isFileMutationOperation(item.operation) || item.operation === "file_batch" || typeof item.path !== "string"
      || item.destination !== undefined && typeof item.destination !== "string") throw new Error("[TOOL_ARGS_INVALID] Invalid file batch target.");
  }
  else if (operation === "copy" || operation === "delete" || operation === "move") validateNativeInvocation(operation, input);
}
export function fileMutationItemCount(operation: string, input: Record<string, any>): number {
  return operation === "file_batch" ? input.operations.length
    : operation === "copy" || operation === "delete" || operation === "move" ? nativeItemCount(input as NativeFileInvocationInput) : 1;
}
export function fileMutationItem(operation: string, input: Record<string, any>, index: number): Record<string, any> {
  if (operation === "file_batch") return input.operations[index];
  if ((operation === "copy" || operation === "delete" || operation === "move") && (input.items !== undefined || input.paths !== undefined)) {
    return nativeItemInput(operation, input as NativeFileInvocationInput, index);
  }
  return input;
}
export function fileMutationItemOperation(operation: string, input: Record<string, any>, index: number): string {
  return operation === "file_batch" ? input.operations[index].operation : operation;
}
