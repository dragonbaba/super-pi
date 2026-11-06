import type { ShellAnalysisOwner } from "./shell-analysis.ts";
import { lexBash } from "./syntax/bash.ts";
import {
  DIALECT_POWERSHELL, EXPANSION_BRACE, EXPANSION_MASK, EXPANSION_QUOTED_VARIABLE, EXPANSION_SUBSTITUTION, EXPANSION_VARIABLE,
  SEGMENT_BACKGROUND, SEGMENT_CLOSE, SEGMENT_OPEN, type ShellTokenTable, WORD_DECODE, WORD_QUOTED, WORD_REDIRECTION,
} from "./syntax/token-table.ts";
import { lexWindowsScript, windowsWordText } from "./syntax/windows.ts";

/*
 * One read-only command judgment for Plan mode and the PowerShell permission scope, read
 * from the R1 token tables. A command is read-only when every segment is a listed reader
 * with no variable, substitution or file-writing redirection, joined only by `;`, `|`,
 * `&&`, `||` or newlines. Anything else (subshells, background jobs, assignments,
 * unknown programs) is not. Accident prevention, not an adversarial boundary.
 */

/** Built-in read-only Git subcommands; the configurable ones need an explicit opt-in. */
export const BUILTIN_SAFE_GIT_SUBCOMMANDS = ["status", "log", "diff", "show", "branch", "remote", "ls-files", "grep", "rev-parse", "blame"] as const;
export const CONFIGURABLE_SAFE_GIT_SUBCOMMANDS = ["describe", "merge-base", "ls-tree", "cat-file"] as const;
export const SAFE_GIT_SUBCOMMANDS = [...BUILTIN_SAFE_GIT_SUBCOMMANDS, ...CONFIGURABLE_SAFE_GIT_SUBCOMMANDS] as const;
export const SAFE_GH_SUBCOMMAND_PATHS = ["pr view", "pr list", "issue view", "issue list"] as const;

export type BuiltinSafeGitSubcommand = (typeof BUILTIN_SAFE_GIT_SUBCOMMANDS)[number];
export type ConfigurableSafeGitSubcommand = (typeof CONFIGURABLE_SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGitSubcommand = (typeof SAFE_GIT_SUBCOMMANDS)[number];
export type SafeGhSubcommandPath = (typeof SAFE_GH_SUBCOMMAND_PATHS)[number];
/** Opt-in subcommands; Plan mode reads them from its settings. */
export interface ReadOnlyShellSubcommands {
  readonly git?: readonly string[];
  readonly gh?: readonly string[];
}

/** Number of judgments, for the parse-once evidence. */
export const readOnlyShellCounters = { judgments: 0 };

const NO_SUBCOMMANDS: ReadOnlyShellSubcommands = Object.freeze({});
const DYNAMIC_WORD = EXPANSION_QUOTED_VARIABLE | EXPANSION_VARIABLE | EXPANSION_SUBSTITUTION;

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "cat", "cd", "head", "tail", "grep", "find", "ls", "pwd", "echo", "printf", "wc", "sort", "uniq", "diff", "file", "stat", "du", "df",
  "tree", "which", "whereis", "type", "uname", "whoami", "id", "date", "uptime", "ps", "jq", "rg", "fd", "bat", "eza",
]);
/** PowerShell cmdlets and aliases that only read the file system or format their input. */
const READ_ONLY_POWERSHELL_COMMANDS: ReadonlySet<string> = new Set([
  "cat", "cd", "chdir", "compare-object", "diff", "dir", "echo", "fl", "format-list", "format-table", "ft", "gc", "gci", "gcm",
  "get-childitem", "get-command", "get-content", "get-filehash", "get-item", "get-location", "gi", "gl", "ls", "measure",
  "measure-object", "out-string", "pwd", "resolve-path", "select", "select-object", "select-string", "set-location", "sl", "sls",
  "sort", "sort-object", "test-path", "type", "where", "where-object", "write-output",
]);
const FORBIDDEN_ARGUMENTS: ReadonlySet<string> = new Set(["--in-place", "--fix", "--write", "-delete", "--delete"]);
const FIND_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const VERSION_COMMANDS: ReadonlySet<string> = new Set(["node", "python", "python3", "tsc", "biome", "ruff", "ty"]);
const NPM_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "ls", "view", "info", "search", "outdated", "audit"]);
const BUILTIN_GIT: ReadonlySet<string> = new Set(BUILTIN_SAFE_GIT_SUBCOMMANDS);
const CONFIGURABLE_GIT: ReadonlySet<string> = new Set(CONFIGURABLE_SAFE_GIT_SUBCOMMANDS);
const GH_PATHS: ReadonlySet<string> = new Set(SAFE_GH_SUBCOMMAND_PATHS);
const HYPHEN = 45;

/**
 * The first segment that is not read-only, as written in the command, or undefined when
 * every segment is. An unparsable command is returned whole.
 */
export function findNonReadOnlyShellSegment(
  tool: "bash" | "powershell", command: string, subcommands: ReadOnlyShellSubcommands = NO_SUBCOMMANDS, analysisOwner?: ShellAnalysisOwner,
): string | undefined {
  readOnlyShellCounters.judgments++;
  const trimmed = command.trim();
  if (!trimmed) return "(empty command)";
  const powerShell = tool === "powershell";
  const table = powerShell
    ? analysisOwner ? analysisOwner.windowsTable(command, DIALECT_POWERSHELL) : lexWindowsScript(command, DIALECT_POWERSHELL)
    : analysisOwner ? analysisOwner.bashTable(command) : lexBash(command);
  // `$(...)`/`@(...)` bodies are scripts of their own; Plan mode does not run them.
  if (table.unterminated || table.nestedCount > 0 || table.segmentCount === 0) return trimmed;
  const argv: string[] = [];
  for (let segment = 0; segment < table.segmentCount; segment++) {
    if (!isReadOnlySegment(table, segment, powerShell, subcommands, argv)) {
      argv.length = 0;
      return table.source.slice(table.starts[table.segmentStart(segment)]!, table.ends[table.segmentEnds[segment]! - 1]!);
    }
  }
  argv.length = 0;
  return undefined;
}

/** The first PowerShell segment that is not read-only (the previous public name). */
export function findUnsafePowerShellSegment(command: string): string | undefined {
  return findNonReadOnlyShellSegment("powershell", command);
}

function isReadOnlySegment(table: ShellTokenTable, segment: number, powerShell: boolean, subcommands: ReadOnlyShellSubcommands, argv: string[]): boolean {
  const separator = table.segmentSeparators[segment]!;
  if (separator === SEGMENT_BACKGROUND || separator === SEGMENT_OPEN || separator === SEGMENT_CLOSE || table.segmentDepths[segment] !== 0) return false;
  if (table.segmentTestOpen[segment]! >= 0 || table.segmentArithmeticAt[segment]! >= 0) return false;
  argv.length = 0;
  const end = table.segmentEnds[segment]!;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!;
    if (flags & WORD_REDIRECTION) {
      if (index + 1 >= end || !isReadOnlyRedirection(table, index, powerShell)) return false;
      index++;
      continue;
    }
    // Script blocks are code; a Bash brace list only expands into more words.
    if (flags & DYNAMIC_WORD || powerShell && flags & EXPANSION_BRACE) return false;
    const text = table.texts ? table.texts[index]! : windowsWordText(table, index);
    if (argv.length === 0 && !powerShell && (flags & WORD_QUOTED) === 0 && isAssignment(text)) return false;
    argv.push(text);
  }
  if (argv.length === 0) return false;
  let name = argv[0]!.toLowerCase();
  if (powerShell) {
    if (name.endsWith(".exe")) name = name.slice(0, -4);
    if (READ_ONLY_POWERSHELL_COMMANDS.has(name)) return hasFileProviderArguments(argv);
  }
  if (!hasSafeArguments(name, argv)) return false;
  return READ_ONLY_COMMANDS.has(name) || isReadOnlyStructuredCommand(name, argv, subcommands);
}

/** Descriptor duplication, discarding to the null device, and Bash input from a file. */
function isReadOnlyRedirection(table: ShellTokenTable, index: number, powerShell: boolean): boolean {
  const target = index + 1, targetFlags = table.flags[target]!;
  if (targetFlags & WORD_REDIRECTION) return false;
  const operator = table.source.slice(table.starts[index]!, table.ends[index]!);
  const text = table.texts ? table.texts[target]! : windowsWordText(table, target);
  if (operator === ">&" || operator === "<&") return (targetFlags & EXPANSION_MASK) === 0 && isDescriptor(text);
  if (operator === ">" || operator === ">>" || operator === "&>" || operator === "&>>") {
    return powerShell
      ? (targetFlags & WORD_DECODE) === 0 && text.length === 5 && text.toLowerCase() === "$null"
      : (targetFlags & EXPANSION_MASK) === 0 && text === "/dev/null";
  }
  return operator === "<" && !powerShell && (targetFlags & DYNAMIC_WORD) === 0;
}

function isDescriptor(text: string): boolean {
  if (text === "-") return true;
  if (text.length === 0) return false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** `NAME=value` before the command changes its environment (`PAGER`, `GIT_*`). */
function isAssignment(text: string): boolean {
  const equals = text.indexOf("=");
  if (equals <= 0) return false;
  for (let index = 0; index < equals; index++) {
    const code = text.charCodeAt(index) | 0x20;
    const letter = code >= 97 && code <= 122 || text.charCodeAt(index) === 95;
    if (!letter && (index === 0 || text.charCodeAt(index) < 48 || text.charCodeAt(index) > 57)) return false;
  }
  return true;
}

/** A provider path (`env:`, `HKLM:`, `cert:`) or URL is not a file read. */
function hasFileProviderArguments(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!, colon = value.indexOf(":");
    if (colon < 0) continue;
    if (colon === 1) {
      const drive = value.charCodeAt(0) | 0x20;
      if (drive >= 97 && drive <= 122) continue;
    }
    return false;
  }
  return true;
}

function hasSafeArguments(name: string, argv: readonly string[]): boolean {
  let operands = 0;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (FORBIDDEN_ARGUMENTS.has(argument)) return false;
    const option = argument.charCodeAt(0) === HYPHEN;
    if (!option) operands++;
    switch (name) {
      case "sed":
        if (argument.startsWith("--in-place=") || option && argument.length > 1 && argument.charCodeAt(1) !== HYPHEN && argument.indexOf("i", 1) > 0) return false;
        break;
      case "find":
        if (FIND_ACTIONS.has(argument)) return false;
        break;
      case "date":
        if (argument === "-s" || argument.startsWith("--set")) return false;
        break;
      case "sort":
        if (argument.startsWith("-T") || argument.startsWith("--temporary-directory") || argument.startsWith("--compress-program")) return false;
        if (isOutputOption(argument)) return false;
        break;
      case "tree":
        if (isOutputOption(argument)) return false;
        break;
      case "diff":
        if (argument === "--output" || argument.startsWith("--output=")) return false;
        break;
      case "fd":
        if (argument === "-x" || argument === "-X" || argument.startsWith("-x=") || argument.startsWith("-X=")
          || argument === "--exec" || argument.startsWith("--exec=") || argument === "--exec-batch" || argument.startsWith("--exec-batch=")) return false;
        break;
      case "rg":
        if (argument === "--pre" || argument.startsWith("--pre=")) return false;
        break;
      case "bat":
        if (argument === "--pager" || argument.startsWith("--pager=")) return false;
        break;
    }
  }
  // `uniq in out` writes its second operand.
  return name !== "uniq" || operands <= 1;
}

function isOutputOption(argument: string): boolean {
  return argument === "-o" || argument.startsWith("-o") || argument.startsWith("--output");
}

function isReadOnlyStructuredCommand(name: string, argv: readonly string[], subcommands: ReadOnlyShellSubcommands): boolean {
  if (name === "git") return isReadOnlyGit(argv, subcommands);
  if (name === "gh") return isReadOnlyGh(argv, subcommands);
  if (name === "sed") return isPrintOnlySed(argv);
  if (VERSION_COMMANDS.has(name)) return argv.includes("--version") || name === "tsc" && isNoEmitTsc(argv);
  if (name === "npm") {
    let subcommand = -1;
    for (let index = 1; index < argv.length; index++) if (argv[index]!.charCodeAt(0) !== HYPHEN) { subcommand = index; break; }
    if (subcommand < 0) return false;
    const value = argv[subcommand]!.toLowerCase();
    if (value === "audit" && argv.indexOf("fix", subcommand + 1) >= 0) return false;
    return NPM_READ_SUBCOMMANDS.has(value);
  }
  return false;
}

/** `sed -n 'N[,M]p'` prints lines; every other script may write. */
function isPrintOnlySed(argv: readonly string[]): boolean {
  let script: string | undefined, quiet = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.charCodeAt(0) !== HYPHEN) { script ??= argument; continue; }
    if (argument.length > 1 && argument.charCodeAt(1) !== HYPHEN && argument.indexOf("n", 1) > 0 && argument.indexOf("-", 1) < 0) quiet = true;
  }
  return quiet && script !== undefined && isLineRangePrint(script);
}

/** `^\d+(,\d+)?p$` without a regular expression. */
function isLineRangePrint(script: string): boolean {
  const last = script.length - 1;
  if (last < 1 || script.charCodeAt(last) !== 112) return false;
  let digits = 0, comma = false;
  for (let index = 0; index < last; index++) {
    const code = script.charCodeAt(index);
    if (code >= 48 && code <= 57) { digits++; continue; }
    if (code !== 44 || comma || digits === 0) return false;
    comma = true; digits = 0;
  }
  return digits > 0;
}

function isNoEmitTsc(argv: readonly string[]): boolean {
  if (!argv.includes("--noEmit")) return false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--incremental" || argument.startsWith("--incremental=") || argument === "--tsBuildInfoFile"
      || argument.startsWith("--tsBuildInfoFile=") || argument === "--generateTrace" || argument.startsWith("--generateTrace=")) return false;
  }
  return true;
}

function isReadOnlyGit(argv: readonly string[], subcommands: ReadOnlyShellSubcommands): boolean {
  let index = 1;
  while (argv[index] === "--no-pager") index++;
  const subcommand = argv[index]?.toLowerCase();
  if (!subcommand || subcommand.charCodeAt(0) === HYPHEN) return false;
  if (!BUILTIN_GIT.has(subcommand) && !(CONFIGURABLE_GIT.has(subcommand) && subcommands.git?.includes(subcommand) === true)) return false;
  const from = index + 1;
  for (let cursor = from; cursor < argv.length; cursor++) if (isUnsafeGitArgument(subcommand, argv[cursor]!)) return false;
  switch (subcommand) {
    case "branch": return isReadOnlyGitBranch(argv, from);
    case "remote": return isReadOnlyGitRemote(argv, from);
    case "grep":
      for (let cursor = from; cursor < argv.length; cursor++) {
        const argument = argv[cursor]!;
        if (matchesLongOption(argument, "--textconv", "--textc") || matchesLongOption(argument, "--open-files-in-pager", "--op")
          || matchesLongOption(argument, "--ext-grep", "--ext")) return false;
      }
      return true;
    case "cat-file":
      for (let cursor = from; cursor < argv.length; cursor++) {
        const argument = argv[cursor]!;
        if (matchesLongOption(argument, "--filters", "--fi") || matchesLongOption(argument, "--textconv", "--t")) return false;
      }
      return true;
    default: return true;
  }
}

function isUnsafeGitArgument(subcommand: string, argument: string): boolean {
  return argument === "--help" || argument === "--show-signature" || argument.startsWith("--show-signature=") || argument.includes("%G")
    || argument === "--output" || argument.startsWith("--output=") || argument === "--ext-diff" || argument.startsWith("--ext-diff=")
    || argument === "--textconv" || argument.startsWith("--textconv=") || argument === "--paginate"
    || argument === "--open-files-in-pager" || argument.startsWith("--open-files-in-pager=")
    || subcommand === "grep" && argument.startsWith("-O");
}

/** `--opt`, `--opt=value`, or an unambiguous abbreviation at least as long as `shortest`. */
function matchesLongOption(argument: string, option: string, shortest: string): boolean {
  const equals = argument.indexOf("=");
  const length = equals < 0 ? argument.length : equals;
  return length >= shortest.length && length <= option.length && option.startsWith(equals < 0 ? argument : argument.slice(0, equals));
}

/** Listing only: a name operand creates a branch unless `--list` makes it a pattern. */
function isReadOnlyGitBranch(argv: readonly string[], from: number): boolean {
  let list = false, operands = false;
  for (let index = from; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.charCodeAt(0) !== HYPHEN) { operands = true; continue; }
    if (argument === "-l" || matchesLongOption(argument, "--list", "--li")) { list = true; continue; }
    if (argument.charCodeAt(1) !== HYPHEN && hasBranchWriteFlag(argument)) return false;
    if (matchesLongOption(argument, "--delete", "--del") || matchesLongOption(argument, "--move", "--mov")
      || matchesLongOption(argument, "--copy", "--cop") || matchesLongOption(argument, "--edit-description", "--e")
      || matchesLongOption(argument, "--unset-upstream", "--u") || matchesLongOption(argument, "--set-upstream-to", "--set-u")
      || matchesLongOption(argument, "--create-reflog", "--creat")) return false;
  }
  return !operands || list;
}

/** Short flags `d D m M c C u` delete, move, copy or set upstream. */
function hasBranchWriteFlag(argument: string): boolean {
  for (let index = 1; index < argument.length; index++) {
    switch (argument.charCodeAt(index)) {
      case 100: case 68: case 109: case 77: case 99: case 67: case 117: return true;
    }
  }
  return false;
}

function isReadOnlyGitRemote(argv: readonly string[], from: number): boolean {
  let action = -1;
  for (let index = from; index < argv.length; index++) if (argv[index]!.charCodeAt(0) !== HYPHEN) { action = index; break; }
  if (action < 0) return true;
  if (argv[action] === "get-url") return true;
  if (argv[action] !== "show") return false;
  let remotes = 0, offline = false;
  for (let index = action + 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--") return false;
    if (argument === "-n") offline = true;
    else if (argument.charCodeAt(0) !== HYPHEN) remotes++;
  }
  // `git remote show <name>` contacts the remote unless `-n`.
  return remotes === 0 || remotes === 1 && offline;
}

function isReadOnlyGh(argv: readonly string[], subcommands: ReadOnlyShellSubcommands): boolean {
  const group = argv[1]?.toLowerCase(), action = argv[2]?.toLowerCase();
  if (!group || !action || group.charCodeAt(0) === HYPHEN || action.charCodeAt(0) === HYPHEN) return false;
  const path = group + " " + action;
  if (!GH_PATHS.has(path) || subcommands.gh?.includes(path) !== true) return false;
  let json = false;
  for (let index = 3; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith("-w") || argument === "--web" || argument.startsWith("--web=") || argument === "--browser" || argument.startsWith("--browser=")
      || argument === "--paginate" || argument === "--pager" || argument.startsWith("--pager=") || argument === "--output" || argument.startsWith("--output=")) return false;
    if (argument === "--json") {
      const value = argv[index + 1];
      if (!value || value.charCodeAt(0) === HYPHEN) return false;
      json = true; index++;
    } else if (argument.startsWith("--json=")) {
      if (argument === "--json=") return false;
      json = true;
    }
  }
  return json;
}
