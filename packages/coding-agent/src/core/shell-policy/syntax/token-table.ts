/**
 * One dialect's tokens for one source text. Words are offsets into the single source
 * string; their text is sliced (or decoded) only when a consumer asks for it.
 *
 * Ownership: a table belongs to one authorization (the ShellAnalysisOwner cache) or to
 * one call when no owner exists. Capacity starts small and doubles; a table is never
 * reused for another source, so a large script cannot pin its backing store elsewhere.
 */

export const DIALECT_POWERSHELL = 1, DIALECT_CMD = 2;

// Expansion bits keep the values the existing scanners use per word.
export const EXPANSION_QUOTED_VARIABLE = 1, EXPANSION_VARIABLE = 2, EXPANSION_SUBSTITUTION = 4,
  EXPANSION_BRACE = 8, EXPANSION_GLOB = 16, EXPANSION_HOME = 32, EXPANSION_MASK = 63;
/** The word begins with a quote: string data, never a parameter name. */
export const WORD_QUOTED = 64;
export const WORD_QUOTED_COMMA = 128, WORD_UNQUOTED_COMMA = 256;
/** The word's text differs from its source slice (quotes or escapes removed). */
export const WORD_DECODE = 512;
/** A redirection operator; its text is the operator and `fds` holds the source descriptor. */
export const WORD_REDIRECTION = 1024;

/** What ends a segment. */
export const SEGMENT_END = 0, SEGMENT_SEQUENCE = 1, SEGMENT_PIPE = 2, SEGMENT_AND = 3, SEGMENT_OR = 4,
  SEGMENT_BACKGROUND = 5, SEGMENT_OPEN = 6, SEGMENT_CLOSE = 7;

const INITIAL_TOKENS = 16, INITIAL_SEGMENTS = 4, INITIAL_NESTED = 2;

export class ShellTokenTable {
  readonly dialect: number;
  readonly source: string;
  tokenCount = 0;
  starts = new Uint32Array(INITIAL_TOKENS);
  ends = new Uint32Array(INITIAL_TOKENS);
  flags = new Uint16Array(INITIAL_TOKENS);
  /** Redirection source descriptor (0-9), or -1. */
  fds = new Int8Array(INITIAL_TOKENS);
  segmentCount = 0;
  /** Exclusive token end of each segment; segment n starts at segmentEnds[n - 1]. */
  segmentEnds = new Uint32Array(INITIAL_SEGMENTS);
  segmentSeparators = new Uint8Array(INITIAL_SEGMENTS);
  segmentDepths = new Uint8Array(INITIAL_SEGMENTS);
  /** PowerShell `$(...)` and `@(...)` bodies, read as scripts of their own. */
  nestedCount = 0;
  nestedStarts = new Uint32Array(INITIAL_NESTED);
  nestedEnds = new Uint32Array(INITIAL_NESTED);
  /** An unterminated quote, comment or subexpression: the rest was not tokenized normally. */
  unterminated = false;

  constructor(source: string, dialect: number) {
    this.source = source;
    this.dialect = dialect;
  }

  get byteLength(): number {
    return 2 * this.source.length + this.starts.byteLength + this.ends.byteLength + this.flags.byteLength + this.fds.byteLength
      + this.segmentEnds.byteLength + this.segmentSeparators.byteLength + this.segmentDepths.byteLength
      + this.nestedStarts.byteLength + this.nestedEnds.byteLength;
  }

  pushToken(start: number, end: number, flags: number, fd: number): void {
    const index = this.tokenCount;
    if (index === this.starts.length) this.growTokens();
    this.starts[index] = start;
    this.ends[index] = end;
    this.flags[index] = flags;
    this.fds[index] = fd;
    this.tokenCount = index + 1;
  }

  /** Close the current segment; an empty segment only updates the previous separator. */
  endSegment(separator: number, depth: number): void {
    const start = this.segmentCount === 0 ? 0 : this.segmentEnds[this.segmentCount - 1]!;
    if (this.tokenCount === start) {
      if (this.segmentCount > 0 && separator !== SEGMENT_OPEN && separator !== SEGMENT_CLOSE
        && this.segmentSeparators[this.segmentCount - 1] === SEGMENT_CLOSE) this.segmentSeparators[this.segmentCount - 1] = separator;
      return;
    }
    const index = this.segmentCount;
    if (index === this.segmentEnds.length) {
      this.segmentEnds = grow32(this.segmentEnds);
      this.segmentSeparators = grow8(this.segmentSeparators);
      this.segmentDepths = grow8(this.segmentDepths);
    }
    this.segmentEnds[index] = this.tokenCount;
    this.segmentSeparators[index] = separator;
    this.segmentDepths[index] = depth > 255 ? 255 : depth;
    this.segmentCount = index + 1;
  }

  pushNested(start: number, end: number): void {
    const index = this.nestedCount;
    if (index === this.nestedStarts.length) {
      this.nestedStarts = grow32(this.nestedStarts);
      this.nestedEnds = grow32(this.nestedEnds);
    }
    this.nestedStarts[index] = start;
    this.nestedEnds[index] = end;
    this.nestedCount = index + 1;
  }

  segmentStart(segment: number): number {
    return segment === 0 ? 0 : this.segmentEnds[segment - 1]!;
  }

  private growTokens(): void {
    this.starts = grow32(this.starts);
    this.ends = grow32(this.ends);
    const flags = new Uint16Array(this.flags.length * 2); flags.set(this.flags); this.flags = flags;
    const fds = new Int8Array(this.fds.length * 2); fds.set(this.fds); this.fds = fds;
  }
}

function grow32(values: Uint32Array<ArrayBuffer>): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(values.length * 2); grown.set(values); return grown;
}

function grow8(values: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(values.length * 2); grown.set(values); return grown;
}

/** Words of one segment in the shape the existing scanners read. */
export type SegmentWords = string[] & {
  expansions?: number[]; wordFlags?: number[]; redirections?: number[]; redirectionFds?: (string | undefined)[];
  firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean;
};

// permission-bash per-word flags.
const SCOPE_QUOTED_COMMA = 1, SCOPE_UNQUOTED_COMMA = 2, SCOPE_QUOTED = 4;
const FD_TEXT: readonly string[] = Object.freeze(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/**
 * Refill the caller's reusable word buffer with one segment. Word strings are the only
 * allocations; the side arrays are created once per buffer and only when needed.
 * A null-device redirection target (`$null`, `nul`) reads as `/dev/null`.
 */
export function fillSegmentWords(table: ShellTokenTable, segment: number, words: SegmentWords, decode: (table: ShellTokenTable, index: number) => string): void {
  words.length = 0;
  if (words.expansions) words.expansions.length = 0;
  if (words.wordFlags) words.wordFlags.length = 0;
  if (words.redirections) words.redirections.length = 0;
  if (words.redirectionFds) words.redirectionFds.length = 0;
  words.firstWordQuoted = undefined;
  words.secondWordQuoted = undefined;
  words.thirdWordQuoted = undefined;
  const end = table.segmentEnds[segment]!;
  let afterRedirection = false;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!, position = words.length;
    if (flags & WORD_REDIRECTION) {
      (words.redirections ??= []).push(position);
      const fd = table.fds[index]!;
      (words.redirectionFds ??= []).push(fd < 0 ? undefined : FD_TEXT[fd]);
      words.push(table.source.slice(table.starts[index]!, table.ends[index]!));
      afterRedirection = true;
      continue;
    }
    const text = flags & WORD_DECODE ? decode(table, index) : table.source.slice(table.starts[index]!, table.ends[index]!);
    if (afterRedirection && isNullDevice(table, text, flags)) { words.push("/dev/null"); afterRedirection = false; continue; }
    afterRedirection = false;
    words.push(text);
    const expansion = flags & EXPANSION_MASK;
    if (expansion !== 0) (words.expansions ??= [])[position] = expansion;
    const scope = (flags & WORD_QUOTED_COMMA ? SCOPE_QUOTED_COMMA : 0) | (flags & WORD_UNQUOTED_COMMA ? SCOPE_UNQUOTED_COMMA : 0) | (flags & WORD_QUOTED ? SCOPE_QUOTED : 0);
    if (scope !== 0) (words.wordFlags ??= [])[position] = scope;
    // As the Bash lexers do: quotes, escapes and substitutions make a word non-literal.
    if (flags & (WORD_DECODE | EXPANSION_SUBSTITUTION)) {
      if (position === 0) words.firstWordQuoted = true;
      else if (position === 1) words.secondWordQuoted = true;
      else if (position === 2) words.thirdWordQuoted = true;
    }
  }
}

function isNullDevice(table: ShellTokenTable, text: string, flags: number): boolean {
  if (table.dialect === DIALECT_POWERSHELL) return (flags & WORD_DECODE) === 0 && text.length === 5 && text.toLowerCase() === "$null";
  return text.length === 3 && text.toLowerCase() === "nul";
}
