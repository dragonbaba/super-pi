import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { staticMutationTarget, uninspectableBashStateStart, heredocScriptLanguages, literalAliasSource, literalEvalScript, literalProcessSources, literalStoredScripts, unsafeBashLoopHeaderReason } from "./core.ts";
import { analyzeShellSource, type ShellAnalysisOwner } from "./shell-analysis.ts";
import { parseTimeoutInvocation } from "./timeout-wrapper.ts";
import { isLiteralReadLoop } from "./readonly-loop.ts";
import { isReadOnlyFindLoop } from "./readonly-find-loop.ts";
import { findPredicateHasOperand, isReadOnlySortTail } from "./readonly-find.ts";
import { isReadOnlyGitAt, powerShellLocationTarget, type ReadOnlyShellSubcommands } from "./readonly-command.ts";
import { sortHasTerminalOption, sortLongOption, sortOptionRequiresValue } from "./sort-options.ts";
import { NODE_COMMAND_PATTERN, PYTHON_COMMAND_PATTERN } from "./regex.ts";
import { DIALECT_CMD, DIALECT_POWERSHELL, fillWindowsSegment, lexWindowsScript } from "./syntax/windows.ts";
import { fillBashSegment, lexBash } from "./syntax/bash.ts";
import { bashPipelinePrefixEnd, bashScriptOperandIndex, hasStatefulBashPrintf, isBashArithmeticCommandHead, isBashNetworkRedirectionTarget, shellExpansionRisk, hasUnsafeBashTestOperand, hasUnsafeCommandQueryOperand, isShellDynamicDescriptor, isShellOutputFileRedirection, isStaticDescriptorCopy, stripShellRedirections } from "./shell-redirection.ts";

const MAX_COMMAND_CHARS = 128 * 1024;
const MAX_SEGMENTS = 64;
const MAX_TARGETS = 16;
const MAX_DEPTH = 4;
const READ_ONLY_COMMANDS = new Set([
  "cat", "dir", "echo", "file", "grep", "head", "ls", "printf", "pwd", "readlink", "realpath", "rg", "stat", "tail", "tr", "type", "wc", "where", "which",
]);
const SCRIPT_WRAPPERS = new Set(["bash", "bash.exe", "sh", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const OPAQUE_RUNNERS = new Set([
  "bun", "bun.exe", "deno", "deno.exe", "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
]);
const SIMPLE_DELETIONS = new Set(["del", "erase", "rm", "rmdir", "rd"]);
const SIMPLE_MUTATIONS = new Set([...SIMPLE_DELETIONS, "mkdir", "md", "touch"]);
const COPY_COMMANDS = new Set(["cp", "copy"]);
const MOVE_COMMANDS = new Set(["mv", "move", "rename", "ren"]);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse"]);
/** No user-configured read-only git subcommands: only the built-in judgment applies to mutation targets. */
const NO_CONFIGURED_SUBCOMMANDS: ReadOnlyShellSubcommands = Object.freeze({});
/** git's global options that take no value; `-C <dir>` and `-c <name=value>` are read separately. */
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "-P", "--paginate", "-p", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
/** rsync options whose value is the next word when written without `=`. */
const RSYNC_VALUE_OPTIONS = new Set(["--exclude", "--include", "--filter", "--exclude-from", "--include-from", "--files-from", "--rsh",
  "--rsync-path", "--log-file", "--temp-dir", "--backup-dir", "--partial-dir", "--compare-dest", "--copy-dest", "--link-dest", "--chmod",
  "--chown", "--password-file", "--suffix", "--timeout", "--bwlimit", "--max-size", "--min-size", "--port", "--out-format", "--usermap",
  "--groupmap", "--modify-window", "--contimeout", "--iconv", "--remote-option", "--max-delete", "--max-alloc", "--block-size", "--checksum-choice",
  "--compress-choice", "--compress-level", "--skip-compress", "--info", "--debug", "--stop-after", "--stop-at", "--outbuf", "--sockopts", "--address",
  "--protocol", "--checksum-seed", "--write-batch", "--only-write-batch", "--read-batch", "--copy-as"]);
/** Short rsync options that take the next word when they end their cluster (`-e ssh`, `-avf 'merge x'`). */
const RSYNC_SHORT_VALUE_OPTIONS = "efTBM";
// Native authorization only: PowerShell file cmdlets, after Claude Code's PowerShell
// scope checks. Kind codes keep the table allocation-free; ALIAS entries apply only to
// the PowerShell tool because Bash may have an unrelated program of that name.
const CMDLET_DELETE = 1, CMDLET_WRITE = 2, CMDLET_COPY = 3, CMDLET_MOVE = 4, CMDLET_KIND = 7, CMDLET_ALIAS = 8, CMDLET_NAME = 16, CMDLET_RENAME = 32;
// Per-word flags from the tokenizer: only unquoted commas separate list items, and a
// word that begins with a quote is data, never a PowerShell parameter.
const TOKEN_QUOTED_COMMA = 1, TOKEN_UNQUOTED_COMMA = 2, TOKEN_QUOTED = 4, TOKEN_COMMAS = 3;
const POWERSHELL_FILE_CMDLETS = new Map<string, number>([
  ["remove-item", CMDLET_DELETE], ["ri", CMDLET_DELETE | CMDLET_ALIAS],
  ["set-content", CMDLET_WRITE], ["add-content", CMDLET_WRITE], ["ac", CMDLET_WRITE | CMDLET_ALIAS],
  ["clear-content", CMDLET_WRITE], ["clc", CMDLET_WRITE | CMDLET_ALIAS], ["out-file", CMDLET_WRITE],
  ["tee-object", CMDLET_WRITE], ["new-item", CMDLET_WRITE | CMDLET_NAME], ["ni", CMDLET_WRITE | CMDLET_NAME | CMDLET_ALIAS],
  ["copy-item", CMDLET_COPY], ["cpi", CMDLET_COPY | CMDLET_ALIAS],
  ["move-item", CMDLET_MOVE], ["mi", CMDLET_MOVE | CMDLET_ALIAS], ["rename-item", CMDLET_MOVE | CMDLET_RENAME], ["rni", CMDLET_MOVE | CMDLET_RENAME | CMDLET_ALIAS],
]);
const POWERSHELL_PATH_PARAMETERS = new Set(["-path", "-literalpath", "-lp", "-pspath", "-filepath"]);
// Full names for prefix matching (`-Dest`, `-Lit`); switches are matched exactly first.
const POWERSHELL_PATH_NAMES: readonly string[] = Object.freeze(["-path", "-literalpath", "-pspath", "-filepath"]);
const POWERSHELL_DESTINATION_NAME = "-destination", POWERSHELL_NEW_NAME = "-newname";
const POWERSHELL_SWITCH_PARAMETERS = new Set([
  "-recurse", "-r", "-force", "-fo", "-nonewline", "-append", "-passthru", "-whatif", "-confirm", "-noclobber", "-container", "-verbose", "-debug", "-asbytestream",
]);

export type BashPermissionKind = "read-only" | "known-mutation" | "opaque-script";

export interface BashPermissionScope {
  kind: BashPermissionKind;
  targets: string[];
  /** Actual operands of already-recognized delete/move commands, excluding opaque cwd. */
  destructiveTargets?: string[];
  moveDestinations?: string[];
  primitives: string[];
  classes: string[];
  dynamicScope: boolean;
  unverifiableScope: boolean;
  /** Distinguishes recognized mutations from synthesized opaque execution scope. */
  mutationDetected?: boolean;
  /** A recognized write/delete exists but its target or shell context is unknown. */
  unverifiableMutation?: boolean;
}

interface ScopeBuilder extends BashPermissionScope {
  segmentCount: number;
  analysisOwner?: ShellAnalysisOwner;
  mutationDetected: boolean;
  uncertainContext: boolean;
  unverifiableMutation: boolean;
  /** Inside a native `cmd /c` script, where `/x` words are options rather than paths. */
  cmdOptions: boolean;
  /** Interpreter of the script being read: 1 = PowerShell, 2 = another shell, 0 = the native tool's own. */
  nestedShell: number;
}

function commandName(value: string): string {
  return basename(value.replaceAll("\\", "/")).toLowerCase();
}

function hasDynamicSyntax(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 36 || code === 37 || code === 42 || code === 63 || code === 91 || code === 93 || code === 123 || code === 125 || code === 126) return true;
  }
  return false;
}

function addPrimitive(builder: ScopeBuilder, primitive: string): void {
  for (const current of builder.primitives) if (current === primitive) return;
  if (builder.primitives.length < MAX_TARGETS) builder.primitives.push(primitive);
  else {
    builder.kind = "opaque-script";
    builder.unverifiableScope = true;
  }
}

function addClass(builder: ScopeBuilder, value: string): void {
  for (const current of builder.classes) if (current === value) return;
  if (builder.classes.length < MAX_TARGETS) builder.classes.push(value);
  else {
    builder.kind = "opaque-script";
    builder.unverifiableScope = true;
  }
}

function addTarget(builder: ScopeBuilder, value: string, cwd: string, mutation = false, expansion = 0, destructive = false, nativeKind?: "move" | "contents"): string | undefined {
  const target = staticMutationTarget(value, cwd, expansion);
  if (mutation) builder.analysisOwner?.observeMutationTarget(value, cwd, expansion, target, nativeKind ?? (destructive ? "delete" : "write"));
  if (target === undefined) {
    builder.dynamicScope = true;
    if (mutation) builder.unverifiableMutation = true;
    markOpaque(builder, "dynamic_target");
    return;
  }
  addResolvedTarget(builder, target);
  if (destructive) addDestructiveTarget(builder, target);
  return target;
}

function addDestructiveTarget(builder: ScopeBuilder, target: string): void {
  const targets = builder.destructiveTargets ??= [];
  if (targets.length < MAX_TARGETS && !targets.includes(target)) targets.push(target);
}

/** Only classifier-synthesized paths bypass operand expansion checks. */
function addResolvedTarget(builder: ScopeBuilder, target: string): void {
  for (const current of builder.targets) if (current === target) return;
  if (builder.targets.length >= MAX_TARGETS) {
    if (builder.mutationDetected) builder.unverifiableMutation = true;
    markOpaque(builder, "too_many_targets");
    return;
  }
  builder.targets.push(target);
}

function markMutation(builder: ScopeBuilder, primitive: string): void {
  builder.mutationDetected = true;
  if (builder.uncertainContext || builder.dynamicScope) builder.unverifiableMutation = true;
  if (builder.kind === "read-only") builder.kind = "known-mutation";
  addPrimitive(builder, primitive);
  addClass(builder, `mutation:${primitive}`);
}

function markOpaque(builder: ScopeBuilder, primitive: string): void {
  builder.kind = "opaque-script";
  builder.unverifiableScope = true;
  addPrimitive(builder, primitive);
  addClass(builder, `opaque:${primitive}`);
}

function markUncertainContext(builder: ScopeBuilder, primitive: string): void {
  builder.uncertainContext = true;
  markOpaque(builder, primitive);
}

function addPositionalTargets(
  tokens: PermissionTokens,
  start: number,
  builder: ScopeBuilder,
  cwd: string,
  skip: number,
  lastOnly: boolean,
  destructive: boolean | "move" = false,
): number {
  let optionsEnded = false;
  let count = 0;
  let last = -1;
  let moveTarget: string | undefined;
  let unknownMoveOptions = false;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && builder.cmdOptions && isCmdOption(token)) continue; // e.g. move /y keeps operand roles.
    if (!optionsEnded && token.startsWith("-")) {
      if (destructive === "move") {
        unknownMoveOptions = true; builder.unverifiableMutation = true;
        markOpaque(builder, "unverifiable_move_options");
      }
      continue;
    }
    count += 1;
    if (lastOnly) last = index;
    else if (count > skip) {
      if (destructive === "move" && !unknownMoveOptions && moveTarget !== undefined) addDestructiveTarget(builder, moveTarget);
      moveTarget = addTarget(builder, token, cwd, true, tokens.expansions?.[index], destructive === true, destructive === "move" ? "move" : undefined);
    }
  }
  if (lastOnly && last >= 0 && count > skip) addTarget(builder, tokens[last]!, cwd, true, tokens.expansions?.[last], destructive === true);
  if (destructive === "move" && !unknownMoveOptions && moveTarget !== undefined) {
    const targets = builder.moveDestinations ??= [];
    if (targets.length < MAX_TARGETS && !targets.includes(moveTarget)) targets.push(moveTarget);
  }
  if (count === 0) markOpaque(builder, "missing_static_target");
  return count;
}

/**
 * `rsync [options] source… destination`: a local destination is written, and with `--delete*`
 * files there are deleted. A remote destination (`host:path`, `host::module`, `rsync://`) or a
 * single operand (a listing) is left to the unknown-command handling. A dry run (`-n`,
 * `--dry-run`, `--list-only`) changes nothing.
 */
function inspectRsync(tokens: PermissionTokens, start: number, cwd: string, builder: ScopeBuilder): boolean {
  let destination = -1, operands = 0, deletes = false, dryRun = false;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--") { operands += tokens.length - index - 1; if (index + 1 < tokens.length) destination = tokens.length - 1; break; }
    if (token.startsWith("--")) {
      if (token.startsWith("--delete") || token === "--del") deletes = true;
      else if (token === "--dry-run" || token === "--list-only") dryRun = true;
      else if (RSYNC_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    if (token.length > 1 && token.charCodeAt(0) === 45) {
      // `-avn`: letters up to the first value option; that option takes the rest or, at the end, the next word.
      for (let letter = 1; letter < token.length; letter++) {
        const code = token.charCodeAt(letter);
        if (code === 110) dryRun = true; // `n`
        else if (RSYNC_SHORT_VALUE_OPTIONS.includes(token[letter]!)) { if (letter === token.length - 1) index++; break; }
      }
      continue;
    }
    operands++; destination = index;
  }
  if (dryRun) return true;
  if (operands < 2 || isRemoteRsyncOperand(tokens[destination]!)) return false;
  markMutation(builder, deletes ? "rsync_delete" : "rsync");
  // `--delete` removes extraneous files inside the destination, not the directory itself (like `find -delete`).
  addTarget(builder, tokens[destination]!, cwd, true, tokens.expansions?.[destination], false, deletes ? "contents" : undefined);
  return true;
}

function isRemoteRsyncOperand(value: string): boolean {
  if (value.startsWith("rsync://")) return true;
  const colon = value.indexOf(":");
  let slash = value.indexOf("/");
  const backslash = value.indexOf("\\");
  if (backslash >= 0 && (slash < 0 || backslash < slash)) slash = backslash;
  // `C:\dist` and `C:/dist` are local drive paths; `host:dist` and `user@host:/srv` are remote.
  return colon > 1 && (slash < 0 || colon < slash);
}

/**
 * `tar -xf a.tar [-C dir]` / `tar xf a.tar`: extraction writes into `-C`'s directory, else the cwd.
 * Successive `-C` options chain (`-C /tmp/out -C nested`); `-O`/`--to-stdout` writes no files.
 */
function inspectTarExtract(tokens: PermissionTokens, start: number, cwd: string, builder: ScopeBuilder): boolean {
  let extract = false, stdout = false, directory = "", expansion = 0, missing = false;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    let value: string | undefined, at = index;
    if (token === "--extract" || token === "--get") extract = true;
    else if (token === "--to-stdout") stdout = true;
    else if (token === "-C" || token === "--directory") { at = ++index; value = tokens[index]; if (value === undefined) missing = true; }
    else if (token.startsWith("--directory=")) value = token.slice(12);
    else if (token.length > 2 && token.charCodeAt(0) === 45 && token.charCodeAt(1) === 67) value = token.slice(2); // `-C../out`
    else if (!token.startsWith("--") && (token.charCodeAt(0) === 45 || index === start)) {
      if (token.includes("x")) extract = true;
      if (token.includes("O")) stdout = true;
    }
    if (value !== undefined) {
      if (!value) missing = true;
      directory = !directory || isAbsolute(value) ? value : directory + "/" + value;
      expansion |= tokens.expansions?.[at] ?? 0;
    }
  }
  if (!extract) return false;
  if (stdout) return true;
  markMutation(builder, "tar_extract");
  if (missing) { builder.dynamicScope = true; builder.unverifiableMutation = true; markOpaque(builder, "missing_output_target"); }
  else addTarget(builder, directory || ".", cwd, true, expansion);
  return true;
}

function inspectKnownMutation(command: string, tokens: PermissionTokens, start: number, cwd: string, builder: ScopeBuilder): boolean {
  if (command === "find") {
    const root = findSearchRootIndex(tokens, start);
    for (let index = start; index < tokens.length; index++) {
      if (!tokens.expansions?.[index] && (tokens[index] === "--help" || tokens[index] === "--version")) return true;
      if (findPredicateHasOperand(tokens[index]!)) { index++; continue; }
      if (tokens[index] === "-fprint" || tokens[index] === "-fprint0" || tokens[index] === "-fprintf" || tokens[index] === "-fls") {
        markMutation(builder, "find_output");
        const target = tokens[++index];
        if (target) addTarget(builder, target, cwd, true, tokens.expansions?.[index]);
        else { builder.dynamicScope = true; builder.unverifiableMutation = true; markOpaque(builder, "missing_output_target"); }
        if (tokens[index - 1] === "-fprintf") index++;
        continue;
      }
      if (tokens[index] === "-delete" || tokens[index] === "-exec" || tokens[index] === "-execdir") {
        markMutation(builder, tokens[index] === "-delete" ? "find_delete" : "find_exec");
        if (root < 0) addResolvedTarget(builder, cwd);
        else addTarget(builder, tokens[root]!, cwd, true, tokens.expansions?.[root], false, "contents");
        if (tokens[index] !== "-delete") { markOpaque(builder, "find_exec_scope"); return true; }
        continue;
      }
    }
    return true;
  }
  if (command === "sort") {
    if (sortHasTerminalOption(tokens, start)) return true;
    let output = false;
    let inertLongOption = false;
    for (let index = start; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token === "--") { inertLongOption = true; break; }
      let target: string | undefined;
      let temporary = false;
      if (token.startsWith("--")) {
        const equals = token.indexOf("="), name = sortLongOption(token, equals < 0 ? token.length : equals);
        if (name === undefined) { markOpaque(builder, "sort_unknown_option"); continue; }
        if (name === "") { inertLongOption = true; continue; }
        if (name === "help" || name === "version") return true;
        if (name === "compress-program") markOpaque(builder, "sort_compress_program");
        const value = equals >= 0 ? token.slice(equals + 1) : sortOptionRequiresValue(name) ? tokens[++index] : undefined;
        if (name !== "output" && name !== "temporary-directory") continue;
        temporary = name === "temporary-directory"; target = value;
      }
      else if (token === "-o") target = tokens[++index];
      else if (token === "-T") { temporary = true; target = tokens[++index]; }
      else if (token.startsWith("-") && !token.startsWith("--")) {
        let outputFlag = -1;
        for (let flag = 1; flag < token.length; flag++) {
          if (token[flag] === "o") { outputFlag = flag; break; }
          if (token[flag] === "T") { outputFlag = flag; temporary = true; break; }
          // These options consume the remainder as an operand, not more flags.
          if (token[flag] === "k" || token[flag] === "t" || token[flag] === "S") { if (flag + 1 === token.length) index++; break; }
        }
        if (outputFlag < 0) continue;
        target = outputFlag + 1 < token.length ? token.slice(outputFlag + 1) : tokens[++index];
      } else continue;
      output = true;
      markMutation(builder, temporary ? "sort_temporary_directory" : "sort_output");
      // The value may share an option word or occupy the following word. Keep
      // its expansion flags: quoted/escaped backticks are literal path bytes.
      if (target) addTarget(builder, target, cwd, true, tokens.expansions?.[index]);
      else { builder.dynamicScope = true; builder.unverifiableMutation = true; markOpaque(builder, "missing_output_target"); }
    }
    return output || inertLongOption;
  }
  if (command === "rsync") return inspectRsync(tokens, start, cwd, builder);
  if (command === "tar" || command === "bsdtar") return inspectTarExtract(tokens, start, cwd, builder);
  if (SIMPLE_MUTATIONS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, false, SIMPLE_DELETIONS.has(command));
    return true;
  }
  if (COPY_COMMANDS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, true);
    return true;
  }
  if (MOVE_COMMANDS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, false, command === "mv" || command === "move" ? "move" : true);
    return true;
  }
  if (command === "tee") {
    markMutation(builder, "tee");
    addPositionalTargets(tokens, start, builder, cwd, 0, false);
    return true;
  }
  if (command === "sed") {
    let inPlace = false;
    for (let index = start; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token === "-i" || token.startsWith("-i")) inPlace = true;
    }
    if (!inPlace) return false;
    markMutation(builder, "sed_in_place");
    if (addPositionalTargets(tokens, start, builder, cwd, 1, false) < 2) markOpaque(builder, "sed_target_unverifiable");
    return true;
  }
  return false;
}

/**
 * PowerShell binds every named parameter first, then fills the unbound Path and
 * Destination from positional words in order. An unknown named parameter is assumed to
 * take a value; if that leaves no Path, the mutation stays unverifiable and asks instead
 * of passing as read-only. A value is a comma list that may continue across words
 * (`a.txt, b.txt`). New-Item creates `-Name` relative to Path (or the cwd). A copy or move
 * into an existing directory writes `<Destination>/<source name>`, so that target is added
 * too. Rename-Item's NewName (positional or `-NewName`) is a sibling of its source. A
 * literal `-WhatIf` means the cmdlet is not run, so it records no mutation. Bound values
 * are kept as token (index, offset, end) triples, so binding allocates nothing.
 */
function inspectPowerShellFileCmdlet(command: string, kind: number, tokens: PermissionTokens, start: number, cwd: string, builder: ScopeBuilder): void {
  const takesName = (kind & CMDLET_NAME) !== 0, rename = (kind & CMDLET_RENAME) !== 0;
  kind &= CMDLET_KIND;
  let pathIndex = -1, pathOffset = 0, pathEnd = -1, destinationIndex = -1, destinationOffset = 0, destinationEnd = -1;
  let nameIndex = -1, nameOffset = 0, noFile = false, whatIf = false;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!isCmdletParameter(tokens, index)) continue;
    const colon = token.indexOf(":");
    const name = (colon < 0 ? token : token.slice(0, colon)).toLowerCase();
    if (colon < 0 && (name === "-whatif" || name === "-wi")) { whatIf = true; continue; }
    if (POWERSHELL_SWITCH_PARAMETERS.has(name)) continue;
    let valueIndex = index, offset = colon + 1;
    if (colon < 0) { valueIndex = ++index; offset = 0; }
    const end = index = cmdletListEnd(tokens, valueIndex);
    const role = cmdletParameterRole(name);
    if (role === 1) { pathIndex = valueIndex; pathOffset = offset; pathEnd = end; }
    else if (role === 2 || rename && name.length >= 5 && POWERSHELL_NEW_NAME.startsWith(name)) { destinationIndex = valueIndex; destinationOffset = offset; destinationEnd = end; }
    else if (takesName && name === "-name") { nameIndex = valueIndex; nameOffset = offset; }
    else if (name === "-variable") noFile = true; // Tee-Object -Variable writes no file.
  }
  if (whatIf) return;
  markMutation(builder, command);
  const positionalDestination = kind === CMDLET_COPY || kind === CMDLET_MOVE;
  for (let index = start; index < tokens.length && (pathIndex < 0 || positionalDestination && destinationIndex < 0); index++) {
    const token = tokens[index]!;
    if (isCmdletParameter(tokens, index)) {
      if (token.indexOf(":") < 0 && !POWERSHELL_SWITCH_PARAMETERS.has(token.toLowerCase())) index = cmdletListEnd(tokens, index + 1);
      continue;
    }
    if (pathIndex < 0) { pathIndex = index; pathEnd = index = cmdletListEnd(tokens, index); }
    else { destinationIndex = index; destinationEnd = index = cmdletListEnd(tokens, index); }
  }
  const childName = nameIndex < 0 ? undefined : cmdletValue(tokens, nameIndex, nameOffset);
  const childExpansion = nameIndex < 0 ? 0 : tokens.expansions?.[nameIndex] ?? 0;
  if (childName === "") markUnverifiableCmdletTarget(builder);
  // Destination is one path; a list there is left to the per-word checks below.
  const into = positionalDestination && !rename && destinationIndex >= 0 && destinationEnd === destinationIndex
    && ((tokens.wordFlags?.[destinationIndex] ?? 0) & TOKEN_UNQUOTED_COMMA) === 0 ? cmdletValue(tokens, destinationIndex, destinationOffset) : undefined;
  if (pathIndex >= 0) {
    // A copy only reads its source.
    if (kind !== CMDLET_COPY) addCmdletList(builder, tokens, pathIndex, pathOffset, pathEnd, cwd, childExpansion, kind === CMDLET_DELETE || kind === CMDLET_MOVE, childName, undefined);
    if (into) addCmdletList(builder, tokens, pathIndex, pathOffset, pathEnd, cwd, tokens.expansions?.[destinationIndex] ?? 0, false, undefined, into);
  } else if (childName) addTarget(builder, childName, cwd, true, childExpansion);
  else if (!noFile && kind !== CMDLET_COPY) markUnverifiableCmdletTarget(builder);
  if (destinationIndex >= 0) {
    const parent = rename && pathIndex >= 0 && pathEnd === pathIndex ? dirname(cmdletValue(tokens, pathIndex, pathOffset) || ".") : undefined;
    addCmdletList(builder, tokens, destinationIndex, destinationOffset, destinationEnd, cwd, parent === undefined ? 0 : tokens.expansions?.[pathIndex] ?? 0, false, undefined, parent);
  } else if (positionalDestination) markUnverifiableCmdletTarget(builder); // Where the copy or move writes is unknown.
}

/** 1 = Path, 2 = Destination, 0 = other. PowerShell accepts any unambiguous prefix of a parameter name. */
function cmdletParameterRole(name: string): number {
  if (POWERSHELL_PATH_PARAMETERS.has(name)) return 1;
  if (name === "-destination") return 2;
  if (name.length < 3) return 0;
  if (POWERSHELL_DESTINATION_NAME.startsWith(name)) return 2;
  for (let index = 0; index < POWERSHELL_PATH_NAMES.length; index++) if (POWERSHELL_PATH_NAMES[index]!.startsWith(name)) return 1;
  return 0;
}

/** The last word of a comma list starting at `index`: a word ending, or the next word starting, with an unquoted comma continues it. */
function cmdletListEnd(tokens: PermissionTokens, index: number): number {
  const flags = tokens.wordFlags;
  if (!flags) return index;
  while (index + 1 < tokens.length) {
    const token = tokens[index]!, next = tokens[index + 1]!;
    const trailing = ((flags[index] ?? 0) & TOKEN_UNQUOTED_COMMA) !== 0 && token.charCodeAt(token.length - 1) === 44;
    const leading = ((flags[index + 1] ?? 0) & TOKEN_UNQUOTED_COMMA) !== 0 && next.charCodeAt(0) === 44;
    if (!trailing && !leading) break;
    index++;
  }
  return index;
}

function addCmdletList(builder: ScopeBuilder, tokens: PermissionTokens, index: number, offset: number, end: number, cwd: string, extraExpansion: number, destructive: boolean, child: string | undefined, into: string | undefined): void {
  const first = cmdletValue(tokens, index, offset);
  if (!first) { markUnverifiableCmdletTarget(builder); return; }
  for (let word = index; word <= end; word++) {
    addCmdletOperands(builder, word === index ? first : tokens[word]!, cwd, (tokens.expansions?.[word] ?? 0) | extraExpansion, destructive, (tokens.wordFlags?.[word] ?? 0) & TOKEN_COMMAS, child, into);
  }
}

/** `-Name` written unquoted; a quoted `'-WhatIf'` is a string argument. */
function isCmdletParameter(tokens: PermissionTokens, index: number): boolean {
  const token = tokens[index]!;
  return token.length > 1 && token.charCodeAt(0) === 45 && ((tokens.wordFlags?.[index] ?? 0) & TOKEN_QUOTED) === 0;
}

function cmdletValue(tokens: PermissionTokens, index: number, offset: number): string | undefined {
  const token = tokens[index];
  return token === undefined || offset === 0 ? token : token.slice(offset);
}

function markUnverifiableCmdletTarget(builder: ScopeBuilder): void {
  builder.dynamicScope = true;
  builder.unverifiableMutation = true;
  markOpaque(builder, "missing_static_target");
}

/**
 * A PowerShell path parameter takes a comma-separated list; each item is its own operand.
 * Only unquoted commas separate items. A word mixing quoted and unquoted commas is
 * unverifiable rather than guessed.
 */
function addCmdletOperands(builder: ScopeBuilder, value: string, cwd: string, expansion: number, destructive: boolean, commas: number | undefined, child: string | undefined, into: string | undefined): void {
  if (commas === (TOKEN_QUOTED_COMMA | TOKEN_UNQUOTED_COMMA)) { markUnverifiableCmdletTarget(builder); return; }
  if (commas !== TOKEN_UNQUOTED_COMMA) { addCmdletTarget(builder, value, cwd, expansion, destructive, child, into); return; }
  let start = 0;
  for (let comma = value.indexOf(","); comma >= 0; comma = value.indexOf(",", start)) {
    if (comma > start) addCmdletTarget(builder, value.slice(start, comma), cwd, expansion, destructive, child, into);
    start = comma + 1;
  }
  if (start < value.length) addCmdletTarget(builder, value.slice(start), cwd, expansion, destructive, child, into);
}

function addCmdletTarget(builder: ScopeBuilder, value: string, cwd: string, expansion: number, destructive: boolean, child: string | undefined, into: string | undefined): void {
  addTarget(builder, into !== undefined ? into + "/" + basename(value) : child === undefined ? value : value + "/" + child, cwd, true, expansion, destructive);
}

/**
 * cmd /c and /k run the rest of the line. One remaining word is the script itself (cmd
 * escapes with `^`, so its backslashes are separators); several remaining words are
 * already that script's words. Inside it, two-character `/x` words are cmd options.
 */
function inspectNativeCmdWrapper(tokens: PermissionTokens, start: number, cwd: string, depth: number, builder: ScopeBuilder): boolean {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.length !== 2 || token.charCodeAt(0) !== 47) continue;
    const flag = token.charCodeAt(1) | 0x20;
    if (flag !== 99 && flag !== 107) continue;
    if (index + 1 >= tokens.length || depth >= MAX_DEPTH) return false;
    const previous = builder.cmdOptions, previousShell = builder.nestedShell;
    builder.cmdOptions = true; builder.nestedShell = 2;
    try {
      if (index + 2 === tokens.length) inspectWindowsScript(tokens[index + 1]!, DIALECT_CMD, cwd, depth + 1, builder);
      // cmd strips the quotes of `"del /q" path` and runs the joined text; a quoted
      // fragment followed by more words is not re-split here, so it asks.
      else if (hasWhitespace(tokens[index + 1]!)) { markMutation(builder, "cmd"); markUnverifiableCmdletTarget(builder); }
      else inspectSegment(tokens, cwd, depth + 1, builder, index + 1);
    } finally { builder.cmdOptions = previous; builder.nestedShell = previousShell; }
    return true;
  }
  return false;
}

/** A cmd switch: `/x` or `/-x`. */
function isCmdOption(token: string): boolean {
  return token.charCodeAt(0) === 47 && (token.length === 2 || token.length === 3 && token.charCodeAt(1) === 45);
}

function hasWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index++) { const code = value.charCodeAt(index); if (code === 32 || code === 9) return true; }
  return false;
}

function findSearchRootIndex(tokens: readonly string[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    const value = tokens[index]!;
    if (value === "--") return tokens[index + 1] && !tokens[index + 1]!.startsWith("-") ? index + 1 : -1;
    if (value === "-H" || value === "-L" || value === "-P") continue;
    if (value.startsWith("-")) return -1;
    return index;
  }
  return -1;
}

function commandIndex(tokens: readonly string[], start = 0): number {
  let index = start;
  let wrapperDepth = 0;
  while (index < tokens.length) {
    const raw = tokens[index] ?? "";
    const name = commandName(raw);
    if (raw !== name) break;
    if (++wrapperDepth > MAX_DEPTH) return -1;
    if (name === "sudo" || name === "doas") {
      index += 1;
      while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
      continue;
    }
    if (name === "env") {
      index += 1;
      if (tokens[index] === "--") index += 1;
      while (index < tokens.length) {
        const value = tokens[index]!;
        if (value.includes("=")) return -1;
        if (value.startsWith("-")) index += 1;
        else break;
      }
      continue;
    }
    if (name === "timeout" || name === "timeout.exe") {
      const parsed = parseTimeoutInvocation(tokens, index);
      if (!parsed.supported) return -1;
      index = parsed.commandIndex;
      continue;
    }
    break;
  }
  return index;
}

function wrapperScript(tokens: readonly string[], start: number, bashStyle: boolean): string | undefined {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!.toLowerCase();
    if (token === "-c" || token === "/c" || token === "-command") {
      const sourceIndex = bashStyle && token === "-c" ? bashScriptOperandIndex(tokens, index) : index + 1;
      return sourceIndex < 0 ? undefined : tokens[sourceIndex];
    }
  }
  return undefined;
}

function hashedClassToken(value: string): string {
  return `h-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function safeClassToken(value: string): string {
  if (value.length === 0) return "none";
  if (value.length > 64) return hashedClassToken(value);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const allowed = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 45
      || code === 46
      || code === 95;
    if (!allowed) return hashedClassToken(value);
  }
  return value.toLowerCase();
}

function runnerClass(command: string, tokens: readonly string[], start: number): string {
  let executable = command;
  if (executable.endsWith(".exe")) executable = executable.slice(0, -4);
  else if (executable.endsWith(".cmd")) executable = executable.slice(0, -4);
  let action = "default";
  let actionIndex = -1;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--test" || token === "--check") {
      action = safeClassToken(token.slice(2));
      break;
    }
    if (token === "-e" || token === "--eval" || token === "-c") {
      const source = tokens[index + 1];
      return source ? `runner:${executable}:eval:${hashedClassToken(source)}` : `runner:${executable}:eval:none`;
    }
    if (token.startsWith("-")) continue;
    action = safeClassToken(token);
    actionIndex = index;
    break;
  }
  if (action !== "run" && action !== "run-script") return `runner:${executable}:${action}`;
  for (let index = actionIndex + 1; index < tokens.length; index++) {
    if (tokens[index]!.startsWith("-")) continue;
    return `runner:${executable}:${action}:${safeClassToken(tokens[index]!)}`;
  }
  return `runner:${executable}:${action}`;
}

function inspectSegment(tokens: PermissionTokens, cwd: string, depth: number, builder: ScopeBuilder, start = 0): string {
  const index = commandIndex(tokens, start);
  if (index < 0) {
    markOpaque(builder, "unverifiable_launcher");
    return cwd;
  }
  if (index >= tokens.length) return cwd;
  const command = commandName(tokens[index]!);
  const bareControl = index === 0 && !tokens.firstWordQuoted && tokens[index] === command;
  if (bareControl && (command === "for" || command === "done" || command === "}")) return cwd;
  if (bareControl && (command === "do" || command === "{")) return index + 1 < tokens.length ? inspectSegment(tokens, cwd, depth + 1, builder, index + 1) : cwd;
  if (isBashArithmeticCommandHead(tokens, index)) { markUncertainContext(builder, "unverifiable_arithmetic_command"); return cwd; }
  // Equal length: only letter case differs, so this is the bare cmdlet name, not a path.
  const nativeTool = builder.analysisOwner?.nativeTool;
  if (nativeTool !== undefined && tokens[index]!.length === command.length) {
    const cmdlet = POWERSHELL_FILE_CMDLETS.get(command);
    const powerShell = builder.nestedShell === 0 ? nativeTool === "powershell" : builder.nestedShell === 1;
    if (cmdlet !== undefined && ((cmdlet & CMDLET_ALIAS) === 0 || powerShell)) {
      inspectPowerShellFileCmdlet(command, cmdlet & ~CMDLET_ALIAS, tokens, index + 1, cwd, builder);
      return cwd;
    }
    // Set-Location/sl/chdir/Push-Location move later segments, as `cd` does.
    const location = powerShell && index === start ? powerShellLocationTarget(command, tokens, index) : undefined;
    if (location !== undefined) {
      if (!location || hasDynamicSyntax(location)) { markOpaque(builder, "dynamic_cd"); return cwd; }
      return resolve(cwd, location);
    }
  }
  if (tokens[index] !== command && command !== "command" && command !== "exec") {
    markOpaque(builder, "explicit_or_cased_executable");
    addTarget(builder, tokens[index]!, cwd);
    return cwd;
  }
  if (command === "command" || command === "exec" || command === "builtin") {
    if (tokens[index] !== command) {
      markOpaque(builder, "explicit_path_named_shell_builtin");
      addTarget(builder, tokens[index]!, cwd);
      return cwd;
    }
    if (command === "command" && (tokens[index + 1] === "-v" || tokens[index + 1] === "-V")) {
      if (hasUnsafeCommandQueryOperand(tokens, index + 2)) { markOpaque(builder, "unverifiable_command_query"); return cwd; }
      addClass(builder, "read:command-query");
      return cwd;
    }
    let nextIndex = index + 1;
    if (command === "command" && tokens[nextIndex] === "-p") nextIndex++;
    if (tokens[nextIndex] === "--") nextIndex++;
    if (depth >= MAX_DEPTH || !tokens[nextIndex] || tokens[nextIndex]!.startsWith("-")) {
      markOpaque(builder, "unverifiable_launcher");
      return cwd;
    }
    return inspectSegment(tokens, cwd, depth + 1, builder, nextIndex);
  }
  if (command === "alias") {
    markOpaque(builder, "opaque_alias");
    for (let operand = index + 1; operand < tokens.length; operand++) {
      const source = literalAliasSource(tokens, operand);
      if (source !== undefined) { builder.uncertainContext = true; inspectScript(source, cwd, depth + 1, builder); }
    }
    return cwd;
  }
  if (command === "eval") {
    const source = literalEvalScript(tokens, index + 1);
    markOpaque(builder, "opaque_eval");
    if (source === undefined || depth >= MAX_DEPTH) { builder.uncertainContext = true; return cwd; }
    inspectScript(source, cwd, depth + 1, builder);
    return cwd;
  }
  if (command === "trap") {
    const actionIndex = index + (tokens[index + 1] === "--" ? 2 : 1), action = tokens[actionIndex];
    markOpaque(builder, "opaque_trap");
    if (action && action !== "-" && action !== "-p" && action !== "-l" && !tokens.expansions?.[actionIndex]) inspectScript(action, cwd, depth + 1, builder);
    return cwd;
  }
  // A launched `cd` (`env cd`, `sudo cd`) is an external program and cannot move this shell.
  if (command === "cd" && index !== start) return cwd;
  if (command === "cd") {
    const target = tokens[index + 1];
    if (!target || hasDynamicSyntax(target)) {
      markOpaque(builder, "dynamic_cd");
      return cwd;
    }
    return resolve(cwd, target);
  }
  if (command === "printf" && hasStatefulBashPrintf(tokens, index)) {
    markUncertainContext(builder, "stateful_printf_variable_assignment");
    return cwd;
  }
  const testOpen = bashPipelinePrefixEnd(tokens, index);
  if (testOpen < 0) { markOpaque(builder, "unverifiable_launcher"); return cwd; }
  if (testOpen >= 0 && tokens[testOpen] === "[[" && tokens.bashTestOpenAt === testOpen && tokens.bashTestClosed) {
    addClass(builder, "read:bash-test");
    return cwd;
  }
  if (testOpen > index && testOpen < tokens.length) {
    if (tokens[testOpen] === "cd") { markOpaque(builder, "unverifiable_working_directory"); return cwd; }
    return inspectSegment(tokens, cwd, depth + 1, builder, testOpen);
  }
  if (SCRIPT_WRAPPERS.has(command)) {
    addClass(builder, `wrapper:${command}`);
    if ((command === "cmd" || command === "cmd.exe") && builder.analysisOwner?.nativeTool !== undefined
      && inspectNativeCmdWrapper(tokens, index + 1, cwd, depth, builder)) return cwd;
    const source = wrapperScript(tokens, index + 1, command === "bash" || command === "bash.exe" || command === "sh" || command === "zsh");
    if (!source || depth >= MAX_DEPTH) {
      markOpaque(builder, "opaque_shell_wrapper");
      addResolvedTarget(builder, cwd);
      return cwd;
    }
    // Aliases follow the interpreter that runs the script, not the outer tool. A PowerShell
    // script read for native authorization uses PowerShell's separators, as at the top level.
    const powerShell = POWERSHELL_WRAPPERS.has(command), previous = builder.nestedShell;
    builder.nestedShell = powerShell ? 1 : 2;
    try {
      if (powerShell && builder.analysisOwner?.nativeTool !== undefined) inspectWindowsScript(source, DIALECT_POWERSHELL, cwd, depth + 1, builder);
      else inspectScript(source, cwd, depth + 1, builder);
    } finally { builder.nestedShell = previous; }
    return cwd;
  }
  if (PYTHON_COMMAND_PATTERN.test(command) || NODE_COMMAND_PATTERN.test(command) || OPAQUE_RUNNERS.has(command)) {
    addClass(builder, runnerClass(command, tokens, index + 1));
    if (NODE_COMMAND_PATTERN.test(command)) {
      const checkIndex = tokens.indexOf("--check", index + 1);
      if (checkIndex >= 0 && tokens[checkIndex + 1] && !hasDynamicSyntax(tokens[checkIndex + 1]!)) return cwd;
    }
    markOpaque(builder, `opaque_${command.replaceAll(".", "_")}`);
    addResolvedTarget(builder, cwd);
    return cwd;
  }
  if (command === "git") {
    // `git -C sub reset --hard` works in `sub`: its paths are written relative to the -C chain.
    let at = index + 1, directory = "", expansion = 0;
    for (;;) {
      const word = tokens[at];
      if (word === "-C" && at + 1 < tokens.length) {
        const value = tokens[at + 1]!;
        directory = !directory || isAbsolute(value) ? value : directory + "/" + value;
        expansion |= tokens.expansions?.[at + 1] ?? 0;
        at += 2;
      } else if (word === "-c" && at + 1 < tokens.length) at += 2;
      else if (word !== undefined && GIT_GLOBAL_FLAGS.has(word)) at++;
      else break;
    }
    const subcommand = tokens[at]?.toLowerCase();
    addClass(builder, `git:${safeClassToken(subcommand ?? "unknown")}`);
    if (!subcommand || subcommand.startsWith("-")) {
      markOpaque(builder, "opaque_git_global_options");
      addResolvedTarget(builder, cwd);
      return cwd;
    }
    if (GIT_READ_ONLY.has(subcommand)) return cwd;
    // `git --no-pager branch --show-current`: the shared read-only judgment, for literal words only.
    let literal = true;
    for (let word = at; word < tokens.length; word++) if (tokens.expansions?.[word]) { literal = false; break; }
    if (literal && isReadOnlyGitAt(tokens, at, NO_CONFIGURED_SUBCOMMANDS)) return cwd;
    markMutation(builder, `git_${subcommand}`);
    // With `-C` the repository is that directory (its `.git` may be a linked worktree's pointer file, which is not written).
    addTarget(builder, directory || ".git", cwd, true, expansion);
    // `git worktree remove [--force] <path>` deletes that worktree's directory.
    if (subcommand === "worktree" && tokens[at + 1] === "remove") {
      let path = at + 2;
      while (path < tokens.length && tokens[path]!.charCodeAt(0) === 45) path++;
      const value = tokens[path];
      if (value === undefined) { builder.unverifiableMutation = true; markOpaque(builder, "missing_output_target"); }
      else addTarget(builder, directory && !isAbsolute(value) ? directory + "/" + value : value, cwd, true,
        expansion | (tokens.expansions?.[path] ?? 0), true);
    }
    return cwd;
  }
  if (READ_ONLY_COMMANDS.has(command) || command === "sort" && isReadOnlySortTail(tokens, index)) {
    addClass(builder, `read:${command}`);
    return cwd;
  }
  if (inspectKnownMutation(command, tokens, index + 1, cwd, builder)) return cwd;
  addClass(builder, `command:${safeClassToken(command || "command")}`);
  markOpaque(builder, `opaque_${command || "command"}`);
  addResolvedTarget(builder, cwd);
  return cwd;
}

type PermissionTokens = string[] & { expansions?: number[]; wordFlags?: number[]; redirections?: number[]; redirectionFds?: (string | undefined)[]; firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean; bashTestOpenAt?: number; bashTestClosed?: boolean; bashTestProcessSubstitution?: boolean; bashArithmeticCommandAt?: number };

function inspectTokenBuffer(tokens: PermissionTokens, cwd: string, depth: number, builder: ScopeBuilder, bashRules = true): string {
  if (tokens.length === 0) return cwd;
  builder.segmentCount += 1;
  if (builder.segmentCount > MAX_SEGMENTS) {
    // Later segments are not scanned, so a recognized mutation's full target set is unknown.
    if (builder.mutationDetected) builder.unverifiableMutation = true;
    markOpaque(builder, "too_many_segments");
    return cwd;
  }
  if (tokens.bashTestProcessSubstitution) {
    builder.dynamicScope = true;
    markOpaque(builder, "unverifiable_process_substitution");
    return cwd;
  }
  if (bashRules && hasUnsafeBashTestOperand(tokens)) markUncertainContext(builder, "unverifiable_bash_test_operand");
  if (bashRules && shellExpansionRisk(tokens) !== 0) markUncertainContext(builder, "stateful_shell_expansion");
  const arithmeticHead = bashRules && isBashArithmeticCommandHead(tokens, bashPipelinePrefixEnd(tokens, 0));
  const redirections = tokens.redirections;
  if (redirections) {
    for (let position = 0; position < redirections.length; position++) {
      const index = redirections[position]!;
      const operator = tokens[index]!;
      const target = index + 1 === redirections[position + 1] ? undefined : tokens[index + 1];
      const descriptorFd = tokens.redirectionFds?.[position];
      const writesFile = isShellOutputFileRedirection(operator, target, descriptorFd);
      if (writesFile && target !== "/dev/null") markMutation(builder, "output_redirection");
      if (isStaticDescriptorCopy(operator, target, descriptorFd)) continue;
      if (descriptorFd && isShellDynamicDescriptor(descriptorFd)) {
        if (writesFile) builder.unverifiableMutation = true;
        markUncertainContext(builder, "unverifiable_redirection");
        continue;
      }
      if (operator === "<" && target && !hasDynamicSyntax(target) && !isBashNetworkRedirectionTarget(target)) continue;
      if (!writesFile) {
        markOpaque(builder, "unverifiable_redirection");
        continue;
      }
      if (target === "/dev/null") continue;
      if (target) addTarget(builder, target, cwd, true, tokens.expansions?.[index + 1]);
      else { builder.unverifiableMutation = true; markUncertainContext(builder, "redirection_target_unverifiable"); }
    }
    stripShellRedirections(tokens, redirections);
    redirections.length = 0;
  }
  if (arithmeticHead) { markUncertainContext(builder, "unverifiable_arithmetic_command"); return cwd; }
  return tokens.length > 0 ? inspectSegment(tokens, cwd, depth, builder) : cwd;
}

/**
 * A PowerShell or cmd script under native authorization, read with that dialect's own
 * tokens instead of Bash rules. Bash-only state (heredocs, traps, `$((...))`) does not
 * apply. `$(...)` and `@(...)` bodies are PowerShell scripts of their own. One word
 * buffer serves every segment of this script.
 */
function inspectWindowsScript(source: string, dialect: number, initialCwd: string, depth: number, builder: ScopeBuilder): void {
  if (depth > MAX_DEPTH) {
    markOpaque(builder, "command_substitution_depth");
    return;
  }
  const table = builder.analysisOwner ? builder.analysisOwner.windowsTable(source, dialect) : lexWindowsScript(source, dialect);
  if (table.unterminated) markOpaque(builder, "unterminated_shell_syntax");
  for (let nested = 0; nested < table.nestedCount; nested++) {
    inspectWindowsScript(source.slice(table.nestedStarts[nested]!, table.nestedEnds[nested]!), DIALECT_POWERSHELL, initialCwd, depth + 1, builder);
  }
  const tokens: PermissionTokens = [];
  let cwd = initialCwd;
  for (let segment = 0; segment < table.segmentCount; segment++) {
    fillWindowsSegment(table, segment, tokens);
    cwd = inspectTokenBuffer(tokens, cwd, depth, builder, false);
  }
}

function inspectScript(command: string, initialCwd: string, depth: number, builder: ScopeBuilder): void {
  if (depth > MAX_DEPTH) {
    markOpaque(builder, "command_substitution_depth");
    return;
  }
  const prepared = builder.analysisOwner ? builder.analysisOwner.get(command) : analyzeShellSource(command);
  const analysis = prepared.view;
  let uncertainStateStart = uninspectableBashStateStart(analysis.command, builder.analysisOwner);
  // These nested sources are visited before the outer token walk.
  if (uncertainStateStart >= 0 && (analysis.substitutions.length || prepared.substitutions.scripts.length)) uncertainStateStart = 0;
  if (uncertainStateStart === 0) {
    uncertainStateStart = -1;
    markOpaque(builder, "unverifiable_shell_state");
    builder.uncertainContext = true;
  }
  if (prepared.stdin) markOpaque(builder, `stdin_${prepared.stdin.kind}:${prepared.stdin.consumer}`);
  if (analysis.hasHeredoc) markOpaque(builder, "heredoc_uninspectable");
  if (analysis.uncertain) markOpaque(builder, "shell_context_uninspectable");
  const storedScripts = literalStoredScripts(analysis.command, builder.analysisOwner);
  if (storedScripts === null) markUncertainContext(builder, "stored_source_limit");
  if (storedScripts) for (const source of storedScripts) { markUncertainContext(builder, "resolved_stored_action"); inspectScript(source, initialCwd, depth + 1, builder); }
  const processScripts = literalProcessSources(analysis.command, builder.analysisOwner);
  if (processScripts === null) markUncertainContext(builder, "process_source_limit");
  if (processScripts === false) markUncertainContext(builder, "process_source_unresolved");
  if (processScripts) for (const source of processScripts) { markUncertainContext(builder, "resolved_process_source"); inspectScript(source, initialCwd, depth + 1, builder); }
  for (const nested of analysis.substitutions) inspectScript(nested, initialCwd, depth + 1, builder);
  const substitutions = prepared.substitutions;
  if (substitutions.uncertain) markOpaque(builder, "uninspectable_command_substitution");
  for (const nested of substitutions.scripts) inspectScript(nested, initialCwd, depth + 1, builder);
  command = analysis.command;
  const loopReason = unsafeBashLoopHeaderReason(command, builder.analysisOwner);
  if (loopReason) markUncertainContext(builder, loopReason);
  // The same table the lifecycle and mutation scanners read; one word buffer serves every segment.
  const table = builder.analysisOwner ? builder.analysisOwner.bashTable(command) : lexBash(command);
  const classifyHeredoc = analysis.hereDocuments !== undefined && prepared.heredocLanguages === undefined;
  let heredocLanguages = prepared.heredocLanguages ?? 0;
  let heredocSegments = 0, heredocUncertainContext = false;
  let cwd = initialCwd;
  const tokens: PermissionTokens = [];
  for (let segment = 0; segment < table.segmentCount; segment++) {
    // State changed in an earlier segment applies from the segment holding its offset on.
    if (uncertainStateStart >= 0 && uncertainStateStart <= table.segmentSourceEnds[segment]!) {
      markUncertainContext(builder, "unverifiable_shell_state"); uncertainStateStart = -1;
    }
    fillBashSegment(table, segment, tokens);
    if (classifyHeredoc) heredocLanguages |= heredocScriptLanguages(tokens);
    if (analysis.hereDocuments && (++heredocSegments > 1 || tokens.includes("-c") || tokens.includes("eval"))) heredocUncertainContext = true;
    cwd = inspectTokenBuffer(tokens, cwd, depth, builder);
  }
  if (table.unterminated) markOpaque(builder, "unterminated_shell_syntax");
  if (analysis.hereDocuments) {
    prepared.heredocLanguages = heredocLanguages;
    if (heredocLanguages & 1) for (const document of analysis.hereDocuments) {
      if (heredocUncertainContext) markUncertainContext(builder, "heredoc_execution_context");
      if (document.expanded) markUncertainContext(builder, "heredoc_expanded_source");
      inspectScript(document.body, initialCwd, depth + 1, builder);
    }
  }
}

function publicScope(builder: ScopeBuilder): BashPermissionScope {
  return {
    kind: builder.kind,
    targets: builder.targets,
    destructiveTargets: builder.destructiveTargets,
    moveDestinations: builder.moveDestinations,
    primitives: builder.primitives,
    classes: builder.classes,
    dynamicScope: builder.dynamicScope,
    unverifiableScope: builder.unverifiableScope,
    mutationDetected: builder.mutationDetected,
    unverifiableMutation: builder.unverifiableMutation,
  };
}

export function inspectBashPermissionScope(input: unknown, cwd: string, analysisOwner?: ShellAnalysisOwner): BashPermissionScope | undefined {
  if (!input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  const builder: ScopeBuilder = {
    kind: "read-only",
    targets: [],
    primitives: [],
    classes: [],
    dynamicScope: false,
    unverifiableScope: false,
    segmentCount: 0,
    analysisOwner,
    mutationDetected: false,
    uncertainContext: false,
    unverifiableMutation: false,
    cmdOptions: false,
    nestedShell: 0,
  };
  if (command.length > MAX_COMMAND_CHARS) {
    markOpaque(builder, "oversized_command");
    return publicScope(builder);
  }
  if (analysisOwner?.nativeTool === "powershell") {
    inspectWindowsScript(command, DIALECT_POWERSHELL, resolve(cwd), 0, builder);
    return publicScope(builder);
  }
  if (isLiteralReadLoop(command)) {
    addClass(builder, "read:literal-loop");
    return publicScope(builder);
  }
  if (isReadOnlyFindLoop(command)) {
    addClass(builder, "read:find-loop");
    return publicScope(builder);
  }
  inspectScript(command, resolve(cwd), 0, builder);
  return publicScope(builder);
}
