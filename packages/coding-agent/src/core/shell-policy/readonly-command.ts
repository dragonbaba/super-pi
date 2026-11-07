import { MAX_REMEMBERED_RULES, MAX_RULE_COMMAND, type ProjectRuleSet, RULE_ALLOW, RULE_ASK, RULE_DENY, RULE_NONE } from "../project-permissions.ts";
import type { ShellAnalysisOwner } from "./shell-analysis.ts";
import { prepareShellAnalysis } from "./shell-substitution.ts";
import { lexBash } from "./syntax/bash.ts";
import {
  DIALECT_POWERSHELL, EXPANSION_BRACE, EXPANSION_GLOB, EXPANSION_MASK, EXPANSION_QUOTED_VARIABLE, EXPANSION_SUBSTITUTION, EXPANSION_VARIABLE,
  SEGMENT_BACKGROUND, SEGMENT_CLOSE, SEGMENT_CR, SEGMENT_LF, SEGMENT_OPEN, SEGMENT_SEQUENCE, type ShellTokenTable, WORD_DECODE, WORD_QUOTED, WORD_REDIRECTION,
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
/*
 * Host-restricted: file commands whose every target the native mutation analysis records.
 * Only names that analysis recognizes belong here; its targets decide allow or ask.
 */
const FILE_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "mkdir", "touch", "cp", "mv"]);
/*
 * The only options a Bash file command may carry: none of them changes which paths are
 * written. Others (`cp -t DIR`, `--target-directory`, `-S`, `-b`, `-l`, `-s`, `touch -r`,
 * `rmdir -p`, which also removes ancestors) move or add writes the analysis does not
 * model, so the segment is not a file command.
 */
const FILE_COMMAND_SHORT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  rm: "rRfvd", rmdir: "v", mkdir: "pv", touch: "acm", cp: "rRfvpnu", mv: "fvnu",
});
const FILE_COMMAND_LONG_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  rm: new Set(["--recursive", "--force", "--verbose", "--dir"]),
  rmdir: new Set(["--verbose"]),
  mkdir: new Set(["--parents", "--verbose"]),
  touch: new Set(["--no-create"]),
  cp: new Set(["--recursive", "--force", "--verbose", "--no-clobber", "--update"]),
  mv: new Set(["--force", "--verbose", "--no-clobber", "--update"]),
});
const POWERSHELL_FILE_COMMANDS: ReadonlySet<string> = new Set([
  "remove-item", "ri", "rm", "del", "erase", "rd", "rmdir", "new-item", "ni", "mkdir", "md", "set-content", "add-content", "ac",
  "clear-content", "clc", "out-file", "copy-item", "cpi", "cp", "copy", "move-item", "mi", "mv", "move", "rename-item", "rni", "ren",
]);
/** File commands that can bring an existing link to a new path (`cp -r` keeps nested links). */
const RELOCATING_COMMANDS: ReadonlySet<string> = new Set(["cp", "mv"]);
const POWERSHELL_RELOCATING_COMMANDS: ReadonlySet<string> = new Set([
  "copy-item", "cpi", "cp", "copy", "move-item", "mi", "mv", "move", "rename-item", "rni", "ren",
]);
/** The native mutation scanners' segment limit (`MAX_SEGMENTS`, `MAX_SCRIPT_SEGMENTS`). */
const MAX_HOST_SEGMENTS = 64;
/** Readers that change the PowerShell location for the segments after them. */
const POWERSHELL_LOCATION_COMMANDS: ReadonlySet<string> = new Set(["cd", "chdir", "set-location", "sl"]);
/** Segment classes; a file command or a reader's file redirection is a FILE segment. */
const SEGMENT_REJECTED = 0, SEGMENT_READER = 1, SEGMENT_FILE = 2;
/**
 * Unquoted words that open a segment without being its program: Bash keywords and prefixes
 * (`then git push`), PowerShell block braces and dot-sourcing. Deny/ask rules skip them.
 */
const BASH_COMMAND_PREFIXES: ReadonlySet<string> = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "function", "coproc"]);
const POWERSHELL_COMMAND_PREFIXES: ReadonlySet<string> = new Set(["{", ".", "try", "catch", "finally", "if", "elseif", "else",
  "do", "while", "until", "foreach", "for", "switch", "trap", "return", "throw", "exit", "function", "filter", "begin", "process", "end", "clean",
  "dynamicparam"]);

/** Whether a Bash command has an unquoted heredoc (`npm test --grep '<<'` has none); the scan runs only when `<<` appears. */
function hasBashHeredoc(command: string): boolean {
  return command.indexOf("<<") >= 0 && prepareShellAnalysis(command).hasHeredoc;
}

/** Where a PowerShell hashtable entry is: not in one, after its key, or after its `=`. */
const HASH_NONE = 0, HASH_OPERATOR = 1, HASH_VALUE = 2;

/** A hashtable key word (`npm`, `npm=`, `npm=10`): pushes an attached value and returns what follows. */
function hashtableKey(argv: string[], word: string, quoted: boolean, valueQuoted: boolean): number {
  const equals = quoted ? -1 : word.indexOf("=");
  if (equals < 0) return HASH_OPERATOR;
  if (equals === word.length - 1) return HASH_VALUE;
  // `@{label='npm'}`: a quoted value is a string, which matches no rule.
  argv.push(valueQuoted ? "" : word.slice(equals + 1));
  return HASH_NONE;
}

/** `switch` in any case; its next brace opens a body of labels and action blocks. */
function isSwitchKeyword(text: string): boolean {
  return text.length === 6 && (text === "switch" || text.toLowerCase() === "switch");
}

function isQuoteCode(code: number): boolean {
  return code === 39 || code === 34;
}

function hasQuote(source: string, start: number, stop: number): boolean {
  for (let index = start; index < stop; index++) if (isQuoteCode(source.charCodeAt(index))) return true;
  return false;
}

/** Whether `text[start, stop)` has a brace, outside quotes when `quoteAware` (`--replace="{npm}"` has none). */
function hasStructuralBrace(text: string, start: number, stop: number, quoteAware: boolean): boolean {
  let quote = 0;
  for (let index = start; index < stop; index++) {
    const code = text.charCodeAt(index);
    if (quote !== 0) { if (code === quote) quote = 0; }
    else if (quoteAware && isQuoteCode(code)) quote = code;
    else if (code === 123 || code === 125) return true;
  }
  return false;
}

/** `source[start, stop)` without its quote characters: the word a quoted piece spells. */
function unquotedText(source: string, start: number, stop: number): string {
  let text = "";
  for (let index = start; index < stop; index++) if (!isQuoteCode(source.charCodeAt(index))) text += source[index];
  return text;
}

/** The first `=` in `source[start, stop)` outside quotes, or -1: `'publish-result'=git` assigns at its `=`. */
function unquotedEquals(source: string, start: number, stop: number): number {
  let quote = 0;
  for (let index = start; index < stop; index++) {
    const code = source.charCodeAt(index);
    if (quote !== 0) { if (code === quote) quote = 0; }
    else if (isQuoteCode(code)) quote = code;
    else if (code === 61) return index;
  }
  return -1;
}

/** Whether a PowerShell string opens at `at`: a quote, or a here-string's `@'`/`@"`. */
function isStringStart(source: string, at: number): boolean {
  const code = source.charCodeAt(at);
  return isQuoteCode(code) || code === 64 && isQuoteCode(source.charCodeAt(at + 1));
}

/** Whether the raw word's first `=` is followed by a string: `$label='npm'` assigns one. */
function rawValueQuoted(source: string, start: number, stop: number): boolean {
  const equals = source.indexOf("=", start);
  return equals >= 0 && equals + 1 < stop && isStringStart(source, equals + 1);
}

/** Whether the PowerShell word at `start` follows a call operator: `& 'npm'` or `. 'script.ps1'`. */
function isInvokedWord(source: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && (source.charCodeAt(index) === 32 || source.charCodeAt(index) === 9)) index--;
  if (index < 0) return false;
  const code = source.charCodeAt(index), before = index > 0 ? source.charCodeAt(index - 1) : 32;
  if (code === 38) return before !== 38; // `&`, not the `&&` chain operator
  return code === 46 && (before === 32 || before === 9 || before === 10 || before === 13 || before === 59 || before === 123 || before === 40 || before === 124);
}

/** Whether the separator at `at` (after any blank lines) ends a Bash `case` arm: `;;`, `;&` or `;;&`. */
function endsCaseArm(source: string, at: number): boolean {
  let index = at;
  for (; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
  }
  if (source.charCodeAt(index) !== 59) return false;
  const next = source.charCodeAt(index + 1);
  return next === 59 || next === 38;
}

/** Length of the leading PowerShell type casts (`[string]`, `[string[]]`) in `text`, or 0. */
function castPrefixLength(text: string): number {
  let index = 0;
  while (text.charCodeAt(index) === 91) {
    let depth = 0, cursor = index;
    for (; cursor < text.length; cursor++) {
      const code = text.charCodeAt(cursor);
      if (code === 91) depth++;
      else if (code === 93 && --depth === 0) break;
    }
    if (cursor >= text.length) return 0;
    index = cursor + 1;
  }
  return index;
}

/** Length of the PowerShell assignment operator (`=`, `+=`, `-=`, `*=`, `/=`, `%=`, `??=`) opening `word`, or 0. */
function assignmentOperatorLength(word: string): number {
  const first = word.charCodeAt(0), second = word.charCodeAt(1);
  if (first === 61) return 1;
  if (second === 61 && (first === 43 || first === 45 || first === 42 || first === 47 || first === 37)) return 2;
  return first === 63 && second === 63 && word.charCodeAt(2) === 61 ? 3 : 0;
}

/** Whether `text` opens a command without being its program (PowerShell keywords in any case). */
function isCommandPrefix(text: string, powerShell: boolean): boolean {
  if (!powerShell) return BASH_COMMAND_PREFIXES.has(text);
  if (POWERSHELL_COMMAND_PREFIXES.has(text)) return true;
  const first = text.charCodeAt(0);
  return first >= 65 && first <= 90 && text.length <= 12 && POWERSHELL_COMMAND_PREFIXES.has(text.toLowerCase());
}

/** Bash builtins and launchers that run the command after them (`command git push`, `sudo -u x make`). */
/** One wrapper's options: those taking a value (`sudo -u ci`, `nice -n 5`) and short query flags (`command -v`, `sudo -l`). */
interface WrapperOptions { readonly values: ReadonlySet<string>; readonly shortValues: string; readonly queries: string; }
function wrapperOptions(values: readonly string[], queries = ""): WrapperOptions {
  let shortValues = "";
  for (const value of values) if (value.length === 2) shortValues += value[1];
  return { values: new Set(values), shortValues, queries };
}
const NO_WRAPPER_OPTIONS = wrapperOptions([]);
const BASH_DISPATCH_WRAPPERS: ReadonlyMap<string, WrapperOptions> = new Map([
  ["command", wrapperOptions([], "vV")], ["builtin", NO_WRAPPER_OPTIONS], ["nohup", NO_WRAPPER_OPTIONS], ["time", NO_WRAPPER_OPTIONS],
  // `--replace[=R]`, `--eof[=E]` and `--max-lines[=N]` take only an attached optional value.
  ["xargs", wrapperOptions(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter",
    "--max-args", "--max-procs", "--max-chars", "--process-slot-var"])],
  ["exec", wrapperOptions(["-a"])],
  ["sudo", wrapperOptions(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "--user", "--group", "--host", "--prompt", "--close-from",
    "--chdir", "--role", "--type", "--command-timeout", "--other-user"], "l")],
  ["doas", wrapperOptions(["-u", "-C"])],
  ["env", wrapperOptions(["-u", "-C", "--unset", "--chdir"])],
  ["nice", wrapperOptions(["-n", "--adjustment"])],
  ["timeout", wrapperOptions(["-s", "-k", "--signal", "--kill-after"])],
]);
const MAX_DISPATCH_WRAPPERS = 4;

/** Where the command run by the leading wrapper starts, or 0 (no wrapper, or a `command -v` / `sudo -l` query). */
function dispatchedCommandStart(argv: readonly string[]): number {
  const name = argv[0]!, options = BASH_DISPATCH_WRAPPERS.get(name);
  if (!options) return 0;
  let index = 1;
  while (index < argv.length) {
    const word = argv[index]!;
    if (word === "--") {
      // `env -- CI=1 cmd`: assignments still precede the command after the terminator.
      index++;
      if (name === "env" || name === "sudo") while (index < argv.length && isAssignment(argv[index]!)) index++;
      break;
    }
    if (word.length > 1 && word.charCodeAt(0) === 45) {
      if (word.charCodeAt(1) === 45) {
        // `sudo --list cmd` only lists whether the command is permitted.
        if (name === "sudo" && word === "--list") return 0;
        index += options.values.has(word) ? 2 : 1;
        continue;
      }
      // A short cluster (`-pv`, `-Eu ci`, `-phello`): a query flag looks the command up
      // (`command -v`, `sudo -l`); a value-taking letter ends the cluster with its value.
      let taken = 1;
      for (let cursor = 1; cursor < word.length; cursor++) {
        const letter = word[cursor]!;
        if (options.queries.indexOf(letter) >= 0) return 0;
        if (options.shortValues.indexOf(letter) >= 0) { if (cursor === word.length - 1) taken = 2; break; }
      }
      index += taken;
      continue;
    }
    // `env CI=1 cmd` and `sudo CI=1 cmd` set variables for the command they run.
    if ((name === "env" || name === "sudo") && isAssignment(word) || name === "env" && word === "-") { index++; continue; }
    break;
  }
  if (name === "timeout") index++; // the duration
  return index < argv.length ? index : 0;
}

/** Whether `text` has `exe`, `cmd`, `bat`, `com` or `ps1` (any case) at `at`: a Windows launcher suffix. */
function isLauncherSuffix(text: string, at: number): boolean {
  const a = text.charCodeAt(at) | 32, b = text.charCodeAt(at + 1) | 32, c = text.charCodeAt(at + 2) | 32;
  return a === 101 && b === 120 && c === 101 || a === 99 && b === 109 && c === 100 || a === 98 && b === 97 && c === 116
    || a === 99 && b === 111 && c === 109 || a === 112 && b === 115 && c === 49;
}

/** The rule decision for one command's words; `/usr/bin/git push`, `git.exe push` and `npm.cmd publish` also match without directory and launcher suffix (may rewrite `argv[0]`). */
function matchCommandWords(rules: ProjectRuleSet, argv: string[]): number {
  let matched = rules.matchShellWords(rulesPowerShell, argv);
  const first = argv[0]!, length = first.length;
  // `/usr/bin/git` and `C:\Program Files\Git\cmd\git.exe` also match as `git`.
  const start = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\")) + 1;
  const stop = length - start > 4 && first.charCodeAt(length - 4) === 46 && isLauncherSuffix(first, length - 3) ? length - 4 : length;
  if (matched !== RULE_DENY && (start > 0 || stop < length) && stop > start) {
    argv[0] = first.slice(start, stop);
    const bare = rules.matchShellWords(rulesPowerShell, argv);
    if (bare > matched) matched = bare;
  }
  return matched;
}

/**
 * The stronger of `verdict` and the deny/ask rule matching the words collected so far: as
 * written, and for Bash at each level of leading dispatch wrappers (`env sudo git push`
 * matches `env *`, `sudo *` and `git push *`), including the commands `find -exec` runs.
 * Shifts `argv` in place.
 */
function strongerRuleVerdict(rules: ProjectRuleSet, powerShell: boolean, argv: string[], verdict: number): number {
  if (argv.length === 0) return verdict;
  let matched = matchCommandWords(rules, argv);
  if (!powerShell) matched = dispatchedRuleVerdict(rules, argv, matched, true);
  else if (matched !== RULE_DENY) { const script = scriptOperandVerdict(rules, argv, true); if (script > matched) matched = script; }
  return matched >= RULE_ASK && matched > verdict ? matched : verdict;
}

/** `matched` raised by the rules matching each level of Bash dispatch wrappers in `argv`. */
function dispatchedRuleVerdict(rules: ProjectRuleSet, argv: string[], matched: number, findActions: boolean): number {
  for (let depth = 0; matched !== RULE_DENY; depth++) {
    // `bash -c 'git push'` runs its script operand; nothing after it is another wrapper level.
    const script = scriptOperandVerdict(rules, argv, false);
    if (script >= 0) { if (script > matched) matched = script; break; }
    if (findActions && argv[0] === "find") {
      const action = findActionVerdict(rules, argv);
      if (action > matched) matched = action;
      if (matched === RULE_DENY) break;
    }
    if (depth >= MAX_DISPATCH_WRAPPERS) break;
    const start = dispatchedCommandStart(argv);
    if (start === 0) break;
    argv.copyWithin(0, start);
    argv.length -= start;
    const dispatched = matchCommandWords(rules, argv);
    if (dispatched > matched) matched = dispatched;
  }
  return matched;
}

const BASH_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const POWERSHELL_SHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell"]);
/** Nested script operands analyzed at once; deeper ones are matched as written only. */
const MAX_SCRIPT_NESTING = 3;
let scriptNesting = 0;
/**
 * The calling tool's rule set (true: PowerShell rules). A nested script is parsed in its own
 * shell's dialect but still runs under that tool, so `pwsh -Command "git push"` from Bash
 * matches the Bash rules. Set by the outermost `shellRuleVerdict` call.
 */
let rulesPowerShell = false;

/**
 * The rule verdict for the literal script a shell runs (`bash -lc 'git push'`,
 * `pwsh -Command git push`, `cmd /c git push`), or -1 when `argv` runs no script operand. The program name
 * has already been reduced to its basename by `matchCommandWords`.
 */
function scriptOperandVerdict(rules: ProjectRuleSet, argv: readonly string[], powerShell: boolean): number {
  const first = argv[0]!;
  if (scriptNesting >= MAX_SCRIPT_NESTING) return -1;
  // `cmd /c git push` / `cmd /d /c "git push"`: the rest is parsed in the calling shell's dialect.
  if (first.length === 3 && (first.charCodeAt(0) | 32) === 99 && (first.charCodeAt(1) | 32) === 109 && (first.charCodeAt(2) | 32) === 100) {
    for (let index = 1; index < argv.length; index++) {
      const word = argv[index]!;
      if (word.length < 2 || word.charCodeAt(0) !== 47) return -1;
      const letter = word.charCodeAt(1) | 32;
      if (word.length === 2 && (letter === 99 || letter === 107)) { // `/c`, `/k`
        if (index + 1 >= argv.length) return -1;
        let script = argv[index + 1]!;
        for (let rest = index + 2; rest < argv.length; rest++) script += " " + argv[rest]!;
        return nestedScriptVerdict(rules, powerShell ? "powershell" : "bash", script);
      }
    }
    return -1;
  }
  if (BASH_SHELLS.has(first)) {
    // `bash -n -c '…'` / `-o noexec` only reads the script; `+n` turns that off again.
    let noExec = false;
    for (let index = 1; index < argv.length; index++) {
      const word = argv[index]!, sign = word.charCodeAt(0);
      if (word.length < 2 || sign !== 45 && sign !== 43) return -1; // a script file
      if (word === "--") return -1;
      if (word.charCodeAt(1) === 45) { // `--login`, `--norc`; `--rcfile FILE` and `--init-file FILE` take a value
        if (word === "--rcfile" || word === "--init-file") index++;
        continue;
      }
      if (word.indexOf("n") > 0) noExec = sign === 45;
      if (word.indexOf("c") > 0) {
        if (index + 1 >= argv.length) return -1;
        return noExec ? RULE_NONE : nestedScriptVerdict(rules, "bash", argv[index + 1]!);
      }
      if (word === "-o" || word === "+o" || word === "-O" || word === "+O") { // `-o pipefail`
        if (index + 1 < argv.length && argv[index + 1] === "noexec" && word.charCodeAt(1) === 111) noExec = sign === 45;
        index++;
      }
    }
    return -1;
  }
  // `pwsh` / `powershell` in any case; only those lengths are lowercased.
  if ((first.charCodeAt(0) | 32) !== 112 || first.length !== 4 && first.length !== 10 || !POWERSHELL_SHELLS.has(first.toLowerCase())) return -1;
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index]!;
    if (word.length < 2 || word.charCodeAt(0) !== 45) return -1; // a script file
    const option = word.toLowerCase();
    // `-c`, `-Command` and its prefixes: the remaining words are the script.
    if (option.length >= 2 && "-command".startsWith(option)) {
      if (index + 1 >= argv.length) return -1;
      let script = argv[index + 1]!;
      for (let rest = index + 2; rest < argv.length; rest++) script += " " + argv[rest]!;
      return nestedScriptVerdict(rules, "powershell", script);
    }
    // Options taking a value: `-ExecutionPolicy Bypass`, `-WorkingDirectory dir`.
    if (option === "-executionpolicy" || option === "-ep" || option === "-workingdirectory" || option === "-wd" || option === "-windowstyle"
      || option === "-w" || option === "-outputformat" || option === "-of" || option === "-inputformat" || option === "-if") index++;
  }
  return -1;
}

function nestedScriptVerdict(rules: ProjectRuleSet, tool: "bash" | "powershell", script: string, analysisOwner?: ShellAnalysisOwner): number {
  scriptNesting++;
  try {
    return shellRuleVerdict(tool, script, rules, analysisOwner);
  } finally {
    scriptNesting--;
  }
}

const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Reused word buffer for one `find -exec` command; `shellRuleVerdict` does not nest. */
const findActionWords: string[] = [];

/** The strongest rule matching the commands of `find`'s `-exec` and `-execdir` actions (`-exec rm {} +`). */
function findActionVerdict(rules: ProjectRuleSet, argv: readonly string[]): number {
  let matched = RULE_NONE;
  for (let index = 1; index < argv.length && matched !== RULE_DENY; index++) {
    if (!FIND_EXEC_ACTIONS.has(argv[index]!)) continue;
    findActionWords.length = 0;
    for (index++; index < argv.length; index++) {
      const word = argv[index]!;
      if (word === ";" || word === "+") break;
      findActionWords.push(word);
    }
    if (findActionWords.length === 0) continue;
    const action = dispatchedRuleVerdict(rules, findActionWords, matchCommandWords(rules, findActionWords), false);
    if (action > matched) matched = action;
  }
  findActionWords.length = 0;
  return matched;
}
/** `ruleWords` results: not matchable, plain words, or words with a literal file redirection. */
const RULE_WORDS_NONE = 0, RULE_WORDS_PLAIN = 1, RULE_WORDS_WRITES = 2;
/** `classifyHostShellCommand` results. RULE_ALLOWED: every other segment matched a project allow rule. */
export const HOST_SHELL_READ_ONLY = 0, HOST_SHELL_FILE_COMMANDS = 1, HOST_SHELL_OTHER = 2, HOST_SHELL_RULE_ALLOWED = 3;
export type HostShellCommandClass = typeof HOST_SHELL_READ_ONLY | typeof HOST_SHELL_FILE_COMMANDS | typeof HOST_SHELL_OTHER
  | typeof HOST_SHELL_RULE_ALLOWED;
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
  const powerShell = tool === "powershell", table = commandTable(powerShell, command, analysisOwner);
  // `$(...)`/`@(...)` bodies are scripts of their own; Plan mode does not run them.
  if (table.unterminated || table.nestedCount > 0 || table.segmentCount === 0) return trimmed;
  const argv: string[] = [];
  for (let segment = 0; segment < table.segmentCount; segment++) {
    if (classifySegment(table, segment, powerShell, subcommands, false, argv) !== SEGMENT_READER) {
      argv.length = 0;
      return table.source.slice(table.starts[table.segmentStart(segment)]!, table.ends[table.segmentEnds[segment]! - 1]!);
    }
  }
  argv.length = 0;
  return undefined;
}

/**
 * The host-restricted tier's command class: every segment a reader (read-only), every
 * segment a reader or a listed file command with literal operands (file commands), or other.
 * File commands run without asking only when the native analysis confirms all their targets.
 */
export function classifyHostShellCommand(tool: "bash" | "powershell", command: string, analysisOwner?: ShellAnalysisOwner,
  rules?: ProjectRuleSet): HostShellCommandClass {
  readOnlyShellCounters.judgments++;
  if (!command.trim()) return HOST_SHELL_OTHER;
  const powerShell = tool === "powershell", table = commandTable(powerShell, command, analysisOwner);
  // The native scanners stop after 64 segments; a file command must be scanned whole.
  if (table.unterminated || table.nestedCount > 0 || table.segmentCount === 0 || table.segmentCount > MAX_HOST_SEGMENTS) return HOST_SHELL_OTHER;
  const argv: string[] = [];
  // Heredoc bodies are data the raw table cannot delimit, so allow rules leave such commands alone.
  const ruled = rules !== undefined && rules.hasShellRules(powerShell) && (powerShell || !hasBashHeredoc(command));
  let result: HostShellCommandClass = HOST_SHELL_READ_ONLY, moved = false;
  for (let segment = 0; segment < table.segmentCount; segment++) {
    const kind = classifySegment(table, segment, powerShell, NO_SUBCOMMANDS, true, argv);
    const words = kind === SEGMENT_REJECTED && ruled ? ruleWords(table, segment, powerShell, argv) : RULE_WORDS_NONE;
    if (words !== RULE_WORDS_NONE && rules!.matchShellWords(powerShell, argv) === RULE_ALLOW) {
      // Its own redirection was checked before anything ran, like any later file command.
      if (words === RULE_WORDS_WRITES && moved) { result = HOST_SHELL_OTHER; break; }
      // A command the user allowed may change files too, so a later file command asks.
      result = HOST_SHELL_RULE_ALLOWED; moved = true;
      continue;
    }
    // Targets are canonicalized before anything runs. After a PowerShell location change, or a
    // copy/move that may bring a link to a new path, a later write may land elsewhere.
    if (kind === SEGMENT_REJECTED || kind === SEGMENT_FILE && moved) { result = HOST_SHELL_OTHER; break; }
    const name = argv[0]!.toLowerCase();
    if (kind === SEGMENT_FILE) {
      result = HOST_SHELL_FILE_COMMANDS;
      if ((powerShell ? POWERSHELL_RELOCATING_COMMANDS : RELOCATING_COMMANDS).has(name)) moved = true;
    }
    // A redirected `Set-Location x > log` is a file segment and still moves.
    if (powerShell && POWERSHELL_LOCATION_COMMANDS.has(name)) moved = true;
  }
  argv.length = 0;
  return result;
}

/**
 * The strongest project deny or ask rule any segment matches (subshell segments and PowerShell
 * `@(...)` bodies included, `$(...)` bodies and heredoc bodies not). Words are compared as written and leading Bash
 * assignments are skipped, so `git push *` also matches `FOO=1 git push $REMOTE`.
 */
export function shellRuleVerdict(tool: "bash" | "powershell", command: string, rules: ProjectRuleSet, analysisOwner?: ShellAnalysisOwner): number {
  const powerShell = tool === "powershell";
  if (scriptNesting === 0) rulesPowerShell = powerShell;
  if (!rules.hasShellRules(rulesPowerShell) || !command.trim()) return RULE_NONE;
  let source = command, verdict = RULE_NONE;
  if (!powerShell) {
    // Match the commands around heredoc bodies, not the bodies (a stray quote in one would
    // swallow the commands after it). A heredoc that cannot be delimited asks. The owner's
    // view is not used: it rewrites `node <<EOF` as `node -e ...`, which an exact rule misses.
    const view = prepareShellAnalysis(command);
    source = view.command;
    if (view.uncertain && rules.hasRestrictiveShellRules(rulesPowerShell)) verdict = RULE_ASK;
  }
  const table = commandTable(powerShell, source, analysisOwner), argv: string[] = [];
  // Bash `case` arm patterns (`git)`) are not commands. PowerShell keeps one bit per open
  // brace, set for a hashtable (`@{ npm = "10" }`), whose keys are not commands either.
  // A hashtable key opens the hashtable or follows `;` or a line break, never `(` or `&`
  // (`@{ out = (git push) }`, `@{ out = & git push }` run their command for the value).
  // A `switch` body (`switch ($t) { git { … } }`) is tracked the same way: its labels are not commands.
  let caseDepth = 0, casePattern = false, braceKinds = 0, switchKinds = 0, braceDepth = 0, hashEntry = HASH_NONE, keyPosition = false, switchPending = false;
  // Bash array elements (`packages=(git curl jq)`) are data: segments at or below this depth are skipped.
  let arrayDepth = 0;
  for (let segment = 0; segment < table.segmentCount && verdict !== RULE_DENY; segment++) {
    argv.length = 0;
    const previous = segment > 0 ? table.segmentSeparators[segment - 1]! : -1;
    // The PowerShell lexer records a line break as SEGMENT_SEQUENCE too; only the source tells it from `;`.
    const firstToken = table.segmentStart(segment);
    const lineBreak = previous === SEGMENT_LF || previous === SEGMENT_CR || powerShell && previous === SEGMENT_SEQUENCE
      && table.source.lastIndexOf(";", table.starts[firstToken]!) < table.ends[firstToken - 1]!;
    // `@{ result =⏎ git push }`: a line break may separate `=` from its value.
    hashEntry = hashEntry === HASH_VALUE && lineBreak ? HASH_VALUE : HASH_NONE;
    keyPosition = hashEntry === HASH_NONE && (previous === SEGMENT_SEQUENCE || lineBreak);
    const end = table.segmentEnds[segment]!;
    if (!powerShell) {
      if (arrayDepth > 0) { if (table.segmentDepths[segment]! >= arrayDepth) continue; arrayDepth = 0; }
      // The segment's first command word, past control-flow prefixes (`then case …`, `do case …`).
      let first = table.segmentStart(segment);
      while (first < end - 1 && (table.flags[first]! & WORD_QUOTED) === 0 && isCommandPrefix(table.texts![first]!, false)) first++;
      const head = first < end && (table.flags[first]! & WORD_QUOTED) === 0 ? table.texts![first]! : "";
      // `case WORD in PATTERN)`: patterns run until a `)` ends their segment.
      if (head === "case") { caseDepth++; casePattern = table.segmentSeparators[segment] !== SEGMENT_CLOSE; continue; }
      // A nested `esac;;` also ends the enclosing arm, so the outer patterns follow.
      if (caseDepth > 0 && head === "esac") {
        caseDepth--;
        casePattern = caseDepth > 0 && endsCaseArm(table.source, table.segmentSourceEnds[segment]!);
        continue;
      }
      if (casePattern) { if (table.segmentSeparators[segment] === SEGMENT_CLOSE) casePattern = false; continue; }
    }
    for (let index = table.segmentStart(segment); index < end; index++) {
      const flags = table.flags[index]!;
      if (flags & WORD_REDIRECTION) { index++; continue; }
      let text = table.texts ? table.texts[index]! : windowsWordText(table, index);
      // A PowerShell string in command position (`$label = 'npm'`) is a value, not a command;
      // only `& 'npm'` or `. 'script.ps1'` invokes one. Its words then match nothing.
      // `rawLow` is where `text` starts in the source when `text` is a sliced value (`$r=@{…}`).
      let expression = false, rawLow = table.starts[index]!;
      if (powerShell) {
        const braced = text.indexOf("{") >= 0 || text.indexOf("}") >= 0, atKey = keyPosition;
        let valued = false;
        keyPosition = false;
        if (hashEntry === HASH_OPERATOR) {
          hashEntry = HASH_NONE;
          const operator = (flags & WORD_QUOTED) === 0 && !braced ? assignmentOperatorLength(text) : 0;
          if (operator === text.length) { hashEntry = HASH_VALUE; continue; }
          if (operator > 0) { text = text.slice(operator); valued = true; rawLow += operator; }
        }
        // A hashtable key names data; the value after `=` may be a command (`@{ sha = git rev-parse HEAD }`).
        if (valued || hashEntry === HASH_VALUE) hashEntry = HASH_NONE;
        else if (atKey && argv.length === 0 && (braceKinds & 1) !== 0 && !braced) {
          // A quoted key may carry its value too (`'publish-result'=git push`): find `=` outside the quotes.
          const stop = table.ends[index]!;
          const equals = (flags & WORD_QUOTED) === 0 ? table.source.indexOf("=", rawLow) : unquotedEquals(table.source, rawLow, stop);
          if (equals < 0 || equals >= stop) { hashEntry = HASH_OPERATOR; continue; }
          if (equals === stop - 1) { hashEntry = HASH_VALUE; continue; }
          text = (flags & WORD_QUOTED) === 0 ? text.slice(text.indexOf("=") + 1) : unquotedText(table.source, equals + 1, stop);
          valued = true; rawLow = equals + 1;
        } else if (atKey && argv.length === 0 && (switchKinds & 1) !== 0 && !braced) continue; // a switch label
        const start = table.starts[index]!;
        expression = argv.length === 0 && (valued ? rawLow < table.ends[index]! && isStringStart(table.source, rawLow)
          : (flags & WORD_QUOTED) !== 0 && isStringStart(table.source, start) && !isInvokedWord(table.source, start));
      }
      if (powerShell && (flags & WORD_QUOTED) !== 0) {
        // `try { git push origin "main"}`: braces outside the quotes still close the block.
        const start = table.starts[index]!, stop = table.ends[index]!, raw = table.source;
        let open = 0, close = 0;
        while (start + open < stop && raw.charCodeAt(start + open) === 123) open++;
        while (stop - close > start + open && raw.charCodeAt(stop - close - 1) === 125) close++;
        if (open > 0) { verdict = strongerRuleVerdict(rules, true, argv, verdict); argv.length = 0; braceKinds = braceKinds << open; switchKinds = switchKinds << open; braceDepth += open; switchPending = false; }
        if (open > 0 || close > 0) {
          const word = text.slice(open, Math.max(open, text.length - close));
          if (word || expression) argv.push(expression ? "" : word);
          if (close > 0) {
            verdict = strongerRuleVerdict(rules, true, argv, verdict); argv.length = 0;
            const closed = close < braceDepth ? close : braceDepth;
            braceKinds >>>= closed; switchKinds >>>= closed; braceDepth -= closed; keyPosition = (switchKinds & 1) !== 0;
          }
          continue;
        }
      }
      if ((flags & WORD_QUOTED) === 0) {
        // A PowerShell segment keeps its script blocks (`try { git push } catch { … }`), and a
        // brace may touch a word (`try {git push}`). Each brace ends the command before it.
        if (powerShell) {
          // `$null = git push` / `$out += npm test`: the command is on the assignment's right-hand side.
          // Spacing around the operator varies (`$r = git`, `$r=git`, `$r= git`, `$r =git`), and the
          // target may be typed (`[string]$r = git`); a lone cast word (`[string] $r = …`) is skipped.
          const cast = argv.length === 0 ? castPrefixLength(text) : 0;
          if (cast > 0 && cast === text.length) continue;
          // An attached right-hand side (`$r=@{ … }`, `$r='npm'`) is parsed like any other word.
          if (argv.length === 0 && text.charCodeAt(cast) === 36) {
            // `$first, $rest = git push`: every target before the last is skipped.
            while (index + 1 < end && (text.charCodeAt(text.length - 1) === 44 || windowsWordText(table, index + 1).charCodeAt(0) === 44)) {
              index++;
              text = windowsWordText(table, index);
              rawLow = table.starts[index]!;
            }
            const equals = text.indexOf("=", cast);
            if (equals > cast + 1) {
              if (equals === text.length - 1) continue;
              expression = rawValueQuoted(table.source, table.starts[index]!, table.ends[index]!);
              text = text.slice(equals + 1); rawLow = table.source.indexOf("=", rawLow) + 1;
            } else {
              const next = index + 1 < end ? windowsWordText(table, index + 1) : "", operator = assignmentOperatorLength(next);
              if (operator > 0) {
                index++;
                if (operator === next.length) continue;
                expression = rawValueQuoted(table.source, table.starts[index]!, table.ends[index]!);
                text = next.slice(operator); rawLow = table.starts[index]! + operator;
              }
            }
          }
          // Every brace outside quotes is a block boundary, attached or not (`try{ git push }catch{}`);
          // a quoted one is text (`--replace="{npm}"`). The pieces between braces are words, and
          // each brace ends the command before it.
          const rawWord = (text.indexOf("{") >= 0 || text.indexOf("}") >= 0) && hasQuote(table.source, rawLow, table.ends[index]!);
          const scan = rawWord ? table.source : text, low = rawWord ? rawLow : 0, high = rawWord ? table.ends[index]! : text.length;
          if (hasStructuralBrace(scan, low, high, rawWord)) {
            let from = low, quote = 0;
            for (let cursor = low; cursor <= high; cursor++) {
              const code = cursor < high ? scan.charCodeAt(cursor) : -1;
              if (quote !== 0 && code !== -1) { if (code === quote) quote = 0; continue; }
              if (rawWord && isQuoteCode(code)) { quote = code; continue; }
              if (code !== 123 && code !== 125 && code !== -1) continue;
              if (cursor > from) {
                const word = rawWord ? unquotedText(scan, from, cursor) : scan.slice(from, cursor), atKey = keyPosition;
                keyPosition = false;
                if (atKey && hashEntry === HASH_NONE && argv.length === 0 && (braceKinds & 1) !== 0) hashEntry = hashtableKey(argv, word, false, rawWord && rawValueQuoted(scan, from, cursor));
                else if (expression && argv.length === 0) { hashEntry = HASH_NONE; argv.push(""); }
                else if (atKey && argv.length === 0 && (switchKinds & 1) !== 0) hashEntry = HASH_NONE; // a switch label
                else {
                  hashEntry = HASH_NONE;
                  if (argv.length > 0 || !isCommandPrefix(word, true)) argv.push(word);
                  else if (isSwitchKeyword(word)) switchPending = true;
                }
              }
              if (code !== -1) {
                verdict = strongerRuleVerdict(rules, true, argv, verdict); argv.length = 0; hashEntry = HASH_NONE;
                // `@{` opens a hashtable; any other `{` a script block.
                if (code === 123) {
                  const hash = cursor > low && scan.charCodeAt(cursor - 1) === 64;
                  const body = switchPending && !hash;
                  braceKinds = braceKinds << 1 | (hash ? 1 : 0); switchKinds = switchKinds << 1 | (body ? 1 : 0);
                  braceDepth++; keyPosition = hash || body; switchPending = false;
                } else {
                  if (braceDepth > 0) { braceKinds >>>= 1; switchKinds >>>= 1; braceDepth--; }
                  // After an action block, a switch body's next word is another label.
                  keyPosition = (switchKinds & 1) !== 0;
                }
              }
              from = cursor + 1;
            }
            continue;
          }
        }
        // `function publish { git push; }`: the body's first command follows the name and brace.
        if (argv.length === 0 && !powerShell && text === "function") { index++; continue; }
        // `coproc NAME { git push; }`: a name is optional and only precedes a compound command.
        if (argv.length === 0 && !powerShell && text === "coproc") { if (index + 2 < end && table.texts![index + 2] === "{") index++; continue; }
        if (argv.length === 0 && (isCommandPrefix(text, powerShell) || !powerShell && isAssignment(text))) {
          if (powerShell && isSwitchKeyword(text)) switchPending = true;
          continue;
        }
      }
      argv.push(expression && argv.length === 0 ? "" : text);
    }
    verdict = strongerRuleVerdict(rules, powerShell, argv, verdict);
    if (caseDepth > 0 && endsCaseArm(table.source, table.segmentSourceEnds[segment]!)) casePattern = true;
    // `name=(` / `name+=(` opens an array: its elements are the deeper segments that follow.
    if (!powerShell && table.segmentSeparators[segment] === SEGMENT_OPEN && (table.flags[end - 1]! & WORD_QUOTED) === 0) {
      const last = table.texts![end - 1]!;
      if (last.length > 1 && last.charCodeAt(last.length - 1) === 61) arrayDepth = table.segmentDepths[segment]! + 1;
    }
  }
  argv.length = 0;
  // `$out = @(git push)` collects a command's output, so the lexer's `@(...)` bodies are matched too.
  if (powerShell && scriptNesting < MAX_SCRIPT_NESTING) {
    for (let nested = 0; nested < table.nestedCount && verdict !== RULE_DENY; nested++) {
      const start = table.nestedStarts[nested]!;
      if (table.source.charCodeAt(start - 2) !== 64) continue;
      const body = nestedScriptVerdict(rules, "powershell", table.source.slice(start, table.nestedEnds[nested]!), analysisOwner);
      if (body > verdict) verdict = body;
    }
  }
  return verdict;
}

/**
 * Prefix rules that would let this command run in host-restricted next time: one for each
 * segment that is neither a reader nor a file command (`npm test *`, `make`). Undefined when
 * the command's structure rather than its programs asks, or when more than five are needed.
 */
export function suggestShellRules(tool: "bash" | "powershell", command: string): string[] | undefined {
  const powerShell = tool === "powershell";
  if (!powerShell && hasBashHeredoc(command)) return undefined;
  const table = commandTable(powerShell, command, undefined);
  if (table.unterminated || table.nestedCount > 0 || table.segmentCount === 0 || table.segmentCount > MAX_HOST_SEGMENTS) return undefined;
  const argv: string[] = [], suggestions: string[] = [];
  let moved = false;
  for (let segment = 0; segment < table.segmentCount; segment++) {
    const kind = classifySegment(table, segment, powerShell, NO_SUBCOMMANDS, true, argv);
    if (kind === SEGMENT_FILE && moved) return undefined;
    if (kind === SEGMENT_REJECTED) {
      const words = ruleWords(table, segment, powerShell, argv);
      // A redirection after a possible file change would still ask once the rule is saved.
      if (words === RULE_WORDS_NONE || words === RULE_WORDS_WRITES && moved) return undefined;
      const rule = prefixRule(argv);
      if (rule === undefined) return undefined;
      if (!suggestions.includes(rule)) {
        if (suggestions.length === MAX_REMEMBERED_RULES) return undefined;
        suggestions.push(rule);
      }
      moved = true;
      continue;
    }
    const name = argv[0]!.toLowerCase();
    if (kind === SEGMENT_FILE && (powerShell ? POWERSHELL_RELOCATING_COMMANDS : RELOCATING_COMMANDS).has(name)) moved = true;
    if (powerShell && POWERSHELL_LOCATION_COMMANDS.has(name)) moved = true;
  }
  return suggestions.length ? suggestions : undefined;
}

const RULE_UNSAFE_WORD = /[\s*]/;
/** `npm test -x` → `npm test *`; `ls -la` → `ls *`; a lone `make` stays exact. */
function prefixRule(argv: readonly string[]): string | undefined {
  const name = argv[0]!;
  // The rule file rejects longer commands, so such a rule could never be saved.
  if (RULE_UNSAFE_WORD.test(name) || name.length + 2 > MAX_RULE_COMMAND) return undefined;
  if (argv.length === 1) return name;
  const second = argv[1]!;
  return second.charCodeAt(0) === HYPHEN || RULE_UNSAFE_WORD.test(second) || name.length + second.length + 3 > MAX_RULE_COMMAND
    ? name + " *" : name + " " + second + " *";
}

/**
 * The words of a plain top-level simple command, skipping read-only and literal file
 * redirections. False when a word is dynamic, so a project allow rule never matches
 * text that is only known when the command runs.
 */
function ruleWords(table: ShellTokenTable, segment: number, powerShell: boolean, argv: string[]): number {
  const separator = table.segmentSeparators[segment]!;
  if (separator === SEGMENT_BACKGROUND || separator === SEGMENT_OPEN || separator === SEGMENT_CLOSE || table.segmentDepths[segment] !== 0) return RULE_WORDS_NONE;
  if (table.segmentTestOpen[segment]! >= 0 || table.segmentArithmeticAt[segment]! >= 0) return RULE_WORDS_NONE;
  argv.length = 0;
  let result = RULE_WORDS_PLAIN;
  const end = table.segmentEnds[segment]!;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!;
    if (flags & WORD_REDIRECTION) {
      if (index + 1 >= end) return RULE_WORDS_NONE;
      if (!isReadOnlyRedirection(table, index, powerShell)) {
        if (!isLiteralFileRedirection(table, index, powerShell)) return RULE_WORDS_NONE;
        result = RULE_WORDS_WRITES;
      }
      index++;
      continue;
    }
    if (flags & (DYNAMIC_WORD | EXPANSION_BRACE) || argv.length === 0 && flags & EXPANSION_GLOB) return RULE_WORDS_NONE;
    const text = table.texts ? table.texts[index]! : windowsWordText(table, index);
    // A segment that opens with control flow (`then npm test`), or a PowerShell segment holding
    // a script block (`ForEach-Object { git push }`), is not one plain command.
    if (argv.length === 0 && !text || (flags & WORD_QUOTED) === 0 && (powerShell && (text.indexOf("{") >= 0 || text.indexOf("}") >= 0)
      || argv.length === 0 && (isCommandPrefix(text, powerShell) || !powerShell && isAssignment(text)))) return RULE_WORDS_NONE;
    argv.push(text);
  }
  return argv.length > 0 ? result : RULE_WORDS_NONE;
}

function commandTable(powerShell: boolean, command: string, analysisOwner: ShellAnalysisOwner | undefined): ShellTokenTable {
  return powerShell
    ? analysisOwner ? analysisOwner.windowsTable(command, DIALECT_POWERSHELL) : lexWindowsScript(command, DIALECT_POWERSHELL)
    : analysisOwner ? analysisOwner.bashTable(command) : lexBash(command);
}

/** The first PowerShell segment that is not read-only (the previous public name). */
export function findUnsafePowerShellSegment(command: string): string | undefined {
  return findNonReadOnlyShellSegment("powershell", command);
}

/** A reader, a file command or a reader's file redirection (only with `fileCommands`), or rejected. */
function classifySegment(table: ShellTokenTable, segment: number, powerShell: boolean, subcommands: ReadOnlyShellSubcommands,
  fileCommands: boolean, argv: string[]): number {
  const separator = table.segmentSeparators[segment]!;
  if (separator === SEGMENT_BACKGROUND || separator === SEGMENT_OPEN || separator === SEGMENT_CLOSE || table.segmentDepths[segment] !== 0) return SEGMENT_REJECTED;
  if (table.segmentTestOpen[segment]! >= 0 || table.segmentArithmeticAt[segment]! >= 0) return SEGMENT_REJECTED;
  argv.length = 0;
  let globs = false, writes = false;
  const end = table.segmentEnds[segment]!;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!;
    if (flags & WORD_REDIRECTION) {
      if (index + 1 >= end) return SEGMENT_REJECTED;
      if (!isReadOnlyRedirection(table, index, powerShell)) {
        if (!fileCommands || !isLiteralFileRedirection(table, index, powerShell)) return SEGMENT_REJECTED;
        writes = true;
      }
      index++;
      continue;
    }
    // Script blocks are code; a Bash brace list expands into words the checks below never see.
    if (flags & (DYNAMIC_WORD | EXPANSION_BRACE)) return SEGMENT_REJECTED;
    if (flags & EXPANSION_GLOB) globs = true;
    const text = table.texts ? table.texts[index]! : windowsWordText(table, index);
    if (argv.length === 0 && !powerShell && (flags & WORD_QUOTED) === 0 && isAssignment(text)) return SEGMENT_REJECTED;
    argv.push(text);
  }
  if (argv.length === 0) return SEGMENT_REJECTED;
  const name = argv[0]!.toLowerCase(), reader = writes ? SEGMENT_FILE : SEGMENT_READER;
  if (fileCommands && (powerShell ? POWERSHELL_FILE_COMMANDS : FILE_COMMANDS).has(name))
    return (powerShell ? hasFileProviderArguments(argv) && hasPlainItemType(name, argv) : hasKnownFileCommandOptions(name, argv)) ? SEGMENT_FILE : SEGMENT_REJECTED;
  // An explicit `sort.exe` is the native program, not the cmdlet alias, and is not listed.
  if (powerShell && READ_ONLY_POWERSHELL_COMMANDS.has(name)) return hasFileProviderArguments(argv) ? reader : SEGMENT_REJECTED;
  // A glob may expand into the second operand `uniq` writes; the count below cannot see it.
  if (globs && name === "uniq" || !hasSafeArguments(name, argv)) return SEGMENT_REJECTED;
  return READ_ONLY_COMMANDS.has(name) || isReadOnlyStructuredCommand(name, argv, subcommands) ? reader : SEGMENT_REJECTED;
}

/**
 * `New-Item` creates only files and directories here: a link or junction would redirect a
 * later write in the same command, before canonicalization could see it.
 */
function hasPlainItemType(name: string, argv: readonly string[]): boolean {
  if (name !== "new-item" && name !== "ni") return true;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!.toLowerCase();
    if (argument.charCodeAt(0) !== HYPHEN) continue;
    const colon = argument.indexOf(":"), parameter = colon < 0 ? argument : argument.slice(0, colon);
    // `-ItemType` (prefixes from `-i`) and its alias `-Type`.
    // PowerShell binds prefixes of aliases too (`-ty`); `-t` is checked as well, at worst asking.
    if (parameter.length < 2 || !"-itemtype".startsWith(parameter) && !"-type".startsWith(parameter)) continue;
    const value = colon < 0 ? argv[++index]?.toLowerCase() : argument.slice(colon + 1);
    if (value !== "file" && value !== "directory") return false;
  }
  return true;
}

/** Every option before `--` is a listed flag for this command (`-rf`, `--parents`). */
function hasKnownFileCommandOptions(name: string, argv: readonly string[]): boolean {
  const short = FILE_COMMAND_SHORT_OPTIONS[name]!, long = FILE_COMMAND_LONG_OPTIONS[name]!;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.charCodeAt(0) !== HYPHEN || argument.length === 1) continue;
    if (argument === "--") return true;
    if (argument.charCodeAt(1) === HYPHEN) { if (!long.has(argument)) return false; continue; }
    for (let cursor = 1; cursor < argument.length; cursor++) if (short.indexOf(argument[cursor]!) < 0) return false;
  }
  return true;
}

/** `>`/`>>` to one literal path, which the native analysis records as a write target. */
function isLiteralFileRedirection(table: ShellTokenTable, index: number, powerShell: boolean): boolean {
  const targetFlags = table.flags[index + 1]!;
  if (targetFlags & (WORD_REDIRECTION | EXPANSION_MASK) || powerShell && targetFlags & WORD_DECODE) return false;
  const operator = table.source.slice(table.starts[index]!, table.ends[index]!);
  return operator === ">" || operator === ">>";
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
  // `CI+=x` appends; the name ends before the `+`.
  const name = equals > 1 && text.charCodeAt(equals - 1) === 43 ? equals - 1 : equals;
  if (name <= 0) return false;
  for (let index = 0; index < name; index++) {
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
    if (argument === "-i" || argument === "--incremental" || argument.startsWith("--incremental=") || argument === "--tsBuildInfoFile"
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
    // Options apply in order: a later `--no-list` makes the operands branch names again.
    if (argument === "-l" || matchesLongOption(argument, "--list", "--li")) { list = true; continue; }
    if (matchesLongOption(argument, "--no-list", "--no-l")) { list = false; continue; }
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
