/** New-session defaults are separate from machine-local explicit session choices. */
export type SessionPermissionMode = "read-only" | "sandbox-write" | "host-restricted" | "host-auto" | "host-write";
/** The `/permissions` order: least to most authority. */
export const PERMISSION_MODES: readonly SessionPermissionMode[] = Object.freeze(["read-only", "sandbox-write", "host-restricted", "host-auto", "host-write"]);
export const PERMISSION_MODE_LABELS: Readonly<Record<SessionPermissionMode, string>> = Object.freeze({
  "read-only": "只读（沙箱）",
  "sandbox-write": "沙箱读写",
  "host-restricted": "宿主机受限",
  // R6: host-restricted whose asks are first reviewed by the session model.
  "host-auto": "宿主机受限 · Auto 审查",
  // Stored `host-write` records keep their meaning: full host access.
  "host-write": "宿主机完全权限",
});
export function assertPermissionMode(value: unknown): asserts value is SessionPermissionMode {
  if (value !== "read-only" && value !== "sandbox-write" && value !== "host-restricted" && value !== "host-auto" && value !== "host-write") throw new Error("Invalid session permission mode");
}
/** Every host tier runs on the trusted-host backend; the sandbox tiers run in the VM. */
export function isHostPermissionMode(mode: SessionPermissionMode | undefined): mode is "host-restricted" | "host-auto" | "host-write" {
  return mode === "host-restricted" || mode === "host-auto" || mode === "host-write";
}
/** Host-restricted rules: Auto changes who answers an ask, never what asks. */
export function isRestrictedHostMode(mode: SessionPermissionMode | undefined): mode is "host-restricted" | "host-auto" {
  return mode === "host-restricted" || mode === "host-auto";
}
export function defaultPermissionMode(value: unknown): "read-only" | "sandbox-write" {
  // Old full-access/never-ask and stored host modes are history, not fresh consent.
  return value === "read-only" ? "read-only" : "sandbox-write";
}
