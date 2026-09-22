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
export function isBashDoubleBracketHead(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  if (tokens.length !== 1) return false;
  const head = tokens[0];
  return head === "if" || head === "elif" || head === "while" || head === "until"
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

/** argv compaction retains operands after interleaved redirections. Call-owned. */
export function stripShellRedirections(tokens: string[], redirections: readonly number[]): void {
  let output = 0;
  let redirect = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (index === redirections[redirect]) {
      redirect++;
      if (index + 1 < tokens.length && index + 1 !== redirections[redirect]) index++;
    } else tokens[output++] = tokens[index]!;
  }
  tokens.length = output;
}
