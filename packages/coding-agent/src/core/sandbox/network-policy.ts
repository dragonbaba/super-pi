export type SandboxNetwork = "disabled" | "enabled";

/** A missing policy is offline; malformed configuration must never enable networking. */
export function parseSandboxNetwork(value: unknown): SandboxNetwork {
    if (value === undefined) return "disabled";
    if (value !== "disabled" && value !== "enabled") throw new Error("Invalid global sandboxNetwork; expected disabled or enabled");
    return value;
}
