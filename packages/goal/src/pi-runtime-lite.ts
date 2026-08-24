import * as os from "node:os";
import * as path from "node:path";

const CONFIG_DIR_NAME = ".super-pi";
const AGENT_DIR_ENV = "SP_CODING_AGENT_DIR";

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** Pi 0.84-compatible path helper without loading a second coding-agent runtime. */
export function getAgentDir(): string {
  const configured = process.env[AGENT_DIR_ENV];
  return configured
    ? path.resolve(expandHome(configured))
    : path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}
