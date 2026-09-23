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

/** `[[` is a Bash keyword only at a command/test head, not an argv word. */
export function isBashDoubleBracketHead(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean }): boolean {
  if (tokens.length === 0) return true;
  if (tokens.firstWordQuoted) return false;
  const head = tokens[0];
  if (tokens.length === 2) return head === "time" && tokens[1] === "-p" && !tokens.secondWordQuoted;
  if (tokens.length !== 1) return false;
  return head === "time" || head === "if" || head === "elif" || head === "while" || head === "until"
    || head === "then" || head === "else" || head === "do" || head === "!" || head === "{";
}

export function isBashDoubleBracketCloseBoundary(source: string, index: number): boolean {
  if (index >= source.length) return true;
  const code = source.charCodeAt(index);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 59
    || code === 38 || code === 124 || code === 41 || code === 60 || code === 62;
}

/** Find the binding word of an unquoted for/select header. */
export function bashLoopVariableIndex(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean }): number {
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
  if ((index === 0 && tokens.firstWordQuoted) || (index === 1 && tokens.secondWordQuoted)
    || (tokens[index] !== "for" && tokens[index] !== "select")) return -1;
  return index + 1;
}

/** A loop binding or its in-list expansion can change later shell state. */
export function unsafeBashForHeaderReason(tokens: readonly string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean; expansions?: readonly number[] }): "stateful_loop_variable_assignment" | "stateful_loop_list_expansion" | undefined {
  const variableIndex = bashLoopVariableIndex(tokens);
  if (variableIndex < 0) return undefined;
  const variable = tokens[variableIndex];
  if (variable === "PATH" || variable === "BASH_ENV" || variable === "ENV"
    || variable === "SHELLOPTS" || variable === "BASHOPTS" || variable === "CDPATH") return "stateful_loop_variable_assignment";
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
    if (format.charCodeAt(conversion) === 110) return true;
  }
  return false;
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
