import { commandSubstitutionEnd } from "../shell-substitution.ts";
import {
  isBashDoubleBracketCloseBoundary, isBashDoubleBracketHead, isBashProcessSubstitutionStart, isBashTestWhitespace,
  isShellDynamicDescriptor, isShellFileDescriptor, isSimpleBashAnsiCQuote, shellRedirectionLength,
} from "../shell-redirection.ts";
import {
  DIALECT_BASH, EXPANSION_MASK, fillSegmentWords, SEGMENT_AND, SEGMENT_BACKGROUND, SEGMENT_CLOSE, SEGMENT_CONDITIONAL_MEMBER, SEGMENT_CR, SEGMENT_DYNAMIC,
  SEGMENT_END, SEGMENT_LF, SEGMENT_OPEN, SEGMENT_OR, SEGMENT_PIPE, SEGMENT_PIPELINE_MEMBER, SEGMENT_SEQUENCE,
  SEGMENT_TEST_CLOSED, SEGMENT_TEST_PROCESS_SUBSTITUTION, ShellTokenTable, WORD_NONLITERAL, WORD_QUOTED, WORD_QUOTED_COMMA,
  WORD_REDIRECTION, WORD_UNQUOTED_COMMA, type SegmentWords,
} from "./token-table.ts";

/** Number of Bash tokenizations, for the parse-once evidence. */
export const bashLexerCounters = { lexes: 0 };

/** Words of the segment being lexed, for the `[[` head check. */
type HeadWords = string[] & { firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean };
/** Reused by every lex: lexBash is synchronous and never re-enters, and it clears this before returning. */
const HEAD: HeadWords = [];

function clearHead(head: HeadWords): void {
  head.length = 0;
  head.firstWordQuoted = undefined;
  head.secondWordQuoted = undefined;
  head.thirdWordQuoted = undefined;
}

/**
 * The Bash rules both scanners used to apply with their own copies of this loop: quotes,
 * backslash escapes and line continuation, simple `$'...'`, `$(...)` kept inside its word,
 * `((`/`$((`, `[[ ]]`, comments, redirections with their source descriptor, and list,
 * pipeline and subshell separators. Per-word expansion bits keep the core scanner's values;
 * comma and leading-quote flags serve the permission scanner.
 */
export function lexBash(command: string): ShellTokenTable {
  bashLexerCounters.lexes++;
  const table = new ShellTokenTable(command, DIALECT_BASH);
  const head = HEAD;
  clearHead(head);
  let value = "", tokenStarted = false, quote = 0, ansiC = false, arithmeticDepth = 0, escaped = false, literalWord = true;
  let redirectionTargetPending = false, subshellDepth = 0, bashDoubleBracket = false, flags = 0, wordStart = 0;
  let sourceStart = 0, segmentDepth = 0, meta = 0, testOpen = -1, arithmeticAt = -1;
  for (let index = 0; index < command.length; index++) {
    if (!tokenStarted) wordStart = index;
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
      // Double quotes only remove backslash before $, `, ", backslash or LF.
      if (quote === 34 && next !== 36 && next !== 96 && next !== 34 && next !== 92) {
        value += "\\"; tokenStarted = true; continue;
      }
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote === 0 && code === 36 && isSimpleBashAnsiCQuote(command, index)) {
      quote = 39; ansiC = true; literalWord = false; tokenStarted = true; index++; continue;
    }
    if (quote !== 39 && (code === 36 || code === 96)) {
      meta |= SEGMENT_DYNAMIC;
      flags |= code === 96 || command.charCodeAt(index + 1) === 40 ? 4 : quote === 34 ? 1 : 2;
    }
    // A substitution stays part of this argv word; its body is inspected as its own script.
    if (quote !== 39 && code === 36 && command.charCodeAt(index + 1) === 40 && command.charCodeAt(index + 2) !== 40) {
      const end = commandSubstitutionEnd(command, index);
      if (end >= 0) {
        value += command.slice(index, end + 1);
        tokenStarted = true;
        literalWord = false;
        index = end;
        continue;
      }
    }
    // Unquoted braces can expand one apparent word into several.
    if (quote === 0 && (code === 123 || code === 125)) flags |= 8;
    if (quote === 0 && !tokenStarted && code === 126) flags |= 32;
    if (quote === 0 && !bashDoubleBracket && (code === 42 || code === 63
      || code === 91 && command.charCodeAt(index + 1) !== 91 && !isBashTestWhitespace(command.charCodeAt(index + 1)))) flags |= 16;
    if (quote !== 0) {
      // Decode the \n, \r and \t escapes a simple $'...' quote may contain, as Bash does,
      // so a path operand names the real file rather than its escaped spelling.
      if (ansiC && code === 92) {
        const escape = command.charCodeAt(++index);
        value += escape === 110 ? "\n" : escape === 114 ? "\r" : "\t";
        continue;
      }
      if (code === quote) { quote = 0; ansiC = false; }
      else {
        if (code === 44) flags |= WORD_QUOTED_COMMA;
        value += command[index];
      }
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
      if (arithmeticDepth === 0 && !tokenStarted && !redirectionTargetPending) arithmeticAt = head.length;
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
      // Only a word that begins with a quote is string data; `-Path:"x"` quotes just its value.
      if (!tokenStarted) flags |= WORD_QUOTED;
      literalWord = false;
      tokenStarted = true;
      continue;
    }
    if (code === 32 || code === 9 || (bashDoubleBracket && isBashTestWhitespace(code))) {
      if (tokenStarted) {
        pushWord(table, head, wordStart, index, literalWord ? flags : flags | WORD_NONLITERAL, value);
        redirectionTargetPending = false;
        value = "";
        tokenStarted = false;
        literalWord = true;
        flags = 0;
      }
      continue;
    }
    if (code === 35 && !tokenStarted) {
      while (index < command.length && command.charCodeAt(index) !== 10 && command.charCodeAt(index) !== 13) index++;
      if (index >= command.length) break;
      index--; continue;
    }
    if (!bashDoubleBracket && code === 91 && command.charCodeAt(index + 1) === 91 && !tokenStarted
      && isBashDoubleBracketHead(head) && isBashTestWhitespace(command.charCodeAt(index + 2))) {
      testOpen = head.length;
      value = "[["; tokenStarted = true; bashDoubleBracket = true; index++; continue;
    }
    if (bashDoubleBracket && code === 93 && command.charCodeAt(index + 1) === 93 && !tokenStarted
      && isBashDoubleBracketCloseBoundary(command, index + 2)) {
      meta |= SEGMENT_TEST_CLOSED;
      value = "]]"; tokenStarted = true; bashDoubleBracket = false; index++; continue;
    }
    if (bashDoubleBracket && isBashProcessSubstitutionStart(command, index)) meta |= SEGMENT_TEST_PROCESS_SUBSTITUTION;
    const redirectionWidth = bashDoubleBracket ? 0 : shellRedirectionLength(command, index);
    if (redirectionWidth > 0) {
      const sourceFd = !redirectionTargetPending && literalWord && (isShellFileDescriptor(value) || isShellDynamicDescriptor(value)) ? value : undefined;
      let operatorFlags = WORD_REDIRECTION;
      if (tokenStarted && !sourceFd) pushWord(table, head, wordStart, index, literalWord ? flags : flags | WORD_NONLITERAL, value);
      // A descriptor word is not argv; its expansion bits stay with the operator, as before.
      else operatorFlags |= flags & 63;
      flags = 0;
      const operator = command.slice(index, index + redirectionWidth);
      table.pushText(index, index + redirectionWidth, operatorFlags, operator, sourceFd);
      head.push(operator);
      redirectionTargetPending = true;
      index += redirectionWidth - 1;
      value = "";
      tokenStarted = false;
      literalWord = true;
      continue;
    }
    if (code === 10 || code === 13 || code === 59 || code === 38 || code === 124 || code === 40 || code === 41) {
      if (bashDoubleBracket) { value += command[index]; tokenStarted = true; continue; }
      if (tokenStarted) pushWord(table, head, wordStart, index, literalWord ? flags : flags | WORD_NONLITERAL, value);
      const next = command.charCodeAt(index + 1);
      const pipeline = code === 124 && next !== 124;
      const conditional = (code === 38 || code === 124) && next === code;
      if (pipeline) meta |= SEGMENT_PIPELINE_MEMBER;
      if (conditional) meta |= SEGMENT_CONDITIONAL_MEMBER;
      const separator = conditional ? (code === 38 ? SEGMENT_AND : SEGMENT_OR)
        : code === 10 ? SEGMENT_LF : code === 13 ? SEGMENT_CR : code === 59 ? SEGMENT_SEQUENCE
        : code === 38 ? SEGMENT_BACKGROUND : code === 124 ? SEGMENT_PIPE : code === 40 ? SEGMENT_OPEN : SEGMENT_CLOSE;
      table.closeSegment(separator, segmentDepth, sourceStart, index, meta, testOpen, arithmeticAt);
      if (code === 40) subshellDepth++;
      else if (code === 41 && subshellDepth > 0) { table.markSubshellClosed(subshellDepth); subshellDepth--; }
      segmentDepth = subshellDepth;
      meta = (pipeline ? SEGMENT_PIPELINE_MEMBER : 0) | (conditional ? SEGMENT_CONDITIONAL_MEMBER : 0);
      testOpen = -1;
      arithmeticAt = -1;
      clearHead(head);
      literalWord = true;
      value = "";
      tokenStarted = false;
      redirectionTargetPending = false;
      flags = 0;
      if ((code === 38 || code === 124) && next === code) index++;
      // The next segment starts after the whole operator, `&&` and `||` included.
      sourceStart = index + 1;
      continue;
    }
    if (code === 44) flags |= WORD_UNQUOTED_COMMA;
    value += command[index];
    tokenStarted = true;
  }
  if (tokenStarted) pushWord(table, head, wordStart, command.length, literalWord ? flags : flags | WORD_NONLITERAL, value);
  table.closeSegment(SEGMENT_END, segmentDepth, sourceStart, command.length, meta, testOpen, arithmeticAt);
  if (quote !== 0 || escaped) table.unterminated = true;
  // Release the word references so the scratch never pins a source.
  clearHead(head);
  return table;
}

function pushWord(table: ShellTokenTable, head: HeadWords, start: number, end: number, flags: number, text: string): void {
  const position = head.length;
  if (flags & WORD_NONLITERAL) {
    if (position === 0) head.firstWordQuoted = true;
    else if (position === 1) head.secondWordQuoted = true;
    else if (position === 2) head.thirdWordQuoted = true;
  }
  head.push(text);
  table.pushText(start, end, flags, text, undefined);
}

/** Bash words are decoded while lexing; the fill never decodes. */
function bashWordText(table: ShellTokenTable, index: number): string {
  return table.texts![index]!;
}

/** Refill a scanner's reusable word buffer with one segment of a Bash table. */
export function fillBashSegment(table: ShellTokenTable, segment: number, words: SegmentWords): void {
  fillSegmentWords(table, segment, words, bashWordText);
}

/**
 * One segment as a new array for a caller that keeps segments side by side and strips
 * redirections in place. Only the facts the segment has are set, in a fixed order, so
 * every array keeps one shape; the strings are the table's.
 */
export function newBashSegment(table: ShellTokenTable, segment: number): SegmentWords {
  const words: SegmentWords = [];
  const end = table.segmentEnds[segment]!, texts = table.texts!, fdTexts = table.fdTexts!;
  for (let index = table.segmentStart(segment); index < end; index++) {
    const flags = table.flags[index]!, position = words.length, expansion = flags & EXPANSION_MASK;
    if (expansion !== 0) (words.expansions ??= [])[position] = expansion;
    if (flags & WORD_REDIRECTION) {
      (words.redirections ??= []).push(position);
      (words.redirectionFds ??= []).push(fdTexts[index]);
    } else if (flags & WORD_NONLITERAL) {
      if (position === 0) words.firstWordQuoted = true;
      else if (position === 1) words.secondWordQuoted = true;
      else if (position === 2) words.thirdWordQuoted = true;
    }
    words.push(texts[index]!);
  }
  const meta = table.segmentMeta[segment]!, testOpen = table.segmentTestOpen[segment]!, arithmeticAt = table.segmentArithmeticAt[segment]!;
  if (testOpen >= 0) words.bashTestOpenAt = testOpen;
  if (meta & SEGMENT_TEST_CLOSED) words.bashTestClosed = true;
  if (meta & SEGMENT_TEST_PROCESS_SUBSTITUTION) words.bashTestProcessSubstitution = true;
  if (arithmeticAt >= 0) words.bashArithmeticCommandAt = arithmeticAt;
  return words;
}
