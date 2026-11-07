/**
 * Sandbox command facts (R5): which common network command a sandbox command runs, and
 * which static absolute drive paths it names. One tokenization per script; the tables
 * are module constants and the word buffer is reused (the call is synchronous; a literal
 * `bash -c` / `pwsh -Command` script is read after its caller's words are done).
 *
 * Accident prevention, not an adversarial boundary: dynamic words, `$(...)` bodies,
 * aliases and option values that hide the subcommand are not resolved. A missed network
 * command runs offline as before and its failure is classified afterwards.
 */
import { dispatchedCommandStart, isAssignment, isCommandPrefix, isLauncherSuffix } from "./readonly-command.ts";
import { prepareShellAnalysis } from "./shell-substitution.ts";
import { lexBash } from "./syntax/bash.ts";
import { EXPANSION_QUOTED_VARIABLE, EXPANSION_SUBSTITUTION, EXPANSION_VARIABLE, type ShellTokenTable, WORD_QUOTED, WORD_REDIRECTION } from "./syntax/token-table.ts";
import { DIALECT_POWERSHELL, lexWindowsScript, windowsWordText } from "./syntax/windows.ts";

export interface SandboxCommandFacts {
  /** The first common network command, e.g. `npm install`; undefined when none. */
  network: string | undefined;
  /** Static absolute drive paths (`D:\x`, `D:/x`, `--out=D:\x`), at most MAX_SANDBOX_COMMAND_PATHS. */
  readonly paths: string[];
}

export const MAX_SANDBOX_COMMAND_PATHS = 16;
const DYNAMIC_WORD = EXPANSION_QUOTED_VARIABLE | EXPANSION_VARIABLE | EXPANSION_SUBSTITUTION;
const MAX_DISPATCH_WRAPPERS = 4, MAX_SCRIPT_NESTING = 2;
/** Any subcommand (or none) needs the network. */
const ANY_SUBCOMMAND: ReadonlySet<string> = new Set();
const NETWORK_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["npm", new Set(["install", "i", "ci", "add", "update", "up", "upgrade", "publish", "view", "info", "outdated", "audit", "create"])],
  ["pnpm", new Set(["install", "i", "add", "update", "up", "upgrade", "fetch", "dlx", "publish", "outdated", "audit", "create"])],
  ["yarn", new Set(["install", "add", "upgrade", "up", "dlx", "outdated", "audit", "publish", "create"])],
  ["bun", new Set(["install", "i", "add", "update", "x", "publish", "outdated", "create"])],
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
/** `npx create-vite@latest`: a versioned package spec is fetched; `npx tsc` runs the local bin. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);
/** `curl --version` only prints. */
const INFO_FLAGS: ReadonlySet<string> = new Set(["--version", "-V", "--help", "-h", "-?", "-help"]);
/** npm/pnpm/yarn/uv/cargo `--offline` and pip `--no-index` never reach the network; `--prefer-offline` may. */
const OFFLINE_FLAGS: ReadonlySet<string> = new Set(["--offline", "--no-index"]);
/** `python -m pip install x`. */
const PYTHON_LAUNCHERS: ReadonlySet<string> = new Set(["python", "python3", "py"]);
/** Global options whose value precedes the subcommand (`git -C repo pull`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c"]);
const BASH_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const POWERSHELL_SHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell"]);
/** Commands whose arguments are text, not paths; their redirection targets still count. */
const TEXT_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf", "write", "write-output", "write-host", "write-information",
  "write-warning", "write-error", "write-verbose", "write-debug"]);
/** Search option values that are text/numbers, never files. This only narrows path diagnostics. */
const SEARCH_TEXT_OPTIONS: ReadonlySet<string> = new Set(["--glob", "--iglob", "--pre-glob", "--replace", "--type", "--type-not", "--type-add", "--type-clear",
  "--label", "--include", "--exclude", "--exclude-dir", "--color", "--colors", "--encoding", "--engine", "--sort", "--sortr",
  "--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--max-filesize", "--path-separator",
  "--context-separator", "--field-context-separator", "--field-match-separator", "--hyperlink-format", "--generate",
  "--dfa-size-limit", "--regex-size-limit", "--threads", "--max-columns", "--binary-files", "--directories", "--devices"]);
const SEARCH_FILE_OPTIONS: ReadonlySet<string> = new Set(["--ignore-file", "--exclude-from", "--pre", "--hostname-bin"]);
const OPEN_BRACE = "{", CLOSE_BRACE = "}", DYNAMIC = "$", EQUALS = "=", ASSIGNMENT = "_=";

const words: string[] = [];

/** Fill `facts` for one sandbox shell command (reset first). */
export function inspectSandboxCommand(tool: "bash" | "powershell", command: string, facts: SandboxCommandFacts): void {
  facts.network = undefined; facts.paths.length = 0;
  inspectScript(tool === "powershell", command, facts, 0);
  words.length = 0;
}

function inspectScript(powerShell: boolean, source: string, facts: SandboxCommandFacts, depth: number): void {
  // Heredoc bodies are data (`cat > fetch.sh <<'EOF' … curl … EOF`), masked as the R4 rule matcher does.
  if (!powerShell && source.indexOf("<<") >= 0) source = prepareShellAnalysis(source).command;
  const table = powerShell ? lexWindowsScript(source, DIALECT_POWERSHELL) : lexBash(source);
  for (let segment = 0; segment < table.segmentCount; segment++) {
    const script = inspectSegment(table, segment, powerShell, facts, depth);
    if (script !== undefined) inspectScript(script.charCodeAt(0) === 1, script.slice(1), facts, depth + 1);
  }
  // `$out = @(Invoke-WebRequest …)` collects a command's output; `$(...)` bodies stay a boundary, as in R4.
  if (powerShell && depth < MAX_SCRIPT_NESTING) for (let nested = 0; nested < table.nestedCount; nested++) {
    const start = table.nestedStarts[nested]!;
    if (table.source.charCodeAt(start - 2) === 64) inspectScript(true, table.source.slice(start, table.nestedEnds[nested]!), facts, depth + 1);
  }
}

function wordText(table: ShellTokenTable, index: number): string {
  return table.texts ? table.texts[index]! : windowsWordText(table, index);
}

/** Fill the word buffer; PowerShell braces become their own words (`{npm` → `{`, `npm`) and `$r=cmd` splits at `=`. */
function fillWords(table: ShellTokenTable, start: number, end: number, powerShell: boolean): void {
  words.length = 0;
  for (let index = start; index < end; index++) {
    const flags = table.flags[index]!;
    if (flags & WORD_REDIRECTION) { index++; continue; }
    // A dynamic word keeps its position and never names a command or a path.
    if (flags & DYNAMIC_WORD) {
      // `CI=$CI npm install`: the assignment prefix stays recognizable; only its value is dynamic.
      if (!powerShell) { words.push(isAssignment(wordText(table, index)) ? ASSIGNMENT : ""); continue; }
      const text = wordText(table, index), equals = assignmentEquals(text);
      words.push(DYNAMIC);
      if (equals > 0) { words.push(EQUALS); if (equals + 1 < text.length) words.push(text.slice(equals + 1)); }
      continue;
    }
    let text = wordText(table, index);
    if (powerShell && (flags & WORD_QUOTED) === 0 && text.length > 1) {
      if (text.charCodeAt(0) === 123) { words.push(OPEN_BRACE); text = text.slice(1); }
      if (text.length > 1 && text.charCodeAt(text.length - 1) === 125) { words.push(text.slice(0, -1)); words.push(CLOSE_BRACE); continue; }
    }
    words.push(text);
  }
}

/** Facts for one segment; returns a literal shell script operand to read next, prefixed by \u0001 for PowerShell or \u0000 for Bash. */
function inspectSegment(table: ShellTokenTable, segment: number, powerShell: boolean, facts: SandboxCommandFacts, depth: number): string | undefined {
  const start = table.segmentStart(segment), end = table.segmentEnds[segment]!;
  fillWords(table, start, end, powerShell);
  const program = programStart(0, powerShell);
  const name = program < 0 ? "" : programName(words[program]!);
  let script: string | undefined;
  if (facts.network === undefined) {
    // A PowerShell script block's body starts a command of its own (`ForEach-Object { iwr … }`).
    for (let from = 0; from < words.length && facts.network === undefined; from++) {
      if (from > 0 && words[from - 1] !== OPEN_BRACE) continue;
      const at = from === 0 ? program : programStart(from, powerShell);
      if (at >= 0) facts.network = networkCommand(programName(words[at]!), at, powerShell);
    }
  }
  if (program >= 0 && depth < MAX_SCRIPT_NESTING) script = scriptOperand(name, program);
  const search = name === "rg" || name === "grep";
  if (search) {
    // Wrappers are not search data: preserve their existing static paths (env -C / --chdir=).
    for (let index = 0; index <= program; index++) {
      const word = words[index]!, equals = word.charCodeAt(0) === 45 ? word.indexOf("=") : -1;
      addSearchPath(equals > 0 ? word.slice(equals + 1) : word, facts);
    }
    searchPaths(name, program + 1, facts);
  }
  const text = search || TEXT_COMMANDS.has(name);
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
  return script;
}

/** rg/grep patterns are data, including the first positional pattern and -e/--regexp.
 * File operands, -f pattern files and shell redirections keep their existing checks.
 * Read the already-tokenized words; this neither approves nor rejects any command.
 */
function searchPaths(name: string, start: number, facts: SandboxCommandFacts): void {
  let options = true, hasPattern = false, implicitPattern: string | undefined;
  for (let index = start; index < words.length; index++) {
    const word = words[index]!;
    if (options && word === "--") { options = false; continue; }
    if (options && word.length > 1 && word.charCodeAt(0) === 45) {
      let pattern = false, file = false;
      let value: string | undefined;
      if (word.charCodeAt(1) === 45) {
        const equals = word.indexOf("="), option = equals < 0 ? word : word.slice(0, equals);
        pattern = option === "--regexp" || option === "--file" || name === "rg" && option === "--files";
        file = option === "--file" || SEARCH_FILE_OPTIONS.has(option);
        // GNU grep --color[=WHEN] never consumes the next word; rg --color requires WHEN.
        const optionalValue = name === "grep" && option === "--color";
        if (option !== "--files" && (pattern || file || SEARCH_TEXT_OPTIONS.has(option)) && (equals >= 0 || !optionalValue)) {
          value = equals < 0 ? words[++index] : word.slice(equals + 1);
        }
      } else {
        // A short option taking a value ends its cluster: -Fe PATTERN, -fFILE, -gGLOB.
        for (let at = 1; at < word.length; at++) {
          const flag = word.charAt(at);
          if (flag !== "e" && flag !== "f" && !"ABCm".includes(flag) && !(name === "rg" ? "EdgjMrtT" : "dD").includes(flag)) continue;
          pattern = flag === "e" || flag === "f";
          file = flag === "f";
          value = at + 1 < word.length ? word.slice(at + 1) : words[++index];
          break;
        }
      }
      if (pattern) {
        // With an explicit pattern, an earlier positional word was a file after all.
        if (!hasPattern && implicitPattern !== undefined) addSearchPath(implicitPattern, facts);
        hasPattern = true;
      }
      if (file && value !== undefined) addSearchPath(value, facts);
      continue;
    }
    if (!hasPattern && implicitPattern === undefined) implicitPattern = word;
    else addSearchPath(word, facts);
  }
}

function addSearchPath(word: string, facts: SandboxCommandFacts): void {
  if (facts.paths.length < MAX_SANDBOX_COMMAND_PATHS && isDriveAbsolute(word, 0)) facts.paths.push(word);
}

/** `bash -c 'npm install'`, `pwsh -Command "npm install"`: the literal script, tagged with its dialect. */
function scriptOperand(name: string, program: number): string | undefined {
  const bash = BASH_SHELLS.has(name);
  if (!bash && !POWERSHELL_SHELLS.has(name)) return undefined;
  for (let index = program + 1; index < words.length; index++) {
    const word = words[index]!;
    if (!word || word.charCodeAt(0) !== 45) return undefined;
    const lower = word.toLowerCase();
    const command = bash ? word.charCodeAt(1) !== 45 && word.indexOf("c", 1) > 0 : lower === "-c" || lower === "-command";
    if (!command) {
      // `bash -euo pipefail -c '…'`: a trailing `o` takes the next word as its value.
      if (bash && word.charCodeAt(1) !== 45 && word.charCodeAt(word.length - 1) === 111) index++;
      continue;
    }
    let operand = index + 1;
    // `bash -c -e 'npm install'` is rare; the script is the next non-option word.
    while (bash && operand < words.length && words[operand]!.charCodeAt(0) === 45) operand++;
    const body = words[operand];
    return body ? (bash ? "\u0000" : "\u0001") + body : undefined;
  }
  return undefined;
}

/** `$result=` → the index of `=`; -1 when the word is not a simple PowerShell assignment. */
function assignmentEquals(text: string): number {
  if (text.charCodeAt(0) !== 36) return -1;
  for (let index = 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 61) return index > 1 && text.charCodeAt(index + 1) !== 61 ? index : -1;
    const letter = (code | 32) >= 97 && (code | 32) <= 122 || code >= 48 && code <= 57 || code === 95 || code === 58;
    if (!letter) return -1;
  }
  return -1;
}

/** Index of the command word at or after `from`, skipping assignments, control keywords and launch wrappers; -1 when none. */
function programStart(from: number, powerShell: boolean): number {
  let index = from;
  while (index < words.length) {
    const word = words[index]!;
    if (!word || powerShell && word === DYNAMIC && words[index + 1] !== EQUALS) return -1;
    if (isCommandPrefix(word, powerShell) || !powerShell && isAssignment(word)) { index++; continue; }
    // `$out = npm install`, `& npm install`
    if (powerShell && word === DYNAMIC) { index += 2; continue; }
    if (powerShell && word === "&") { index++; continue; }
    break;
  }
  if (index >= words.length || !words[index]) return -1;
  if (powerShell) return index;
  for (let depth = 0; depth < MAX_DISPATCH_WRAPPERS; depth++) {
    // `sudo env CI=1 npm install`: each wrapper is read from its own position.
    const next = dispatchedCommandStart(words, index);
    if (next === 0) break;
    index = next;
  }
  return words[index] ? index : -1;
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
  // `cmd /c npm install`: the rest of the words are the command.
  if (name === "cmd" && program + 2 < words.length && (words[program + 1]!.toLowerCase() === "/c" || words[program + 1]!.toLowerCase() === "/k")) {
    const at = programStart(program + 2, powerShell);
    return at > program + 1 && programName(words[at]!) !== "cmd" ? networkCommand(programName(words[at]!), at, powerShell) : undefined;
  }
  if (PACKAGE_RUNNERS.has(name)) return versionedPackage(program) ? name : undefined;
  const subcommands = NETWORK_COMMANDS.get(name);
  if (!subcommands) return undefined;
  if (subcommands === ANY_SUBCOMMAND) return informational(program) || loopbackOnly(program) ? undefined : name;
  let index = program + 1;
  while (index < words.length) {
    const word = words[index]!;
    if (!word || word.charCodeAt(0) !== 45) break;
    index += name === "git" && GIT_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  if (index >= words.length || words[index] === CLOSE_BRACE) return BARE_NETWORK_COMMANDS.has(name) ? name : undefined;
  const subcommand = powerShell ? words[index]!.toLowerCase() : words[index]!;
  return subcommands.has(subcommand) && !explicitlyOffline(index) ? name + " " + subcommand : undefined;
}

/**
 * `npm ci --offline`, `cargo fetch --offline`, `pip install --no-index -f wheels x`: the user asked
 * for no network. A URL argument (`--no-index --find-links https://…`) still fetches.
 */
function explicitlyOffline(subcommand: number): boolean {
  let offline = false;
  for (let index = subcommand + 1; index < words.length && words[index] !== CLOSE_BRACE; index++) {
    const word = words[index]!;
    if (OFFLINE_FLAGS.has(word)) offline = true;
    else if (word.includes("://")) return false;
  }
  return offline;
}

/** Only `--version` / `--help` style words follow the command. */
function informational(program: number): boolean {
  let seen = false;
  for (let index = program + 1; index < words.length && words[index] !== CLOSE_BRACE; index++) {
    if (!INFO_FLAGS.has(words[index]!)) return false;
    seen = true;
  }
  return seen;
}

/** Every URL names this machine (`curl http://127.0.0.1:3000/health`): the VM's own server, no network needed. */
function loopbackOnly(program: number): boolean {
  let seen = false;
  for (let index = program + 1; index < words.length && words[index] !== CLOSE_BRACE; index++) {
    const word = words[index]!, scheme = word.indexOf("://");
    if (scheme < 0 && !isLoopbackHost(word, 0)) continue;
    if (!isLoopbackHost(word, scheme < 0 ? 0 : scheme + 3)) return false;
    seen = true;
  }
  return seen;
}

function isLoopbackHost(word: string, at: number): boolean {
  const length = word.startsWith("localhost", at) ? 9 : word.startsWith("127.0.0.1", at) ? 9 : word.startsWith("[::1]", at) ? 5 : 0;
  if (length === 0) return false;
  const next = word.charCodeAt(at + length);
  return Number.isNaN(next) || next === 58 || next === 47;
}

/** The first package word carries a version (`create-vite@latest`, `@scope/cli@1`). */
function versionedPackage(program: number): boolean {
  for (let index = program + 1; index < words.length; index++) {
    const word = words[index]!;
    if (!word) return false;
    if (word.charCodeAt(0) === 45) continue;
    return word.indexOf("@", 1) > 0;
  }
  return false;
}

function isDriveAbsolute(text: string, at: number): boolean {
  if (text.length < at + 3 || text.charCodeAt(at + 1) !== 58) return false;
  const letter = text.charCodeAt(at) | 32, slash = text.charCodeAt(at + 2);
  return letter >= 97 && letter <= 122 && (slash === 92 || slash === 47);
}
