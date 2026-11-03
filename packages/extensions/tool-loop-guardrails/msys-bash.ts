import {
  createBashToolDefinition,
  getAgentDir,
  SettingsManager,
} from "@super-pi/coding-agent";
export { withMsysStdinBridge, MAX_MSYS_STDIN_COMMAND_BYTES, MAX_WINDOWS_ENVIRONMENT_CHARS, MSYS_STDIN_COMMAND_ENV } from "@super-pi/coding-agent";

export function createMsysProtectedBashDefinition(
  cwd: string,
  settings: { shellPath?: string; commandPrefix?: string },
) {
  return createBashToolDefinition(cwd, {
    shellPath: settings.shellPath,
    commandPrefix: settings.commandPrefix,
  });
}

export function createConfiguredMsysBashDefinition(cwd: string, projectTrusted: boolean) {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  return createMsysProtectedBashDefinition(cwd, {
    shellPath: settings.getShellPath(),
    commandPrefix: settings.getShellCommandPrefix(),
  });
}
