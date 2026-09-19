/** Called only outside quotes/escapes. Returns an operator width, never argv. */
export function shellRedirectionLength(source: string, index: number): number {
  const first = source.charCodeAt(index);
  const next = source.charCodeAt(index + 1);
  if (first === 38) return next === 62 ? (source.charCodeAt(index + 2) === 62 ? 3 : 2) : 0;
  if (first !== 62) return 0;
  if (next === 62) return 2;
  return next === 38 || next === 124 ? 2 : 1;
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
