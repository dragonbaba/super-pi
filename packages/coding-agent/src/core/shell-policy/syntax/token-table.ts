/**
 * One dialect's tokens for one source text. PowerShell and cmd words are offsets into
 * the single source string, sliced or decoded only when a consumer fills its word
 * buffer. Bash words are decoded once while lexing (`texts`), because their quoting,
 * ANSI-C, arithmetic and substitution state is the lexer's own; every consumer then
 * shares those strings instead of re-tokenizing the source.
 *
 * Ownership: a table belongs to one authorization (the ShellAnalysisOwner cache) or to
 * one call when no owner exists. Capacity starts small and doubles; a table is never
 * reused for another source, so a large script cannot pin its backing store elsewhere.
 */

export const DIALECT_POWERSHELL = 1, DIALECT_CMD = 2, DIALECT_BASH = 3;

// Expansion bits keep the values the existing scanners use per word.
export const EXPANSION_QUOTED_VARIABLE = 1, EXPANSION_VARIABLE = 2, EXPANSION_SUBSTITUTION = 4,
  EXPANSION_BRACE = 8, EXPANSION_GLOB = 16, EXPANSION_HOME = 32, EXPANSION_MASK = 63;
/** The word begins with a quote: string data, never a parameter name. */
export const WORD_QUOTED = 64;
export const WORD_QUOTED_COMMA = 128, WORD_UNQUOTED_COMMA = 256;
/** The word's text differs from its source slice (quotes or escapes removed). */
export const WORD_DECODE = 512;
/** A redirection operator; its text is the operator and its descriptor is in `fds`/`fdTexts`. */
export const WORD_REDIRECTION = 1024;
/** Quoting, escapes or a substitution made the word non-literal (the scanners' "quoted" word). */
export const WORD_NONLITERAL = 2048;

/** What ends a segment. */
export const SEGMENT_END = 0, SEGMENT_SEQUENCE = 1, SEGMENT_PIPE = 2, SEGMENT_AND = 3, SEGMENT_OR = 4,
  SEGMENT_BACKGROUND = 5, SEGMENT_OPEN = 6, SEGMENT_CLOSE = 7, SEGMENT_LF = 8, SEGMENT_CR = 9;
/** The separator text the Bash scanners compare against; undefined after the last segment. */
export const SEGMENT_SEPARATOR_TEXT: readonly (string | undefined)[] = Object.freeze([undefined, ";", "|", "&&", "||", "&", "(", ")", "\n", "\r"]);

/** Bash per-segment facts. */
export const SEGMENT_PIPELINE_MEMBER = 1, SEGMENT_CONDITIONAL_MEMBER = 2, SEGMENT_SUBSHELL_CLOSED_AFTER = 4,
  SEGMENT_DYNAMIC = 8, SEGMENT_TEST_CLOSED = 16, SEGMENT_TEST_PROCESS_SUBSTITUTION = 32;

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
  /** Bash: decoded word text per token, and a redirection's source descriptor text. */
  texts?: string[];
  fdTexts?: (string | undefined)[];
  segmentCount = 0;
  /** Exclusive token end of each segment; segment n starts at segmentEnds[n - 1]. */
  segmentEnds = new Uint32Array(INITIAL_SEGMENTS);
  segmentSeparators = new Uint8Array(INITIAL_SEGMENTS);
  segmentDepths = new Uint8Array(INITIAL_SEGMENTS);
  /** Source offset after the previous separator, and of this segment's separator. */
  segmentSourceStarts = new Uint32Array(INITIAL_SEGMENTS);
  segmentSourceEnds = new Uint32Array(INITIAL_SEGMENTS);
  segmentMeta = new Uint8Array(INITIAL_SEGMENTS);
  /** Bash `[[` and `((` command positions within the segment, or -1. */
  segmentTestOpen = new Int32Array(INITIAL_SEGMENTS);
  segmentArithmeticAt = new Int32Array(INITIAL_SEGMENTS);
  /** PowerShell `$(...)` and `@(...)` bodies, read as scripts of their own. */
  nestedCount = 0;
  nestedStarts = new Uint32Array(INITIAL_NESTED);
  nestedEnds = new Uint32Array(INITIAL_NESTED);
  /** An unterminated quote, comment or subexpression: the rest was not tokenized normally. */
  unterminated = false;

  constructor(source: string, dialect: number) {
    this.source = source;
    this.dialect = dialect;
    if (dialect === DIALECT_BASH) { this.texts = []; this.fdTexts = []; }
  }

  get byteLength(): number {
    let bytes = 2 * this.source.length + this.starts.byteLength + this.ends.byteLength + this.flags.byteLength + this.fds.byteLength
      + this.segmentEnds.byteLength + this.segmentSeparators.byteLength + this.segmentDepths.byteLength
      + this.segmentSourceStarts.byteLength + this.segmentSourceEnds.byteLength + this.segmentMeta.byteLength
      + this.segmentTestOpen.byteLength + this.segmentArithmeticAt.byteLength
      + this.nestedStarts.byteLength + this.nestedEnds.byteLength;
    const texts = this.texts;
    if (texts) for (let index = 0; index < texts.length; index++) bytes += 2 * texts[index]!.length + 8;
    return bytes;
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

  /** Bash: a word with its decoded text, or a redirection operator with its descriptor text. */
  pushText(start: number, end: number, flags: number, text: string, fdText: string | undefined): void {
    this.texts![this.tokenCount] = text;
    this.fdTexts![this.tokenCount] = fdText;
    this.pushToken(start, end, flags, -1);
  }

  /** Close the current segment; an empty segment only updates the previous separator. */
  endSegment(separator: number, depth: number): void {
    this.closeSegment(separator, depth, 0, 0, 0, -1, -1);
  }

  /** Returns whether a segment was recorded. */
  closeSegment(separator: number, depth: number, sourceStart: number, sourceEnd: number, meta: number, testOpen: number, arithmeticAt: number): boolean {
    const start = this.segmentCount === 0 ? 0 : this.segmentEnds[this.segmentCount - 1]!;
    if (this.tokenCount === start) {
      // A list operator after `)` belongs to the closed command: keep its dependency edge.
      // The end of the script is not an operator, so `(a)` keeps its `)`.
      if (this.segmentCount > 0 && separator !== SEGMENT_END && separator !== SEGMENT_OPEN && separator !== SEGMENT_CLOSE
        && this.segmentSeparators[this.segmentCount - 1] === SEGMENT_CLOSE) this.segmentSeparators[this.segmentCount - 1] = separator;
      return false;
    }
    const index = this.segmentCount;
    if (index === this.segmentEnds.length) this.growSegments();
    this.segmentEnds[index] = this.tokenCount;
    this.segmentSeparators[index] = separator;
    this.segmentDepths[index] = depth > 255 ? 255 : depth;
    this.segmentSourceStarts[index] = sourceStart;
    this.segmentSourceEnds[index] = sourceEnd;
    this.segmentMeta[index] = meta;
    this.segmentTestOpen[index] = testOpen;
    this.segmentArithmeticAt[index] = arithmeticAt;
    this.segmentCount = index + 1;
    return true;
  }

  /** Bash `)`: the last recorded segment inside the closed subshell ends it. */
  markSubshellClosed(depth: number): void {
    const last = this.segmentCount - 1;
    if (last >= 0 && this.segmentDepths[last]! >= depth) this.segmentMeta[last]! |= SEGMENT_SUBSHELL_CLOSED_AFTER;
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

  private growSegments(): void {
    this.segmentEnds = grow32(this.segmentEnds);
    this.segmentSeparators = grow8(this.segmentSeparators);
    this.segmentDepths = grow8(this.segmentDepths);
    this.segmentSourceStarts = grow32(this.segmentSourceStarts);
    this.segmentSourceEnds = grow32(this.segmentSourceEnds);
    this.segmentMeta = grow8(this.segmentMeta);
    const testOpen = new Int32Array(this.segmentTestOpen.length * 2); testOpen.set(this.segmentTestOpen); this.segmentTestOpen = testOpen;
    const arithmetic = new Int32Array(this.segmentArithmeticAt.length * 2); arithmetic.set(this.segmentArithmeticAt); this.segmentArithmeticAt = arithmetic;
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
  bashTestOpenAt?: number; bashTestClosed?: boolean; bashTestProcessSubstitution?: boolean; bashArithmeticCommandAt?: number;
};

// permission-bash per-word flags.
const SCOPE_QUOTED_COMMA = 1, SCOPE_UNQUOTED_COMMA = 2, SCOPE_QUOTED = 4;
const FD_TEXT: readonly string[] = Object.freeze(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/**
 * Refill the caller's reusable word buffer with one segment. Windows word strings are
 * the only allocations (Bash words are already decoded); the side arrays are created
 * once per buffer and only when needed. A PowerShell or cmd null-device redirection
 * target (`$null`, `nul`) reads as `/dev/null`.
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
  const meta = table.segmentMeta[segment]!, testOpen = table.segmentTestOpen[segment]!, arithmeticAt = table.segmentArithmeticAt[segment]!;
  words.bashTestOpenAt = testOpen < 0 ? undefined : testOpen;
  words.bashTestClosed = meta & SEGMENT_TEST_CLOSED ? true : undefined;
  words.bashTestProcessSubstitution = meta & SEGMENT_TEST_PROCESS_SUBSTITUTION ? true : undefined;
  words.bashArithmeticCommandAt = arithmeticAt < 0 ? undefined : arithmeticAt;
  const end = table.segmentEnds[segment]!, texts = table.texts;
  let afterRedirection = false;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!, position = words.length;
    const expansion = flags & EXPANSION_MASK;
    if (flags & WORD_REDIRECTION) {
      // A Bash `{name}` or brace-flagged descriptor word keeps its flags on the operator, as before.
      if (expansion !== 0) (words.expansions ??= [])[position] = expansion;
      (words.redirections ??= []).push(position);
      const fd = table.fds[index]!;
      (words.redirectionFds ??= []).push(texts ? table.fdTexts![index] : fd < 0 ? undefined : FD_TEXT[fd]);
      words.push(texts ? texts[index]! : table.source.slice(table.starts[index]!, table.ends[index]!));
      afterRedirection = true;
      continue;
    }
    const text = texts ? texts[index]! : flags & WORD_DECODE ? decode(table, index) : table.source.slice(table.starts[index]!, table.ends[index]!);
    if (afterRedirection && !texts && isNullDevice(table, text, flags)) {
      words.push("/dev/null");
      afterRedirection = false;
      continue;
    }
    afterRedirection = false;
    words.push(text);
    if (expansion !== 0) (words.expansions ??= [])[position] = expansion;
    const scope = (flags & WORD_QUOTED_COMMA ? SCOPE_QUOTED_COMMA : 0) | (flags & WORD_UNQUOTED_COMMA ? SCOPE_UNQUOTED_COMMA : 0) | (flags & WORD_QUOTED ? SCOPE_QUOTED : 0);
    if (scope !== 0) (words.wordFlags ??= [])[position] = scope;
    // Windows lexers mark decoding and substitution; Bash marks exactly what its lexer saw.
    if (texts ? flags & WORD_NONLITERAL : flags & (WORD_DECODE | EXPANSION_SUBSTITUTION)) {
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
