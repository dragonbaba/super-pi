import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { hasAmbiguousBashCwd, unsafeBashLoopHeaderReason } from "./core.ts";
import { extractCommandSubstitutions, prepareShellAnalysis } from "./shell-substitution.ts";
import { parseTimeoutInvocation } from "./timeout-wrapper.ts";
import { bashTimeOptionsEnd, hasStatefulBashPrintf, hasUnsafeBashTestOperand, hasUnsafeCommandQueryOperand, isBashDoubleBracketCloseBoundary, isBashDoubleBracketHead, isBashProcessSubstitutionStart, isBashTestWhitespace, isShellDynamicDescriptor, isShellFileDescriptor, isShellOutputFileRedirection, isSimpleBashAnsiCQuote, isStaticDescriptorCopy, shellRedirectionLength, stripShellRedirections } from "./shell-redirection.ts";

const MAX_COMMAND_CHARS = 128 * 1024;
const MAX_SEGMENTS = 64;
const MAX_TARGETS = 16;
const MAX_DEPTH = 4;
const READ_ONLY_COMMANDS = new Set([
  "cat", "dir", "echo", "file", "grep", "head", "ls", "printf", "pwd", "readlink", "realpath", "rg", "stat", "tail", "type", "wc", "where", "which",
]);
const SCRIPT_WRAPPERS = new Set(["bash", "bash.exe", "sh", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const OPAQUE_RUNNERS = new Set([
  "bun", "bun.exe", "deno", "deno.exe", "node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "py", "py.exe", "python", "python.exe", "python3", "python3.exe", "yarn", "yarn.cmd",
]);
const SIMPLE_MUTATIONS = new Set(["del", "erase", "mkdir", "md", "rm", "rmdir", "rd", "touch"]);
const COPY_COMMANDS = new Set(["cp", "copy"]);
const MOVE_COMMANDS = new Set(["mv", "move", "rename", "ren"]);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse"]);

export type BashPermissionKind = "read-only" | "known-mutation" | "opaque-script";

export interface BashPermissionScope {
  kind: BashPermissionKind;
  targets: string[];
  primitives: string[];
  classes: string[];
  dynamicScope: boolean;
  unverifiableScope: boolean;
}

interface ScopeBuilder extends BashPermissionScope {
  segmentCount: number;
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

function addTarget(builder: ScopeBuilder, value: string, cwd: string): void {
  if (hasDynamicSyntax(value)) {
    builder.dynamicScope = true;
    markOpaque(builder, "dynamic_target");
    return;
  }
  const target = resolve(cwd, value);
  for (const current of builder.targets) if (current === target) return;
  if (builder.targets.length >= MAX_TARGETS) {
    markOpaque(builder, "too_many_targets");
    return;
  }
  builder.targets.push(target);
}

function markMutation(builder: ScopeBuilder, primitive: string): void {
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

function addPositionalTargets(
  tokens: readonly string[],
  start: number,
  builder: ScopeBuilder,
  cwd: string,
  skip: number,
  lastOnly: boolean,
): number {
  let optionsEnded = false;
  let count = 0;
  let last: string | undefined;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) continue;
    count += 1;
    if (lastOnly) last = token;
    else if (count > skip) addTarget(builder, token, cwd);
  }
  if (lastOnly && last !== undefined && count > skip) addTarget(builder, last, cwd);
  if (count === 0) markOpaque(builder, "missing_static_target");
  return count;
}

function inspectKnownMutation(command: string, tokens: readonly string[], start: number, cwd: string, builder: ScopeBuilder): boolean {
  if (command === "find") {
    const root = findSearchRoot(tokens, start);
    for (let index = start; index < tokens.length; index++) {
      if (tokens[index] === "-delete" || tokens[index] === "-exec" || tokens[index] === "-execdir") {
        markMutation(builder, tokens[index] === "-delete" ? "find_delete" : "find_exec");
        addTarget(builder, root ?? cwd, cwd);
        if (tokens[index] !== "-delete") markOpaque(builder, "find_exec_scope");
        return true;
      }
    }
    return true;
  }
  if (SIMPLE_MUTATIONS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, false);
    return true;
  }
  if (COPY_COMMANDS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, true);
    return true;
  }
  if (MOVE_COMMANDS.has(command)) {
    markMutation(builder, command);
    addPositionalTargets(tokens, start, builder, cwd, 0, false);
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

function findSearchRoot(tokens: readonly string[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index++) {
    const value = tokens[index]!;
    if (value === "--") return tokens[index + 1] && !tokens[index + 1]!.startsWith("-") ? tokens[index + 1] : undefined;
    if (value === "-H" || value === "-L" || value === "-P") continue;
    if (value.startsWith("-")) return undefined;
    return value;
  }
  return undefined;
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

function wrapperScript(tokens: readonly string[], start: number): string | undefined {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!.toLowerCase();
    if (token === "-c" || token === "/c" || token === "-command") return tokens[index + 1];
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
  if (tokens[index] !== command && command !== "command" && command !== "exec") {
    markOpaque(builder, "explicit_or_cased_executable");
    addTarget(builder, tokens[index]!, cwd);
    return cwd;
  }
  if (command === "command" || command === "exec") {
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
    if (depth >= MAX_DEPTH || !tokens[index + 1] || tokens[index + 1]!.startsWith("-")) {
      markOpaque(builder, "unverifiable_launcher");
      return cwd;
    }
    return inspectSegment(tokens, cwd, depth + 1, builder, index + 1);
  }
  if (command === "cd") {
    const target = tokens[index + 1];
    if (!target || hasDynamicSyntax(target)) {
      markOpaque(builder, "dynamic_cd");
      return cwd;
    }
    return resolve(cwd, target);
  }
  if (command === "printf" && hasStatefulBashPrintf(tokens, index)) {
    markOpaque(builder, "stateful_printf_variable_assignment");
    return cwd;
  }
  if (tokens[index] === "[[" && tokens.bashTestOpenAt === index && tokens.bashTestClosed) {
    addClass(builder, "read:bash-test");
    return cwd;
  }
  if (tokens[index] === "!" && index === 0 && !tokens.firstWordQuoted && tokens.bashTestOpenAt === index + 1
    && tokens[index + 1] === "[[" && tokens.bashTestClosed) {
    addClass(builder, "read:bash-test");
    return cwd;
  }
  if (tokens[index] === "time" && !tokens.firstWordQuoted && tokens.bashTestClosed
    && tokens.bashTestOpenAt === bashTimeOptionsEnd(tokens, index + 1)
    && tokens[tokens.bashTestOpenAt] === "[[") {
    addClass(builder, "read:bash-test");
    return cwd;
  }
  if (SCRIPT_WRAPPERS.has(command)) {
    addClass(builder, `wrapper:${command}`);
    const source = wrapperScript(tokens, index + 1);
    if (!source || depth >= MAX_DEPTH) {
      markOpaque(builder, "opaque_shell_wrapper");
      addTarget(builder, cwd, cwd);
      return cwd;
    }
    inspectScript(source, cwd, depth + 1, builder);
    return cwd;
  }
  if (OPAQUE_RUNNERS.has(command)) {
    addClass(builder, runnerClass(command, tokens, index + 1));
    if (command === "node" || command === "node.exe") {
      const checkIndex = tokens.indexOf("--check", index + 1);
      if (checkIndex >= 0 && tokens[checkIndex + 1] && !hasDynamicSyntax(tokens[checkIndex + 1]!)) return cwd;
    }
    markOpaque(builder, `opaque_${command.replaceAll(".", "_")}`);
    addTarget(builder, cwd, cwd);
    return cwd;
  }
  if (command === "git") {
    const subcommand = tokens[index + 1]?.toLowerCase();
    addClass(builder, `git:${safeClassToken(subcommand ?? "unknown")}`);
    if (!subcommand || subcommand.startsWith("-")) {
      markOpaque(builder, "opaque_git_global_options");
      addTarget(builder, cwd, cwd);
      return cwd;
    }
    if (GIT_READ_ONLY.has(subcommand)) return cwd;
    markMutation(builder, `git_${subcommand}`);
    addTarget(builder, ".git", cwd);
    return cwd;
  }
  if (READ_ONLY_COMMANDS.has(command)) {
    addClass(builder, `read:${command}`);
    return cwd;
  }
  if (inspectKnownMutation(command, tokens, index + 1, cwd, builder)) return cwd;
  addClass(builder, `command:${safeClassToken(command || "command")}`);
  markOpaque(builder, `opaque_${command || "command"}`);
  addTarget(builder, cwd, cwd);
  return cwd;
}

type PermissionTokens = string[] & { expansions?: number[]; redirections?: number[]; redirectionFds?: (string | undefined)[]; firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean; bashTestOpenAt?: number; bashTestClosed?: boolean; bashTestProcessSubstitution?: boolean };

function inspectTokenBuffer(tokens: PermissionTokens, cwd: string, depth: number, builder: ScopeBuilder): string {
  if (tokens.length === 0) return cwd;
  builder.segmentCount += 1;
  if (builder.segmentCount > MAX_SEGMENTS) {
    markOpaque(builder, "too_many_segments");
    return cwd;
  }
  if (tokens.bashTestProcessSubstitution) {
    builder.dynamicScope = true;
    markOpaque(builder, "unverifiable_process_substitution");
    return cwd;
  }
  if (hasUnsafeBashTestOperand(tokens)) markOpaque(builder, "unverifiable_bash_test_operand");
  const redirections = tokens.redirections;
  if (redirections) {
    for (let position = 0; position < redirections.length; position++) {
      const index = redirections[position]!;
      const operator = tokens[index]!;
      const target = index + 1 === redirections[position + 1] ? undefined : tokens[index + 1];
      const descriptorFd = tokens.redirectionFds?.[position];
      if (isStaticDescriptorCopy(operator, target, descriptorFd)) continue;
      if (descriptorFd && isShellDynamicDescriptor(descriptorFd)) {
        markOpaque(builder, "unverifiable_redirection");
        continue;
      }
      if (operator === "<" && target && !hasDynamicSyntax(target)) continue;
      if (!isShellOutputFileRedirection(operator)) {
        markOpaque(builder, "unverifiable_redirection");
        continue;
      }
      if (target === "/dev/null") continue;
      markMutation(builder, "output_redirection");
      if (target) addTarget(builder, target, cwd);
      else markOpaque(builder, "redirection_target_unverifiable");
    }
    stripShellRedirections(tokens, redirections);
  }
  return tokens.length > 0 ? inspectSegment(tokens, cwd, depth, builder) : cwd;
}

function inspectScript(command: string, initialCwd: string, depth: number, builder: ScopeBuilder): void {
  if (depth > MAX_DEPTH) {
    markOpaque(builder, "command_substitution_depth");
    return;
  }
  if (hasAmbiguousBashCwd(command)) {
    markOpaque(builder, "unverifiable_working_directory");
    return;
  }
  const analysis = prepareShellAnalysis(command);
  if (analysis.hasHeredoc) markOpaque(builder, "heredoc_uninspectable");
  if (analysis.uncertain) markOpaque(builder, "shell_context_uninspectable");
  for (const nested of analysis.substitutions) inspectScript(nested, initialCwd, depth + 1, builder);
  const substitutions = extractCommandSubstitutions(analysis.command);
  if (substitutions.unterminated) markOpaque(builder, "unterminated_command_substitution");
  if (substitutions.unsupported) markOpaque(builder, "uninspectable_command_substitution");
  for (const nested of substitutions.scripts) inspectScript(nested, initialCwd, depth + 1, builder);
  command = analysis.command;
  const loopReason = unsafeBashLoopHeaderReason(command);
  if (loopReason) markOpaque(builder, loopReason);
  let cwd = initialCwd;
  const tokens: PermissionTokens = [];
  let value = "";
  let tokenStarted = false;
  let quote = 0;
  let arithmeticDepth = 0;
  let escaped = false;
  let literalWord = true;
  let redirectionTargetPending = false;
  let bashDoubleBracket = false;
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (escaped) {
      literalWord = false;
      value += command[index];
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (code === 92 && quote !== 39) {
      const next = command.charCodeAt(index + 1);
      if (next === 10) { index++; continue; }
      if (quote === 34 && next !== 36 && next !== 96 && next !== 34 && next !== 92) {
        value += "\\"; tokenStarted = true; continue;
      }
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote === 0 && code === 36 && isSimpleBashAnsiCQuote(command, index)) {
      quote = 39; literalWord = false; tokenStarted = true; index++; continue;
    }
    if (quote !== 39 && (code === 36 || code === 96)) {
      const flags = code === 96 || command.charCodeAt(index + 1) === 40 ? 4 : 1;
      const expansions = tokens.expansions ??= [];
      expansions[tokens.length] = (expansions[tokens.length] ?? 0) | flags;
    }
    if (quote === 0 && (code === 123 || code === 125)) {
      const expansions = tokens.expansions ??= [];
      expansions[tokens.length] = (expansions[tokens.length] ?? 0) | 8;
    }
    if (quote !== 0) {
      if (code === quote) quote = 0;
      else value += command[index];
      continue;
    }
    if (code === 36 && command.charCodeAt(index + 1) === 40 && command.charCodeAt(index + 2) === 40) {
      value += command.slice(index, index + 3);
      tokenStarted = true;
      literalWord = false;
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (code === 40 && command.charCodeAt(index + 1) === 40) {
      value += "((";
      tokenStarted = true;
      literalWord = false;
      arithmeticDepth = 2;
      index++;
      continue;
    }
    if (arithmeticDepth > 0) {
      if (code === 40) arithmeticDepth++;
      else if (code === 41) arithmeticDepth--;
      value += command[index];
      tokenStarted = true;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      literalWord = false;
      tokenStarted = true;
      continue;
    }
    if (code === 32 || code === 9 || (bashDoubleBracket && isBashTestWhitespace(code))) {
      if (tokenStarted) {
        if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
        if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
        if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
        tokens.push(value);
        redirectionTargetPending = false;
        value = "";
        tokenStarted = false;
        literalWord = true;
      }
      continue;
    }
    if (code === 35 && !tokenStarted) {
      while (index < command.length && command.charCodeAt(index) !== 10 && command.charCodeAt(index) !== 13) index++;
      if (index >= command.length) break;
      index--; continue;
    }
    if (!bashDoubleBracket && code === 91 && command.charCodeAt(index + 1) === 91 && !tokenStarted
      && isBashDoubleBracketHead(tokens) && isBashTestWhitespace(command.charCodeAt(index + 2))) {
      tokens.bashTestOpenAt = tokens.length;
      value = "[["; tokenStarted = true; bashDoubleBracket = true; index++; continue;
    }
    if (bashDoubleBracket && code === 93 && command.charCodeAt(index + 1) === 93 && !tokenStarted
      && isBashDoubleBracketCloseBoundary(command, index + 2)) {
      tokens.bashTestClosed = true;
      value = "]]"; tokenStarted = true; bashDoubleBracket = false; index++; continue;
    }
    if (bashDoubleBracket && isBashProcessSubstitutionStart(command, index)) tokens.bashTestProcessSubstitution = true;
    const redirectionWidth = bashDoubleBracket ? 0 : shellRedirectionLength(command, index);
    if (redirectionWidth > 0) {
      const sourceFd = !redirectionTargetPending && literalWord && (isShellFileDescriptor(value) || isShellDynamicDescriptor(value)) ? value : undefined;
      if (tokenStarted && !sourceFd) {
        if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
        if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
        if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
        tokens.push(value);
      }
      (tokens.redirections ??= []).push(tokens.length);
      (tokens.redirectionFds ??= []).push(sourceFd);
      tokens.push(command.slice(index, index + redirectionWidth));
      redirectionTargetPending = true;
      index += redirectionWidth - 1;
      value = "";
      tokenStarted = false;
      literalWord = true;
      continue;
    }
    if (code === 10 || code === 13 || code === 59 || code === 38 || code === 124 || code === 40 || code === 41) {
      if (bashDoubleBracket) { value += command[index]; tokenStarted = true; continue; }
      if (tokenStarted) {
        if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
        if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
        if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
        tokens.push(value);
      }
      cwd = inspectTokenBuffer(tokens, cwd, depth, builder);
      tokens.length = 0;
      if (tokens.redirections) tokens.redirections.length = 0;
      if (tokens.redirectionFds) tokens.redirectionFds.length = 0;
      if (tokens.expansions) tokens.expansions.length = 0;
      tokens.bashTestOpenAt = undefined;
      tokens.bashTestClosed = undefined;
      tokens.bashTestProcessSubstitution = undefined;
      tokens.firstWordQuoted = undefined;
      tokens.secondWordQuoted = undefined;
      tokens.thirdWordQuoted = undefined;
      literalWord = true;
      value = "";
      tokenStarted = false;
      redirectionTargetPending = false;
      if ((code === 38 || code === 124) && command.charCodeAt(index + 1) === code) index += 1;
      continue;
    }
    value += command[index];
    tokenStarted = true;
  }
  if (tokenStarted) {
    if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
    if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
    if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
    tokens.push(value);
  }
  inspectTokenBuffer(tokens, cwd, depth, builder);
  if (quote !== 0 || escaped) markOpaque(builder, "unterminated_shell_syntax");
}

function publicScope(builder: ScopeBuilder): BashPermissionScope {
  return {
    kind: builder.kind,
    targets: builder.targets,
    primitives: builder.primitives,
    classes: builder.classes,
    dynamicScope: builder.dynamicScope,
    unverifiableScope: builder.unverifiableScope,
  };
}

export function inspectBashPermissionScope(input: unknown, cwd: string): BashPermissionScope | undefined {
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
  };
  if (command.length > MAX_COMMAND_CHARS) {
    markOpaque(builder, "oversized_command");
    return publicScope(builder);
  }
  inspectScript(command, resolve(cwd), 0, builder);
  return publicScope(builder);
}
