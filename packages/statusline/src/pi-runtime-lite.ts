import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_DIR_NAME = ".sp";
const AGENT_DIR_ENV = "SP_CODING_AGENT_DIR";

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return path.join(os.homedir(), input.slice(2));
	}
	return input;
}

/**
 * Lightweight equivalent of Pi 0.84's getAgentDir() for this Pi-specific
 * compatibility package. Avoid importing a second local coding-agent runtime
 * merely to resolve one startup path.
 */
export function getAgentDir(): string {
	const configured = process.env[AGENT_DIR_ENV];
	return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

export function getConfigDir(agentDir = getAgentDir()): string {
	return path.join(agentDir, "config");
}
