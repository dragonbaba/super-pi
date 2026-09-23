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
    || head === "then" || head === "do" || head === "!" || head === "{";
}

export function isBashDoubleBracketCloseBoundary(source: string, index: number): boolean {
  if (index >= source.length) return true;
  const code = source.charCodeAt(index);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 59
    || code === 38 || code === 124 || code === 41 || code === 60 || code === 62;
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

/** Query operands may expand simple variables, but operators can mutate Bash state. */
export function hasUnsafeCommandQueryOperand(tokens: readonly string[] & { expansions?: readonly number[] }, start: number): boolean {
  for (let index = start; index < tokens.length; index++) {
    const flags = tokens.expansions?.[index] ?? 0;
    if (flags === 0) continue;
    if ((flags & 4) !== 0 || !hasOnlySimpleQueryVariables(tokens[index]!)) return true;
  }
  return false;
}

/** `[[ -v name[subscript] ]]` evaluates the subscript as arithmetic, even when quoted. */
export function hasBashTestArraySubscript(tokens: readonly string[] & { bashTestOpenAt?: number; bashTestClosed?: boolean; expansions?: readonly number[] }): boolean {
  const open = tokens.bashTestOpenAt;
  if (open === undefined || !tokens.bashTestClosed) return false;
  for (let index = open + 1; index + 1 < tokens.length; index++) {
    if (tokens[index] !== "-v") continue;
    const operand = tokens[index + 1]!;
    if (operand.includes("[") || (tokens.expansions?.[index + 1] ?? 0) !== 0) return true;
  }
  return false;
}

function hasOnlySimpleQueryVariables(value: string): boolean {
  let found = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 96 || code === 123 || code === 125) return false;
    if (code !== 36) continue;
    found = true;
    if (value.charCodeAt(index + 1) === 123) {
      index += 2;
      if (!isQueryVariableStart(value.charCodeAt(index))) return false;
      while (isQueryVariablePart(value.charCodeAt(index + 1))) index++;
      if (value.charCodeAt(index + 1) !== 125) return false;
      index++;
    } else {
      index++;
      if (!isQueryVariableStart(value.charCodeAt(index))) return false;
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
