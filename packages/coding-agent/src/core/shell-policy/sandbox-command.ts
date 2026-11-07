/**
 * Sandbox command facts (R5): which common network command a sandbox command runs, and
 * which static absolute drive paths it names. One tokenization per command; the tables
 * are module constants and the word buffer is reused (the call is synchronous).
 *
 * Accident prevention, not an adversarial boundary: dynamic words, `$(...)` bodies,
 * aliases and option values that hide the subcommand are not resolved. A missed network
 * command runs offline as before and its failure is classified afterwards.
 */
import { dispatchedCommandStart, isAssignment, isCommandPrefix, isLauncherSuffix } from "./readonly-command.ts";
import { lexBash } from "./syntax/bash.ts";
import { EXPANSION_QUOTED_VARIABLE, EXPANSION_SUBSTITUTION, EXPANSION_VARIABLE, type ShellTokenTable, WORD_REDIRECTION } from "./syntax/token-table.ts";
import { DIALECT_POWERSHELL, lexWindowsScript, windowsWordText } from "./syntax/windows.ts";

export interface SandboxCommandFacts {
  /** The first common network command, e.g. `npm install`; undefined when none. */
  network: string | undefined;
  /** Static absolute drive paths (`D:\x`, `D:/x`, `--out=D:\x`), at most MAX_SANDBOX_COMMAND_PATHS. */
  readonly paths: string[];
}

export const MAX_SANDBOX_COMMAND_PATHS = 16;
const DYNAMIC_WORD = EXPANSION_QUOTED_VARIABLE | EXPANSION_VARIABLE | EXPANSION_SUBSTITUTION;
const MAX_DISPATCH_WRAPPERS = 4;
/** Any subcommand (or none) needs the network. */
const ANY_SUBCOMMAND: ReadonlySet<string> = new Set();
const NETWORK_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["npm", new Set(["install", "i", "ci", "add", "update", "up", "upgrade", "publish", "view", "info", "outdated", "audit"])],
  ["pnpm", new Set(["install", "i", "add", "update", "up", "upgrade", "fetch", "dlx", "publish", "outdated", "audit"])],
  ["yarn", new Set(["install", "add", "upgrade", "up", "dlx", "outdated", "audit", "publish"])],
  ["bun", new Set(["install", "i", "add", "update", "x", "publish", "outdated"])],
  ["pip", new Set(["install", "download"])],
  ["pip3", new Set(["install", "download"])],
  ["uv", new Set(["add", "sync", "lock"])],
  ["git", new Set(["clone", "fetch", "pull", "push", "ls-remote"])],
  ["cargo", new Set(["install", "fetch", "update", "add", "search", "publish"])],
  ["go", new Set(["get", "install"])],
  ["dotnet", new Set(["restore"])],
  ["gem", new Set(["install", "update", "fetch"])],
  ["composer", new Set(["install", "require", "update"])],
  ["curl", ANY_SUBCOMMAND], ["wget", ANY_SUBCOMMAND],
  ["invoke-webrequest", ANY_SUBCOMMAND], ["iwr", ANY_SUBCOMMAND], ["invoke-restmethod", ANY_SUBCOMMAND], ["irm", ANY_SUBCOMMAND],
  ["install-module", ANY_SUBCOMMAND], ["install-package", ANY_SUBCOMMAND],
]);
/** A bare `yarn` installs. */
const BARE_NETWORK_COMMANDS: ReadonlySet<string> = new Set(["yarn"]);
/** `python -m pip install x`. */
const PYTHON_LAUNCHERS: ReadonlySet<string> = new Set(["python", "python3", "py"]);
/** Global options whose value precedes the subcommand (`git -C repo pull`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c"]);
/** Commands whose arguments are text, not paths; their redirection targets still count. */
const TEXT_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "write", "write-output", "write-host", "write-information",
  "write-warning", "write-error", "write-verbose", "write-debug"]);

const words: string[] = [];

/** Fill `facts` for one sandbox shell command (reset first). */
export function inspectSandboxCommand(tool: "bash" | "powershell", command: string, facts: SandboxCommandFacts): void {
  facts.network = undefined; facts.paths.length = 0;
  const powerShell = tool === "powershell";
  const table = powerShell ? lexWindowsScript(command, DIALECT_POWERSHELL) : lexBash(command);
  for (let segment = 0; segment < table.segmentCount; segment++) inspectSegment(table, segment, powerShell, facts);
  words.length = 0;
}

function wordText(table: ShellTokenTable, index: number): string {
  return table.texts ? table.texts[index]! : windowsWordText(table, index);
}

function inspectSegment(table: ShellTokenTable, segment: number, powerShell: boolean, facts: SandboxCommandFacts): void {
  const start = table.segmentStart(segment), end = table.segmentEnds[segment]!;
  words.length = 0;
  for (let index = start; index < end; index++) {
    const flags = table.flags[index]!;
    if (flags & WORD_REDIRECTION) { index++; continue; }
    // A dynamic word keeps its position and never names a command or a path; in PowerShell
    // it stays `$` so `$out = npm install` still reads as an assignment.
    words.push(flags & DYNAMIC_WORD ? powerShell ? "$" : "" : wordText(table, index));
  }
  const program = programStart(words, powerShell);
  const name = program < 0 ? "" : programName(words[program]!);
  if (facts.network === undefined && program >= 0) facts.network = networkCommand(name, program, powerShell);
  const text = TEXT_COMMANDS.has(name);
  for (let index = start; index < end && facts.paths.length < MAX_SANDBOX_COMMAND_PATHS; index++) {
    const flags = table.flags[index]!, target = (flags & WORD_REDIRECTION) !== 0;
    if (target) index++;
    if (index >= end || text && !target || table.flags[index]! & DYNAMIC_WORD) continue;
    const word = wordText(table, index);
    if (isDriveAbsolute(word, 0)) facts.paths.push(word);
    else if (word.charCodeAt(0) === 45) {
      // `--prefix=D:\x`
      const equals = word.indexOf("=");
      if (equals > 0 && isDriveAbsolute(word, equals + 1)) facts.paths.push(word.slice(equals + 1));
    }
  }
}

/** Index of the command word after assignments, control keywords and launch wrappers; -1 when none. */
function programStart(argv: readonly string[], powerShell: boolean): number {
  let index = 0;
  while (index < argv.length) {
    const word = argv[index]!;
    if (!word || powerShell && word === "$" && argv[index + 1] !== "=") return -1;
    if (isCommandPrefix(word, powerShell) || !powerShell && isAssignment(word)) { index++; continue; }
    // `$out = npm install`
    if (powerShell && word.charCodeAt(0) === 36 && argv[index + 1] === "=") { index += 2; continue; }
    break;
  }
  if (powerShell) return index < argv.length && argv[index] ? index : -1;
  for (let depth = 0; depth < MAX_DISPATCH_WRAPPERS && index < argv.length; depth++) {
    // `sudo env CI=1 npm install`: each wrapper is read from its own position.
    const next = dispatchedCommandStart(argv, index);
    if (next === 0) break;
    index = next;
  }
  return index < argv.length && argv[index] ? index : -1;
}

/** `C:\Program Files\Git\cmd\git.exe` → `git`; `npm.cmd` → `npm`. */
function programName(word: string): string {
  let from = 0;
  for (let index = word.length - 1; index >= 0; index--) {
    const code = word.charCodeAt(index);
    if (code === 47 || code === 92) { from = index + 1; break; }
  }
  let to = word.length;
  if (to - from > 4 && word.charCodeAt(to - 4) === 46 && isLauncherSuffix(word, to - 3)) to -= 4;
  return (from === 0 && to === word.length ? word : word.slice(from, to)).toLowerCase();
}

function networkCommand(name: string, program: number, powerShell: boolean): string | undefined {
  // `python -m pip install x`
  if (PYTHON_LAUNCHERS.has(name) && words[program + 1] === "-m" && program + 2 < words.length) {
    program += 2; name = programName(words[program]!);
    if (name !== "pip" && name !== "pip3") return undefined;
  }
  const subcommands = NETWORK_COMMANDS.get(name);
  if (!subcommands) return undefined;
  if (subcommands === ANY_SUBCOMMAND) return name;
  let index = program + 1;
  while (index < words.length) {
    const word = words[index]!;
    if (!word || word.charCodeAt(0) !== 45) break;
    index += name === "git" && GIT_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  if (index >= words.length) return BARE_NETWORK_COMMANDS.has(name) ? name : undefined;
  const subcommand = powerShell ? words[index]!.toLowerCase() : words[index]!;
  return subcommands.has(subcommand) ? name + " " + subcommand : undefined;
}

function isDriveAbsolute(text: string, at: number): boolean {
  if (text.length < at + 3 || text.charCodeAt(at + 1) !== 58) return false;
  const letter = text.charCodeAt(at) | 32, slash = text.charCodeAt(at + 2);
  return letter >= 97 && letter <= 122 && (slash === 92 || slash === 47);
}
