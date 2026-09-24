/** Called only outside quotes/escapes. Returns an operator width, never argv. */
export function shellRedirectionLength(source: string, index: number): number {
  const first = source.charCodeAt(index);
  const next = source.charCodeAt(index + 1);
  if (first === 38) return next === 62 ? (source.charCodeAt(index + 2) === 62 ? 3 : 2) : 0;
  if (first === 60) return next === 38 || next === 62 ? 2 : next === 60 ? (source.charCodeAt(index + 2) === 60 ? 3 : 2) : 1;
  if (first !== 62) return 0;
  if (next === 62) return 2;
  return next === 38 || next === 124 ? 2 : 1;
}

/** Bash test keyword and expression separators, including physical newlines. */
export function isBashTestWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Unquoted `<(` and `>(` start executable process substitutions, not comparisons. */
export function isBashProcessSubstitutionStart(source: string, index: number): boolean {
  const code = source.charCodeAt(index);
  return (code === 60 || code === 62) && source.charCodeAt(index + 1) === 40;
}

type QuotedWords = readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean; bashArithmeticCommandAt?: number };

/** Quote flags exist only for the first three words; later words count as quoted. */
function isQuotedBashWord(tokens: QuotedWords, index: number): boolean {
  return index === 0 ? tokens.firstWordQuoted === true
    : index === 1 ? tokens.secondWordQuoted === true
    : index === 2 ? tokens.thirdWordQuoted === true : true;
}

/** `[[` is a Bash keyword only at a command/test head, not an argv word. */
export function isBashDoubleBracketHead(tokens: QuotedWords): boolean {
  if (tokens.length === 0) return true;
  if (tokens.firstWordQuoted) return false;
  const head = tokens[0];
  const start = head === "if" || head === "elif" || head === "while" || head === "until"
    || head === "then" || head === "else" || head === "do" || head === "{" ? 1 : 0;
  return bashPipelinePrefixEnd(tokens, start) === tokens.length;
}

/** Bash accepts only literal `time [-p] [--]`; quoted option words are argv. */
function bashTimeOptionsEnd(tokens: QuotedWords, start: number): number {
  let index = start;
  // The lexer retains quote provenance for only three words. A later option
  // could be literal syntax or quoted argv, so do not guess past that bound.
  if (index >= 3 && (tokens[index] === "-p" || tokens[index] === "--")) return -1;
  if (tokens[index] === "-p" && !isQuotedBashWord(tokens, index)) index++;
  if (index >= 3 && tokens[index] === "--") return -1;
  if (tokens[index] === "--" && !isQuotedBashWord(tokens, index)) index++;
  return index;
}

/** Skip bounded literal `!` and `time [-p] [--]` pipeline prefixes; -1 when unbounded. */
export function bashPipelinePrefixEnd(tokens: QuotedWords, start: number): number {
  let index = start;
  let prefixes = 0;
  while (index < tokens.length) {
    const word = tokens[index];
    if (index >= 3 && (word === "!" || word === "time")) return -1;
    if ((word !== "!" && word !== "time") || isQuotedBashWord(tokens, index)) break;
    if (++prefixes > 4) return -1;
    index = word === "time" ? bashTimeOptionsEnd(tokens, index + 1) : index + 1;
  }
  return index;
}

/** Bare `((...))` can assign shell variables; quoted text is an argv word. */
export function isBashArithmeticCommandHead(tokens: QuotedWords, index: number): boolean {
  return tokens.bashArithmeticCommandAt === index;
}

/** Bash-style `-c` accepts an optional `--` before the actual script word. */
export function bashScriptOperandIndex(tokens: readonly string[], flagIndex: number): number {
  const index = tokens[flagIndex + 1] === "--" ? flagIndex + 2 : flagIndex + 1;
  return index < tokens.length ? index : -1;
}

export function isBashDoubleBracketCloseBoundary(source: string, index: number): boolean {
  if (index >= source.length) return true;
  const code = source.charCodeAt(index);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 59
    || code === 38 || code === 124 || code === 41 || code === 60 || code === 62;
}

/** Index of a for/select keyword after bounded control and `!`/`time` prefixes. */
function bashLoopKeywordIndex(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean }): number {
  let index = 0;
  if (tokens[0] === "do" || tokens[0] === "{" || tokens[0] === "then" || tokens[0] === "else") {
    if (tokens.firstWordQuoted) return -1;
    index++;
  }
  let prefixes = 0;
  while (tokens[index] === "!" || tokens[index] === "time") {
    if ((index === 0 && tokens.firstWordQuoted) || (index === 1 && tokens.secondWordQuoted)) return -1;
    if (++prefixes > 4) return -1;
    if (tokens[index] === "time") {
      index++;
      if (tokens[index] === "-p") index++;
      if (tokens[index] === "--") index++;
    } else index++;
  }
  return index;
}

/** Find the binding word of an unquoted for/select header. */
export function bashLoopVariableIndex(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean }): number {
  const index = bashLoopKeywordIndex(tokens);
  if (index < 0 || (index === 0 && tokens.firstWordQuoted) || (index === 1 && tokens.secondWordQuoted)
    || (tokens[index] !== "for" && tokens[index] !== "select")) return -1;
  return index + 1;
}

/**
 * Return the `((...))` text of a C-style for header. `for((` tokenizes as one
 * arithmetic word, so it is recognized regardless of quote flags.
 */
export function bashArithmeticForHeader(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean }): string | undefined {
  const index = bashLoopKeywordIndex(tokens);
  if (index < 0) return undefined;
  const keyword = tokens[index];
  if (keyword?.startsWith("for((")) return keyword.slice(3);
  if (keyword !== "for" || (index === 0 && tokens.firstWordQuoted) || (index === 1 && tokens.secondWordQuoted)) return undefined;
  const header = tokens[index + 1];
  return header?.startsWith("((") ? header : undefined;
}

function isLookupSensitiveBashVariable(name: string | undefined): boolean {
  return name === "PATH" || name === "BASH_ENV" || name === "ENV"
    || name === "SHELLOPTS" || name === "BASHOPTS" || name === "CDPATH" || name === "PS4"
    // EXECIGNORE hides matching PATH entries, so a later lookup can reach a workspace executable.
    || name === "EXECIGNORE";
}

function hasLookupSensitiveArithmeticName(expression: string): boolean {
  let start = -1;
  for (let index = 0; index <= expression.length; index++) {
    const code = index < expression.length ? expression.charCodeAt(index) : 0;
    const word = code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (word) { if (start < 0) start = index; continue; }
    if (start >= 0 && isLookupSensitiveBashVariable(expression.slice(start, index))) return true;
    start = -1;
  }
  return false;
}

/** A loop binding or its in-list expansion can change later shell state. */
export function unsafeBashForHeaderReason(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean; expansions?: readonly number[] }): "stateful_loop_variable_assignment" | "stateful_loop_list_expansion" | undefined {
  const arithmetic = bashArithmeticForHeader(tokens);
  if (arithmetic !== undefined) return hasLookupSensitiveArithmeticName(arithmetic) ? "stateful_loop_variable_assignment" : undefined;
  const variableIndex = bashLoopVariableIndex(tokens);
  if (variableIndex < 0) return undefined;
  const variable = tokens[variableIndex];
  if (isLookupSensitiveBashVariable(variable)) return "stateful_loop_variable_assignment";
  return tokens[variableIndex + 1] === "in" && hasUnsafeBashLoopListOperand(tokens, variableIndex + 2)
    ? "stateful_loop_list_expansion" : undefined;
}

/** Only a numeric, literal descriptor copy is inspectable; closure and moves remain opaque. */
export function isStaticDescriptorCopy(operator: string, target: string | undefined, sourceFd?: string): boolean {
  return (operator === ">&" || operator === "<&") && target !== undefined && isShellFileDescriptor(target)
    && (sourceFd === undefined || isShellFileDescriptor(sourceFd));
}

/** Unquoted Bash {name} immediately before a redirection allocates a dynamic FD. */
export function isShellDynamicDescriptor(value: string): boolean {
  return value.length > 2 && value.charCodeAt(0) === 123 && value.charCodeAt(value.length - 1) === 125;
}

export function isShellOutputFileRedirection(operator: string): boolean {
  return operator === ">" || operator === ">>" || operator === ">|" || operator === "&>" || operator === "&>>";
}

export function isShellFileDescriptor(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** Inspect only the common literal ANSI-C quote escapes; other forms stay uncertain. */
export function isSimpleBashAnsiCQuote(source: string, index: number): boolean {
  if (source.charCodeAt(index) !== 36 || source.charCodeAt(index + 1) !== 39) return false;
  for (let cursor = index + 2; cursor < source.length; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === 39) return true;
    if (code !== 92) continue;
    const escaped = source.charCodeAt(++cursor);
    if (escaped !== 110 && escaped !== 114 && escaped !== 116) return false;
  }
  return false;
}

/** Bash printf can assign variables through -v or a %n conversion. */
export function hasStatefulBashPrintf(tokens: readonly string[] & { expansions?: readonly number[] }, commandIndex: number): boolean {
  let formatIndex = commandIndex + 1;
  const first = tokens[formatIndex];
  if (first === undefined) return false;
  if (first.startsWith("-v")) return true;
  if (first === "--") formatIndex++;
  const format = tokens[formatIndex];
  if (format === undefined) return false;
  if ((tokens.expansions?.[formatIndex] ?? 0) !== 0) return true;
  for (let index = 0; index < format.length; index++) {
    if (format.charCodeAt(index) !== 37) continue;
    if (format.charCodeAt(index + 1) === 37) { index++; continue; }
    let conversion = index + 1;
    while (conversion < format.length) {
      const code = format.charCodeAt(conversion);
      if ((code >= 48 && code <= 57) || code === 36 || code === 32 || code === 35 || code === 39
        || code === 42 || code === 43 || code === 45 || code === 46) { conversion++; continue; }
      break;
    }
    // Bash skips the `hjlLtz` length modifiers before the conversion (`%ln`).
    while (isPrintfLengthModifier(format.charCodeAt(conversion))) conversion++;
    if (format.charCodeAt(conversion) === 110) return true;
  }
  return false;
}

function isPrintfLengthModifier(code: number): boolean {
  return code === 104 || code === 106 || code === 108 || code === 76 || code === 116 || code === 122;
}

/** Bash opens network sockets for these virtual paths instead of files. */
export function isBashNetworkRedirectionTarget(target: string): boolean {
  return target.startsWith("/dev/tcp/") || target.startsWith("/dev/udp/");
}

/** 0: inert; 1: may assign through a referenced value; 2: assigns or runs code. */
export type ShellExpansionRisk = 0 | 1 | 2;

/**
 * Expansions that can assign shell variables in the current shell. Arithmetic
 * assignment, `${v=...}`, `${v@P}` and `${ cmd; }` are definite (2); arithmetic
 * names, non-literal subscripts and indirection may assign through a value that
 * is evaluated recursively (1). Command substitutions run in a subshell and are
 * inspected as nested scripts.
 */
export function shellExpansionRisk(tokens: readonly string[] & { expansions?: readonly number[] }): ShellExpansionRisk {
  const expansions = tokens.expansions;
  if (!expansions) return 0;
  let risk: ShellExpansionRisk = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (((expansions[index] ?? 0) & 7) === 0) continue;
    const tokenRisk = expansionTextRisk(tokens[index]!);
    if (tokenRisk === 2) return 2;
    if (tokenRisk > risk) risk = tokenRisk;
  }
  return risk;
}

function expansionTextRisk(value: string): ShellExpansionRisk {
  let risk: ShellExpansionRisk = 0;
  for (let index = value.indexOf("$"); index >= 0; index = value.indexOf("$", index + 1)) {
    const next = value.charCodeAt(index + 1);
    const current = next === 40 && value.charCodeAt(index + 2) === 40 ? arithmeticRisk(value, index + 3, 41)
      : next === 91 ? arithmeticRisk(value, index + 2, 93)
      : next === 123 ? braceExpansionRisk(value, index + 2) : 0;
    if (current === 2) return 2;
    if (current > risk) risk = current;
  }
  return risk;
}

/** Scan to the balanced closing delimiter (`))` for `$((`); unterminated text is definite. */
function arithmeticRisk(value: string, start: number, close: number): ShellExpansionRisk {
  let depth = 0;
  let named = false;
  let step = false; // `++`/`--` assign when applied to a name, before or after it
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 40) { depth++; continue; }
    if (code === 41 && depth > 0) { depth--; continue; }
    if (code === close) return close === 41 && value.charCodeAt(index + 1) !== 41 ? 2 : named ? (step ? 2 : 1) : 0;
    if (code === 61 && isArithmeticAssignment(value, index)) return 2;
    if ((code === 43 || code === 45) && value.charCodeAt(index + 1) === code) { step = true; index++; continue; }
    if (isQueryVariableDigit(code)) {
      // Numeric literals may carry letters: `0x1F`, `16#ff`.
      while (isQueryVariablePart(value.charCodeAt(index + 1)) || value.charCodeAt(index + 1) === 35 || value.charCodeAt(index + 1) === 64) index++;
      continue;
    }
    if (code === 36) {
      const next = value.charCodeAt(index + 1);
      if (next === 35 || next === 63 || next === 36 || next === 33) { index++; continue; }
      if (!isQueryVariableStart(next)) { named = true; continue; }
      index++;
    } else if (code === 96) { named = true; continue; } else if (!isQueryVariableStart(code)) continue;
    const nameStart = index;
    while (isQueryVariablePart(value.charCodeAt(index + 1))) index++;
    if (!isNumericShellVariable(value.slice(nameStart, index + 1))) named = true;
  }
  return 2;
}

/** Shell-maintained variables whose value is always a number, never an expression. */
function isNumericShellVariable(name: string): boolean {
  return name === "RANDOM" || name === "SRANDOM" || name === "SECONDS" || name === "EPOCHSECONDS" || name === "LINENO"
    || name === "BASHPID" || name === "PPID" || name === "UID" || name === "EUID";
}

function isArithmeticAssignment(value: string, index: number): boolean {
  const before = value.charCodeAt(index - 1);
  return value.charCodeAt(index + 1) !== 61 && before !== 61 && before !== 33 && before !== 60 && before !== 62;
}

function braceExpansionRisk(value: string, start: number): ShellExpansionRisk {
  let index = start;
  let code = value.charCodeAt(index);
  if (code === 33) return value.charCodeAt(index + 1) === 125 ? 0 : 1;
  if (code === 35 && value.charCodeAt(index + 1) !== 125) code = value.charCodeAt(++index);
  if (isQueryVariableStart(code)) {
    while (isQueryVariablePart(value.charCodeAt(index + 1))) index++;
  } else if (isQueryVariableDigit(code)) {
    while (isQueryVariableDigit(value.charCodeAt(index + 1))) index++;
  } else if (!isReadOnlySpecialParameter(code)) return 2; // includes Bash 5.3 `${ cmd; }`
  index++;
  code = value.charCodeAt(index);
  if (code === 125) return 0;
  let risk: ShellExpansionRisk = 0;
  if (code === 91) {
    const subscript = value.charCodeAt(index + 1);
    if ((subscript === 64 || subscript === 42) && value.charCodeAt(index + 2) === 93) index += 3;
    else {
      let cursor = index + 1;
      while (isQueryVariableDigit(value.charCodeAt(cursor))) cursor++;
      if (cursor === index + 1 || value.charCodeAt(cursor) !== 93) {
        risk = arithmeticRisk(value, index + 1, 93);
        if (risk === 2) return 2;
        while (cursor < value.length && value.charCodeAt(cursor) !== 93) cursor++;
      }
      index = cursor + 1;
    }
    code = value.charCodeAt(index);
    if (code === 125) return risk;
  }
  if (code === 61) return 2;
  // `${v@P}` expands the value as a prompt, running its command substitutions.
  if (code === 64) {
    const operator = value.charCodeAt(index + 1);
    return value.charCodeAt(index + 2) === 125 && (operator === 81 || operator === 69 || operator === 65 || operator === 75
      || operator === 97 || operator === 107 || operator === 85 || operator === 117 || operator === 76) ? risk : 2;
  }
  if (code === 58) {
    const operator = value.charCodeAt(index + 1);
    if (operator === 61) return 2;
    // `${v:offset:length}` evaluates both operands arithmetically.
    if (operator !== 45 && operator !== 43 && operator !== 63) {
      const offsetRisk = arithmeticRisk(value, index + 1, 125);
      if (offsetRisk > risk) risk = offsetRisk;
    }
  }
  // Nested expansions inside operator words are scored at their own `$`.
  return risk;
}

/** Query operands may expand simple variables, but operators can mutate Bash state. */
export function hasUnsafeCommandQueryOperand(tokens: readonly string[] & { expansions?: readonly number[] }, start: number): boolean {
  return hasUnsafeExpansionOperand(tokens, start, false);
}

/** Loop lists may also read positional/special parameters without changing shell state. */
export function hasUnsafeBashLoopListOperand(tokens: readonly string[] & { expansions?: readonly number[] }, start: number): boolean {
  return hasUnsafeExpansionOperand(tokens, start, true);
}

function hasUnsafeExpansionOperand(tokens: readonly string[] & { expansions?: readonly number[] }, start: number, allowReadOnlySpecial: boolean): boolean {
  for (let index = start; index < tokens.length; index++) {
    const flags = tokens.expansions?.[index] ?? 0;
    if (flags === 0) continue;
    if ((flags & 4) !== 0 || !hasOnlySimpleQueryVariables(tokens[index]!, allowReadOnlySpecial)) return true;
  }
  return false;
}

/** Bash tests can evaluate arithmetic operands and parameter assignments after quote removal. */
export function hasUnsafeBashTestOperand(tokens: readonly string[] & { bashTestOpenAt?: number; bashTestClosed?: boolean; expansions?: readonly number[] }): boolean {
  const open = tokens.bashTestOpenAt;
  if (open === undefined || !tokens.bashTestClosed) return false;
  for (let index = open + 1; index < tokens.length; index++) {
    const value = tokens[index]!;
    const flags = tokens.expansions?.[index] ?? 0;
    if (flags !== 0 && ((flags & 4) !== 0 || !hasOnlySimpleQueryVariables(value))) return true;
    if (value === "-v" && index + 1 < tokens.length) {
      if (tokens[index + 1]!.includes("[") || (tokens.expansions?.[index + 1] ?? 0) !== 0) return true;
    }
    if (value === "-eq" || value === "-ne" || value === "-lt" || value === "-le" || value === "-gt" || value === "-ge") {
      if (!isBashIntegerLiteral(tokens[index - 1]) || !isBashIntegerLiteral(tokens[index + 1])) return true;
    }
  }
  return false;
}

function isBashIntegerLiteral(value: string | undefined): boolean {
  if (!value) return false;
  let index = value.charCodeAt(0) === 45 || value.charCodeAt(0) === 43 ? 1 : 0;
  if (index === value.length) return false;
  for (; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function hasOnlySimpleQueryVariables(value: string, allowReadOnlySpecial = false): boolean {
  let found = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 96 || code === 123 || code === 125) return false;
    if (code !== 36) continue;
    found = true;
    if (value.charCodeAt(index + 1) === 123) {
      index += 2;
      const first = value.charCodeAt(index);
      if (allowReadOnlySpecial && isReadOnlySpecialParameter(first)) {
        if (first >= 48 && first <= 57) while (isQueryVariableDigit(value.charCodeAt(index + 1))) index++;
      } else {
        if (!isQueryVariableStart(first)) return false;
        while (isQueryVariablePart(value.charCodeAt(index + 1))) index++;
      }
      if (value.charCodeAt(index + 1) !== 125) return false;
      index++;
    } else {
      index++;
      const first = value.charCodeAt(index);
      if (allowReadOnlySpecial && isReadOnlySpecialParameter(first)) continue;
      if (!isQueryVariableStart(first)) return false;
      while (isQueryVariablePart(value.charCodeAt(index + 1))) index++;
    }
  }
  return found;
}

function isQueryVariableStart(code: number): boolean {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isQueryVariablePart(code: number): boolean {
  return isQueryVariableStart(code) || (code >= 48 && code <= 57);
}

function isQueryVariableDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isReadOnlySpecialParameter(code: number): boolean {
  return code === 64 || code === 42 || code === 35 || code === 63 || code === 36
    || code === 45 || code === 33 || isQueryVariableDigit(code);
}

/** argv compaction retains operands after interleaved redirections. Call-owned. */
export function stripShellRedirections(tokens: string[] & { expansions?: number[] }, redirections: readonly number[]): void {
  let output = 0;
  let redirect = 0;
  const expansions = tokens.expansions;
  for (let index = 0; index < tokens.length; index++) {
    if (index === redirections[redirect]) {
      redirect++;
      if (index + 1 < tokens.length && index + 1 !== redirections[redirect]) index++;
    } else {
      tokens[output] = tokens[index]!;
      if (expansions) expansions[output] = expansions[index] ?? 0;
      output++;
    }
  }
  tokens.length = output;
  if (expansions) expansions.length = output;
}
