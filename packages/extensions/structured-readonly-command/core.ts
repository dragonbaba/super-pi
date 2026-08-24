import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BLOCKED_RG_EXECUTION_SHORT_OPTION_PATTERN,
  BLOCKED_RG_FOLLOW_SHORT_OPTION_PATTERN,
  LEADING_AT_PATTERN,
  PARENT_SEGMENT_PATTERN,
  WINDOWS_ABSOLUTE_PATTERN,
  GIT_NOT_REPOSITORY_PATTERN,
  RG_DASH_PREFIXED_PATTERN_PATTERN,
  RG_POSITIONAL_GLOB_PATTERN,
  RG_UNRECOGNIZED_FLAG_PATTERN,
} from "./regex.ts";
import { classifyStructuredReadonlyArguments } from "../resource-lifecycle-guard/structured-argv.ts";
const SHELL_CONTROL_TOKENS = new Set(["|", "||", "&&", ";", ">", ">>", "<", "<<", "2>", "2>>", "&"]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse"]);
const BLOCKED_GIT_OPTION_PREFIXES = [
  "--exec-path",
  "--ext-diff",
  "--git-dir",
  "--namespace",
  "--no-index",
  "--output",
  "--textconv",
  "--upload-pack",
  "--work-tree",
  "--config-env",
];
const BLOCKED_RG_FOLLOW_OPTION_PREFIXES = ["--follow"];
const BLOCKED_RG_EXECUTION_OPTION_PREFIXES = ["--pre", "--pre-glob", "--hostname-bin", "--search-zip"];
export type StructuredCommandName = "git" | "rg";
const EXECUTABLE_NAMES: Record<StructuredCommandName, readonly string[]> = {
  git: ["git"],
  rg: ["rg"],
};
const WINDOWS_EXECUTABLE_NAMES: Record<StructuredCommandName, readonly string[]> = {
  git: ["git.exe", "git.com"],
  rg: ["rg.exe", "rg.com"],
};
export type StructuredCommandCategory =
  | "success"
  | "no_matches"
  | "workdir_mismatch"
  | "input_validation"
  | "command_failed"
  | "timeout_or_aborted";

export interface StructuredCommandInput {
  cwd?: string;
  command: StructuredCommandName;
  args: string[];
  timeoutMs?: number;
  maxOutputLines?: number;
}

export interface PreparedStructuredCommand {
  workspaceRoot: string;
  authorizedRoots: readonly string[];
  cwd: string;
  command: StructuredCommandName;
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface AuthorizedRootIdentity {
  path: string;
  device: number;
  inode: number;
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function canonicalExistingPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export async function resolveAllowedExecutable(
  command: StructuredCommandName,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  additionalRoots: readonly string[] = [],
): Promise<string> {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const names = process.platform === "win32" && extname(command).length === 0
    ? WINDOWS_EXECUTABLE_NAMES[command]
    : EXECUTABLE_NAMES[command];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const trimmedDirectory = rawDirectory.trim();
    const directory = trimmedDirectory.startsWith("\"") && trimmedDirectory.endsWith("\"")
      ? trimmedDirectory.slice(1, -1)
      : trimmedDirectory;
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      let executable: string | undefined;
      try {
        executable = await canonicalExistingPath(resolve(directory, name));
        if (!executable || isInside(workspaceRoot, executable)) continue;
        let insideAdditionalRoot = false;
        for (const root of additionalRoots) {
          if (isInside(root, executable)) {
            insideAdditionalRoot = true;
            break;
          }
        }
        if (insideAdditionalRoot) continue;
        const executableStats = await stat(executable);
        if (!executableStats.isFile()) continue;
        if (process.platform !== "win32") await access(executable, constants.X_OK);
        return executable;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
    }
  }
  throw new Error(`ENVIRONMENT_ERROR: ${command} was not found on a trusted absolute PATH entry outside the workspace.`);
}

async function isInsideAuthorizedRoot(authorizedRoots: readonly AuthorizedRootIdentity[], candidate: string): Promise<boolean> {
  for (const root of authorizedRoots) if (isInside(root.path, candidate)) return true;
  const candidateIdentity = await stat(candidate);
  for (const root of authorizedRoots) {
    if (candidateIdentity.dev === root.device && candidateIdentity.ino === root.inode) return true;
  }
  return false;
}

async function assertPathInsideWorkspace(authorizedRoots: readonly AuthorizedRootIdentity[], cwd: string, value: string): Promise<void> {
  const candidate = resolve(cwd, value.replace(LEADING_AT_PATTERN, ""));
  const canonical = await canonicalExistingPath(candidate);
  if (canonical) {
    if (await isInsideAuthorizedRoot(authorizedRoots, canonical)) return;
    throw new Error(`POLICY_BLOCKED: path resolves outside the authorized Session roots: ${value}`);
  }
  for (const root of authorizedRoots) if (isInside(root.path, candidate)) return;
  throw new Error(`POLICY_BLOCKED: path escapes the authorized Session roots: ${value}`);
}

async function validateArgumentPaths(
  authorizedRoots: readonly AuthorizedRootIdentity[],
  cwd: string,
  command: StructuredCommandName,
  args: readonly string[],
): Promise<void> {
  for (const argument of args) {
    if (argument.includes("\0")) throw new Error("POLICY_BLOCKED: command arguments cannot contain NUL bytes.");
    if (SHELL_CONTROL_TOKENS.has(argument)) {
      throw new Error(`POLICY_BLOCKED: shell control token is not accepted by structured_readonly_command: ${argument}`);
    }
  }

  const pathArguments = classifyStructuredReadonlyArguments(command, args).pathArguments;
  for (const pathArgument of pathArguments) {
    if (pathArgument === "-" || pathArgument.startsWith("-")) continue;
    if (command === "git"
      && !isAbsolute(pathArgument)
      && !WINDOWS_ABSOLUTE_PATTERN.test(pathArgument)
      && !PARENT_SEGMENT_PATTERN.test(pathArgument)) {
      const existing = await canonicalExistingPath(resolve(cwd, pathArgument.replace(LEADING_AT_PATTERN, "")));
      if (existing && !(await isInsideAuthorizedRoot(authorizedRoots, existing))) {
        throw new Error(`POLICY_BLOCKED: argument resolves outside the authorized Session roots: ${pathArgument}`);
      }
      continue;
    }
    await assertPathInsideWorkspace(authorizedRoots, cwd, pathArgument);
  }
}

function startsWithBlockedPrefix(value: string, prefixes: readonly string[]): boolean {
  const mayBeAbbreviation = value.startsWith("--") && value.length > 2;
  for (const prefix of prefixes) {
    if (value === prefix) return true;
    if (value.length > prefix.length && value.startsWith(prefix) && value.charCodeAt(prefix.length) === 61) return true;
    if (mayBeAbbreviation && prefix.startsWith(value)) return true;
  }
  return false;
}

async function assertGitMetadataInsideRoots(
  authorizedRoots: readonly AuthorizedRootIdentity[],
  candidate: string,
  label: string,
): Promise<string> {
  const canonical = await canonicalExistingPath(candidate);
  if (!canonical) throw new Error(`WORKDIR_MISMATCH: ${label} does not exist or cannot be resolved.`);
  if (!(await isInsideAuthorizedRoot(authorizedRoots, canonical))) {
    throw new Error(`POLICY_BLOCKED: ${label} resolves outside the authorized Session roots.`);
  }
  return canonical;
}

async function validateGitDirectory(authorizedRoots: readonly AuthorizedRootIdentity[], gitDirectory: string): Promise<void> {
  let commonText: string;
  try {
    commonText = await readFile(join(gitDirectory, "commondir"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (commonText.length > 4096 || !commonText.trim()) {
    throw new Error("WORKDIR_MISMATCH: .git commondir metadata is malformed.");
  }
  const common = await assertGitMetadataInsideRoots(
    authorizedRoots,
    resolve(gitDirectory, commonText.trim()),
    ".git commondir target",
  );
  if (!(await stat(common)).isDirectory()) throw new Error("WORKDIR_MISMATCH: .git commondir target is not a directory.");
}

async function validateGitMarker(authorizedRoots: readonly AuthorizedRootIdentity[], markerPath: string): Promise<void> {
  const marker = await assertGitMetadataInsideRoots(authorizedRoots, markerPath, ".git marker");
  const markerStats = await stat(marker);
  if (markerStats.isDirectory()) {
    await validateGitDirectory(authorizedRoots, marker);
    return;
  }
  if (!markerStats.isFile() || markerStats.size > 4096) {
    throw new Error("WORKDIR_MISMATCH: .git marker is neither a bounded gitfile nor a directory.");
  }
  const text = await readFile(marker, "utf8");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (!lines[0]?.startsWith("gitdir: ") || lines.slice(1).some((line) => line.trim())) {
    throw new Error("WORKDIR_MISMATCH: .git gitfile is malformed.");
  }
  const target = lines[0].slice("gitdir: ".length).trim();
  if (!target) throw new Error("WORKDIR_MISMATCH: .git gitfile has an empty target.");
  const gitDirectory = await assertGitMetadataInsideRoots(
    authorizedRoots,
    isAbsolute(target) ? target : resolve(dirname(marker), target),
    ".git gitdir target",
  );
  if (!(await stat(gitDirectory)).isDirectory()) throw new Error("WORKDIR_MISMATCH: .git gitdir target is not a directory.");
  await validateGitDirectory(authorizedRoots, gitDirectory);
}

async function assertGitRepositoryCwd(
  workspaceRoot: string,
  authorizedRoots: readonly AuthorizedRootIdentity[],
  cwd: string,
): Promise<void> {
  let directory = cwd;
  while (true) {
    const markerPath = join(directory, ".git");
    try {
      await lstat(markerPath);
      await validateGitMarker(authorizedRoots, markerPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (directory === workspaceRoot) break;
    const parent = dirname(directory);
    if (parent === directory || !isInside(workspaceRoot, parent)) break;
    directory = parent;
  }
  throw new Error("WORKDIR_MISMATCH: git cwd is not inside a repository within the authorized workspace root. Set cwd to the target Git repository root.");
}

function sanitizedGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function prepareGitArguments(args: readonly string[]): string[] {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`POLICY_BLOCKED: git subcommand must be one of: ${[...ALLOWED_GIT_SUBCOMMANDS].join(", ")}.`);
  }
  for (const arg of args) {
    if (startsWithBlockedPrefix(arg, BLOCKED_GIT_OPTION_PREFIXES)) {
      throw new Error(`POLICY_BLOCKED: git option is not allowed in read-only mode: ${arg}`);
    }
  }
  const rest = args.slice(1);
  const subcommandArgs = subcommand === "diff" || subcommand === "log" || subcommand === "show"
    ? [subcommand, "--no-ext-diff", "--no-textconv", ...rest]
    : [subcommand, ...rest];
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...subcommandArgs];
}

async function prepareRipgrepArguments(cwd: string, args: readonly string[]): Promise<string[]> {
  if (args.length === 0) throw new Error("POLICY_BLOCKED: rg requires an explicit pattern or listing option.");
  for (const arg of args) {
    if (BLOCKED_RG_FOLLOW_SHORT_OPTION_PATTERN.test(arg) || startsWithBlockedPrefix(arg, BLOCKED_RG_FOLLOW_OPTION_PREFIXES)) {
      throw new Error(`POLICY_BLOCKED: rg ${arg} follows symbolic links and can escape the authorized roots. Keep the default no-follow behavior; use --files-without-match if GNU grep -L semantics were intended.`);
    }
    if (BLOCKED_RG_EXECUTION_SHORT_OPTION_PATTERN.test(arg) || startsWithBlockedPrefix(arg, BLOCKED_RG_EXECUTION_OPTION_PREFIXES)) {
      throw new Error(`POLICY_BLOCKED: rg option may execute an external preprocessor or decompression program and is not allowed: ${arg}`);
    }
  }
  const classification = classifyStructuredReadonlyArguments("rg", args);
  for (const argument of args) {
    if (!argument.includes("\\n")) continue;
    throw new Error("INPUT_VALIDATION: rg patterns cannot use the literal \\n escape in default line-oriented mode. For independent alternatives, pass multiple -e/--regexp arguments; for a true cross-line search, add -U/--multiline and use an actual newline-aware pattern.");
  }
  for (const argument of classification.rgUnboundDashArguments) {
    if (RG_DASH_PREFIXED_PATTERN_PATTERN.test(argument)) {
      throw new Error(`INPUT_VALIDATION: the rg search pattern starts with "-" and would be parsed as an option: ${argument}. Pass it through -e or --regexp, then provide an explicit search root.`);
    }
  }
  const searchPaths = classification.rgSearchPaths;
  const optionPaths = classification.rgOptionPaths;
  for (const path of searchPaths) {
    if (RG_POSITIONAL_GLOB_PATTERN.test(path)) {
      throw new Error(`INPUT_VALIDATION: rg positional paths are literal argv values and do not expand globs: ${path}. Use --glob ${path} and pass an explicit search root such as ".".`);
    }
  }
  for (const path of searchPaths) {
    if (path === "-") continue;
    const normalized = path.replace(LEADING_AT_PATTERN, "");
    if (!(await canonicalExistingPath(resolve(cwd, normalized)))) {
      throw new Error(`PATH_NOT_FOUND: rg search root does not exist: ${path}. Pass an existing explicit root, or use "." and filter files with --glob.`);
    }
  }
  for (const path of optionPaths) {
    const normalized = path.replace(LEADING_AT_PATTERN, "");
    if (!(await canonicalExistingPath(resolve(cwd, normalized)))) {
      throw new Error(`PATH_NOT_FOUND: rg option file does not exist: ${path}. Pass an existing file path.`);
    }
  }
  return ["--no-config", "--color=never", ...args];
}

export async function prepareStructuredCommand(
  workspaceCwd: string,
  input: StructuredCommandInput,
  additionalRoots: readonly string[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PreparedStructuredCommand> {
  const workspaceRoot = await realpath(resolve(workspaceCwd));
  const authorizedRoots = [workspaceRoot];
  for (const root of additionalRoots) {
    const canonicalRoot = await realpath(resolve(root));
    if (!authorizedRoots.includes(canonicalRoot)) authorizedRoots.push(canonicalRoot);
  }
  const authorizedRootIdentities: AuthorizedRootIdentity[] = [];
  for (const root of authorizedRoots) {
    const identity = await stat(root);
    if (!identity.isDirectory()) throw new Error(`POLICY_BLOCKED: authorized root is not a directory: ${root}`);
    authorizedRootIdentities.push({ path: root, device: identity.dev, inode: identity.ino });
  }
  const requestedCwd = resolve(workspaceRoot, (input.cwd ?? ".").replace(LEADING_AT_PATTERN, ""));
  if (!isInside(workspaceRoot, requestedCwd)) {
    throw new Error(`POLICY_BLOCKED: cwd escapes the workspace: ${input.cwd}`);
  }
  const cwd = await realpath(requestedCwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new Error(`WORKDIR_MISMATCH: cwd does not exist: ${input.cwd ?? "."}`);
    }
    throw error;
  });
  if (!isInside(workspaceRoot, cwd)) {
    throw new Error(`POLICY_BLOCKED: cwd resolves outside the workspace through a symlink or junction: ${input.cwd}`);
  }
  const cwdStats = await stat(cwd);
  if (!cwdStats.isDirectory()) throw new Error(`WORKDIR_MISMATCH: cwd is not a directory: ${input.cwd ?? "."}`);

  await validateArgumentPaths(authorizedRootIdentities, cwd, input.command, input.args);
  let args: string[];
  let env: NodeJS.ProcessEnv | undefined;
  if (input.command === "git") {
    args = prepareGitArguments(input.args);
    await assertGitRepositoryCwd(workspaceRoot, authorizedRootIdentities, cwd);
    env = sanitizedGitEnvironment(environment);
  } else {
    args = await prepareRipgrepArguments(cwd, input.args);
  }
  const executable = await resolveAllowedExecutable(input.command, workspaceRoot, environment, authorizedRoots.slice(1));
  return { workspaceRoot, authorizedRoots, cwd, command: input.command, executable, args, env };
}

export function classifyStructuredCommandResult(
  command: StructuredCommandName,
  code: number,
  killed: boolean,
  output = "",
): StructuredCommandCategory {
  if (killed) return "timeout_or_aborted";
  if (code === 0) return "success";
  if (command === "rg" && code === 1) return "no_matches";
  if (command === "rg" && RG_UNRECOGNIZED_FLAG_PATTERN.test(output)) return "input_validation";
  if (command === "git" && GIT_NOT_REPOSITORY_PATTERN.test(output)) return "workdir_mismatch";
  return "command_failed";
}
