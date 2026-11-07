export type SandboxNetwork = "disabled" | "enabled";

/** A missing policy is offline; malformed configuration must never enable networking. */
export function parseSandboxNetwork(value: unknown): SandboxNetwork {
    if (value === undefined) return "disabled";
    if (value !== "disabled" && value !== "enabled") throw new Error("Invalid global sandboxNetwork; expected disabled or enabled");
    return value;
}

/**
 * Session-level network consent (R5). The session owns it, so a reload rebuild keeps it;
 * it is never persisted, and the global `sandboxNetwork` stays the default for new sessions.
 */
export class SandboxNetworkSession { enabled = false; }
