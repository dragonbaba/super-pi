import process from "node:process";
import {
  createBashToolDefinition,
  getAgentDir,
  SettingsManager,
  type BashSpawnContext,
} from "@super-pi/coding-agent";
import { BACKSLASH_PAIR_RE } from "./regex.js";

export const MAX_MSYS_STDIN_COMMAND_BYTES = 12 * 1024;
export const MAX_WINDOWS_ENVIRONMENT_CHARS = 32_767;
export const MSYS_STDIN_COMMAND_ENV = "SP_MSYS_STDIN_COMMAND_B64";
const MSYS_STDIN_WRAPPER = `set -o pipefail; printenv ${MSYS_STDIN_COMMAND_ENV} | base64 -d | env -u ${MSYS_STDIN_COMMAND_ENV} bash -s`;

export function withMsysStdinBridge(
  context: BashSpawnContext,
  platform = process.platform,
): BashSpawnContext {
  if (platform !== "win32" || !BACKSLASH_PAIR_RE.test(context.command)) return context;
  const commandBytes = Buffer.byteLength(context.command, "utf8");
  if (commandBytes > MAX_MSYS_STDIN_COMMAND_BYTES) {
    throw new Error(`MSYS_STDIN_COMMAND_TOO_LARGE: paired-backslash Bash command is ${commandBytes} UTF-8 bytes; maximum bridge size is ${MAX_MSYS_STDIN_COMMAND_BYTES}. Use a bounded script file or structured argv instead.`);
  }
  const env: NodeJS.ProcessEnv = {};
  const sourceEnv = context.env;
  const contextEnvKeys = sourceEnv ? Object.keys(sourceEnv) : undefined;
  for (let index = 0; index < (contextEnvKeys?.length ?? 0); index++) {
    const key = contextEnvKeys![index]!;
    if (key.toUpperCase() !== MSYS_STDIN_COMMAND_ENV) env[key] = sourceEnv![key];
  }
  env[MSYS_STDIN_COMMAND_ENV] = Buffer.from(context.command, "utf8").toString("base64");
  let environmentCharacters = 1;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) environmentCharacters += key.length + value.length + 2;
  }
  if (environmentCharacters > MAX_WINDOWS_ENVIRONMENT_CHARS) {
    throw new Error(`MSYS_STDIN_ENV_TOO_LARGE: bridged Windows environment requires ${environmentCharacters} UTF-16 characters; CreateProcess allows at most ${MAX_WINDOWS_ENVIRONMENT_CHARS}. Use structured argv or a bounded script file.`);
  }
  return {
    command: MSYS_STDIN_WRAPPER,
    cwd: context.cwd,
    env,
  };
}

export function createMsysProtectedBashDefinition(
  cwd: string,
  settings: { shellPath?: string; commandPrefix?: string },
) {
  return createBashToolDefinition(cwd, {
    shellPath: settings.shellPath,
    commandPrefix: settings.commandPrefix,
    spawnHook: withMsysStdinBridge,
  });
}

export function createConfiguredMsysBashDefinition(cwd: string, projectTrusted: boolean) {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  return createMsysProtectedBashDefinition(cwd, {
    shellPath: settings.getShellPath(),
    commandPrefix: settings.getShellCommandPrefix(),
  });
}
