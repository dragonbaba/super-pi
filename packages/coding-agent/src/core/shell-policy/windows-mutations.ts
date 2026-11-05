import { basename, dirname, isAbsolute, resolve } from "node:path";
import { addShellEffect, MAX_SHELL_DEPTH, MAX_SHELL_SEGMENTS, MAX_SHELL_SOURCE_CHARS, type ShellMutationScan } from "./mutation-effects.ts";
import { inspectEmbeddedDeletion, inspectHighRiskBashMutation } from "./core.ts";
import { inspectBashPermissionScope, recordGit } from "./permission-bash.ts";
import { isBashCommandFlag, bashScriptOperandIndex } from "./shell-redirection.ts";
import { NODE_COMMAND_PATTERN, PYTHON_COMMAND_PATTERN } from "./regex.ts";
import type { ShellAnalysisOwner } from "./shell-analysis.ts";

const MAX_WORDS = 256;
const DELETE_COMMANDS = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const COPY_COMMANDS = new Set(["copy-item", "cpi", "copy", "cp"]);
const MOVE_COMMANDS = new Set(["move-item", "mi", "move", "mv", "rename-item", "rni", "ren", "rename"]);
const WRITE_COMMANDS = new Set(["set-content", "sc", "add-content", "ac", "out-file", "tee-object", "tee"]);
const LOCATION_COMMANDS = new Set(["set-location", "sl", "cd", "chdir"]);
const BASH_WRAPPERS = new Set(["bash", "sh", "zsh", "dash"]);
const PATH_OPTIONS = new Set(["-path", "-literalpath", "-filepath"]);
const DESTINATION_OPTIONS = new Set(["-destination", "-newname"]);
const VALUE_OPTIONS = new Set(["-value", "-inputobject", "-encoding", "-filter", "-include", "-exclude", "-erroraction", "-warningaction"]);
const FLAG_OPTIONS = new Set(["-force", "-recurse", "-r", "-container", "-passthru", "-verbose", "-debug", "-append", "-nonewline"]);
const DOTNET_DELETE = /^\[(?:System\.)?IO\.(?:File|Directory)\]::Delete$/iu;
const WORD_SPACE = /\s/u;
const WILDCARD = /[*?\[]/u;
const CMD_EXPANSION = /[%!]/u;
const PS_PROVIDER = /^(?:[^:]+::|[^:/\\]{2,}:)/u;
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[/\\]|\\\\)/iu;
type WindowsShell = "powershell" | "cmd";

function commandName(value: string): string {
  const name = basename(value.replaceAll("\\", "/")).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}
function literalTarget(value: string | undefined, dynamic: boolean, cwd: string, shell: WindowsShell, literalPath = false): string | undefined {
  if (!value || dynamic || value.includes("\0") || !literalPath && WILDCARD.test(value)) return;
  if (shell === "cmd" ? CMD_EXPANSION.test(value) : PS_PROVIDER.test(value)) return;
  // A drive path is only meaningful on a Windows host; never reinterpret it as a POSIX relative filename.
  if (process.platform !== "win32" && WINDOWS_ABSOLUTE.test(value)) return;
  if (!cwd && !isAbsolute(value)) return;
  return resolve(cwd, value);
}

/** One tokenizer per source, primitive quote/escape state, no per-word callbacks or AST objects.
 * Backslash is a path character in both Windows grammars; PowerShell uses backtick and cmd uses caret.
 */
export function inspectWindowsMutations(command: string, initialCwd: string, shell: WindowsShell, scan: ShellMutationScan, depth = 0, owner?: ShellAnalysisOwner): void {
  if (depth > MAX_SHELL_DEPTH || command.length > MAX_SHELL_SOURCE_CHARS) { scan.recognized = true; scan.uncertain = true; return; }
  const tokens: string[] = [], dynamic: boolean[] = [];
  let cwd = initialCwd, value = "", started = false, expanded = false, quote = 0, segments = 0;
  for (let offset = 0; offset <= command.length; offset++) {
    const code = command.charCodeAt(offset), next = command.charCodeAt(offset + 1);
    if (offset < command.length) {
      if (code === (shell === "powershell" ? 96 : 94) && quote !== 39) {
        const escaped = command[++offset];
        if (escaped === undefined) { expanded = true; break; }
        if (escaped === "\r" && command.charCodeAt(offset + 1) === 10) offset++;
        else if (escaped !== "\r" && escaped !== "\n") { value += escaped; started = true; }
        continue;
      }
      if (quote) {
        if (code === quote) {
          if (shell === "powershell" && next === quote) { value += command[++offset]; started = true; }
          else quote = 0;
        } else {
          if (shell === "powershell" && quote === 34 && code === 36) expanded = true;
          if (shell === "cmd" && (code === 37 || code === 33)) expanded = true;
          value += command[offset]; started = true;
        }
        continue;
      }
      if (code === 34 || shell === "powershell" && code === 39) { quote = code; started = true; continue; }
      if (shell === "powershell" && code === 35 && !started) {
        while (offset + 1 < command.length && command.charCodeAt(offset + 1) !== 10) offset++;
        continue;
      }
      if (shell === "powershell" && (code === 36 || code === 43 || code === 64 && next === 40)) expanded = true;
      if (shell === "cmd" && (code === 37 || code === 33)) expanded = true;
    }
    const blockBoundary = shell === "powershell" && (code === 123 || code === 125);
    if (blockBoundary) scan.uncertain = true;
    const end = offset === command.length || code === 10 || code === 13 || code === 38 || code === 124 || blockBoundary || shell === "powershell" && code === 59;
    const punctuation = code === 62 || code === 60 || shell === "powershell" && (code === 40 || code === 41 || code === 44);
    if (end || punctuation || code === 32 || code === 9) {
      if (started) { tokens.push(value); dynamic.push(expanded); value = ""; expanded = false; started = false; }
      if (tokens.length >= MAX_WORDS) { scan.recognized = true; scan.uncertain = true; return; }
      if (punctuation) {
        const streamCopy = (code === 62 || code === 60) && next === 38;
        tokens.push(streamCopy ? code === 62 ? ">&" : "<&" : code === 62 && next === 62 ? ">>" : command[offset]!);
        dynamic.push(code === 40 || code === 41);
        if (streamCopy || code === 62 && next === 62) offset++;
      }
      if (end && tokens.length) {
        if (++segments > MAX_SHELL_SEGMENTS) { scan.recognized = true; scan.uncertain = true; return; }
        cwd = inspectSegment(tokens, dynamic, 0, cwd, shell, scan, depth, owner);
        tokens.length = 0; dynamic.length = 0;
      }
    } else { value += command[offset]; started = true; }
  }
  if (quote || expanded) scan.uncertain = true;
}

export function inspectWindowsArguments(tokens: readonly string[], expansions: readonly number[] | undefined, start: number, cwd: string, shell: WindowsShell, scan: ShellMutationScan, depth: number, owner?: ShellAnalysisOwner): void {
  inspectSegment(tokens, expansions, start, cwd, shell, scan, depth, owner);
}

function inspectSegment(tokens: readonly string[], dynamic: readonly (boolean | number)[] | undefined, start: number, cwd: string, shell: WindowsShell, scan: ShellMutationScan, depth: number, owner?: ShellAnalysisOwner): string {
  if (depth > MAX_SHELL_DEPTH) { scan.recognized = true; scan.uncertain = true; return cwd; }
  const name = commandName(tokens[start]!);
  if (name === "rem" || name === "::") return cwd;
  if (name === "pushd" || name === "popd" || name === "push-location" || name === "pop-location") return "";
  // .NET calls can occur on the right side of an assignment or inside a pipeline expression.
  for (let index = start; index < tokens.length; index++) {
    if (DOTNET_DELETE.test(tokens[index]!)) {
      const literal = tokens[index + 1] === "(" && (tokens[index + 3] === ")" || tokens[index + 3] === ",");
      addShellEffect(scan, "delete", literal ? literalTarget(tokens[index + 2], Boolean(dynamic?.[index + 2]), cwd, shell, true) : undefined);
    }
    if (tokens[index] === ">" || tokens[index] === ">>") {
      const operand = tokens[index + 1];
      if (operand?.toLowerCase() !== "nul" && !(process.platform !== "win32" && operand === "/dev/null") && !(operand === "$null" && dynamic?.[index + 1]))
        addShellEffect(scan, "write", literalTarget(operand, Boolean(dynamic?.[index + 1]), cwd, shell, true));
    }
  }
  if (name === "git") { recordGit(tokens, start + 1, cwd, scan, dynamic); return cwd; }
  if (name === "cmd" || name === "powershell" || name === "pwsh" || BASH_WRAPPERS.has(name)) {
    for (let index = start + 1; index < tokens.length; index++) {
      const flag = tokens[index]!.toLowerCase();
      if (BASH_WRAPPERS.has(name) ? !isBashCommandFlag(flag) : flag !== "/c" && flag !== "-c" && flag !== "-command") continue;
      const bodyIndex = BASH_WRAPPERS.has(name) ? bashScriptOperandIndex(tokens, index) : index + 1;
      const body = tokens[bodyIndex];
      if (!body || dynamic?.[bodyIndex]) { scan.uncertain = true; return cwd; }
      if (BASH_WRAPPERS.has(name)) {
        const input = { command: body };
        const scope = inspectBashPermissionScope(input, cwd, owner, scan, depth + 1);
        const high = inspectHighRiskBashMutation(input, cwd, "bash", owner, depth + 1, scan);
        if (scope?.unverifiableMutation || high?.unverifiableScope) scan.uncertain = true;
        return cwd;
      }
      const nested = name === "cmd" ? "cmd" : "powershell";
      if (index + 2 === tokens.length) inspectWindowsMutations(body, cwd, nested, scan, depth + 1, owner);
      else if (!WORD_SPACE.test(body)) inspectSegment(tokens, dynamic, index + 1, cwd, nested, scan, depth + 1, owner);
      else scan.uncertain = true;
      return cwd;
    }
    return cwd; // -File and other opaque programs retain their existing permission behavior.
  }
  if (NODE_COMMAND_PATTERN.test(name) || PYTHON_COMMAND_PATTERN.test(name)) {
    const language = NODE_COMMAND_PATTERN.test(name) ? "node" : "python";
    for (let index = start + 1; index < tokens.length; index++) {
      if (language === "node" ? tokens[index] !== "-e" && tokens[index] !== "--eval" : tokens[index] !== "-c") continue;
      const source = tokens[index + 1]; if (source === undefined) return cwd;
      const high = inspectEmbeddedDeletion(source, language, cwd, scan);
      if (high?.mutationDetected) {
        scan.recognized = true;
        if (high.unverifiableScope || dynamic?.[index + 1]) scan.uncertain = true;
      }
      return cwd;
    }
    return cwd;
  }
  const deleting = DELETE_COMMANDS.has(name), copying = COPY_COMMANDS.has(name), moving = MOVE_COMMANDS.has(name), writing = WRITE_COMMANDS.has(name);
  const locating = LOCATION_COMMANDS.has(name), robocopy = name === "robocopy";
  if (!deleting && !copying && !moving && !writing && !locating && !robocopy) return cwd;
  const operands: number[] = [];
  let explicitPath = -1, destination = -1, literalPath = false, mirror = false, unknownOptions = false;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index]!, lower = token.toLowerCase();
    if (lower === "-whatif" || lower === "-whatif:$true") return cwd;
    if (robocopy && lower === "/l") return cwd;
    if (token === ">" || token === ">>" || token === "<") { index++; continue; }
    if ((tokens[index + 1] === ">" || tokens[index + 1] === ">>") && token.length === 1 && token >= "0" && token <= "9") continue;
    if (PATH_OPTIONS.has(lower)) { explicitPath = ++index; literalPath = lower === "-literalpath"; continue; }
    if (DESTINATION_OPTIONS.has(lower)) { destination = ++index; continue; }
    if (VALUE_OPTIONS.has(lower)) { index++; continue; }
    if (FLAG_OPTIONS.has(lower) || lower === "-confirm:$false" || lower === "-whatif:$false") continue;
    if (robocopy && (lower === "/mir" || lower === "/purge")) { mirror = true; continue; }
    if (shell === "cmd" && token.startsWith("/") || robocopy && token.startsWith("/")) continue;
    if (token.startsWith("-")) { unknownOptions = true; continue; }
    if (token !== ",") operands.push(index);
  }
  const first = explicitPath >= 0 ? explicitPath : operands[0] ?? -1;
  if (locating) {
    const target = literalTarget(tokens[first], Boolean(dynamic?.[first]), cwd, shell, literalPath);
    return target ?? "";
  }
  scan.recognized = true;
  if (unknownOptions) scan.uncertain = true;
  if (robocopy) {
    if (mirror) addShellEffect(scan, "delete-contents", literalTarget(tokens[operands[1] ?? -1], Boolean(dynamic?.[operands[1] ?? -1]), cwd, shell));
    return cwd;
  }
  if (copying || moving) {
    const last = destination >= 0 ? destination : operands.at(-1) ?? -1;
    const target = literalTarget(tokens[last], Boolean(dynamic?.[last]), cwd, shell, true);
    const renaming = name === "rename-item" || name === "rni" || name === "ren" || name === "rename";
    if (first === last) { scan.uncertain = true; return cwd; }
    for (let slot = explicitPath >= 0 ? -1 : 0; slot < operands.length; slot++) {
      const index = slot < 0 ? explicitPath : operands[slot]!;
      if (index === last) continue;
      const source = literalTarget(tokens[index], Boolean(dynamic?.[index]), cwd, shell, literalPath);
      addShellEffect(scan, moving ? "move" : "copy", source, source && target && renaming ? resolve(dirname(source), tokens[last]!) : target);
    }
  } else if (writing) {
    addShellEffect(scan, "write", literalTarget(tokens[first], Boolean(dynamic?.[first]), cwd, shell, literalPath));
    // Content cmdlets accept a comma-separated path array. Positional values
    // after the path are data, so walk only the contiguous path expression.
    for (let index = first + 1; tokens[index] === ","; index += 2)
      addShellEffect(scan, "write", literalTarget(tokens[index + 1], Boolean(dynamic?.[index + 1]), cwd, shell, literalPath));
  } else if (explicitPath >= 0) {
    addShellEffect(scan, "delete", literalTarget(tokens[first], Boolean(dynamic?.[first]), cwd, shell, literalPath));
    for (const index of operands) addShellEffect(scan, "delete", literalTarget(tokens[index], Boolean(dynamic?.[index]), cwd, shell, literalPath));
  } else {
    if (!operands.length) addShellEffect(scan, "delete", undefined);
    for (const index of operands) addShellEffect(scan, "delete", literalTarget(tokens[index], Boolean(dynamic?.[index]), cwd, shell, literalPath));
  }
  return cwd;
}
