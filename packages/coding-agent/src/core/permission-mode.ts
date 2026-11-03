/** Session authority. Persisted preferences may never restore host execution. */
export type SessionPermissionMode = "read-only" | "sandbox-write" | "host-write";
export const PERMISSION_MODE_LABELS: Readonly<Record<SessionPermissionMode, string>> = Object.freeze({
  "read-only": "只读（沙箱）",
  "sandbox-write": "沙箱读写",
  "host-write": "全部读写（宿主机）",
});
export function assertPermissionMode(value: unknown): asserts value is SessionPermissionMode {
  if (value !== "read-only" && value !== "sandbox-write" && value !== "host-write") throw new Error("Invalid session permission mode");
}
export function defaultPermissionMode(value: unknown): "read-only" | "sandbox-write" {
  // Old full-access/never-ask and stored host-write are history, not fresh consent.
  return value === "read-only" ? "read-only" : "sandbox-write";
}
