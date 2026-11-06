import {
  DIALECT_POWERSHELL, EXPANSION_BRACE, EXPANSION_GLOB, EXPANSION_HOME, EXPANSION_QUOTED_VARIABLE, EXPANSION_SUBSTITUTION,
  EXPANSION_VARIABLE, SEGMENT_AND, SEGMENT_BACKGROUND, SEGMENT_CLOSE, SEGMENT_END, SEGMENT_OPEN, SEGMENT_OR, SEGMENT_PIPE,
  SEGMENT_SEQUENCE, ShellTokenTable, WORD_DECODE, WORD_QUOTED, WORD_QUOTED_COMMA, WORD_REDIRECTION, WORD_UNQUOTED_COMMA,
} from "./token-table.ts";

/*
 * PowerShell command-mode tokens: backtick escapes, `'...'` with `''`, `"..."` with
 * backtick and `""`, here-strings, `#` and `<# #>` comments, `;`/newline/`|`/`&&`/`||`
 * segments, `n>`/`*>` redirections, and `$(...)`/`@(...)` bodies as nested scripts.
 * A backslash is an ordinary path character. Not modeled (reads as plain words):
 * typographic quotes, `--%` stop-parsing, script-block structure.
 */

const TAB = 9, LF = 10, FF = 12, CR = 13, SPACE = 32, DQ = 34, HASH = 35, DOLLAR = 36, AMP = 38, SQ = 39, LPAREN = 40, RPAREN = 41,
  STAR = 42, COMMA = 44, SEMI = 59, LT = 60, GT = 62, QMARK = 63, AT = 64, LBRACKET = 91, CARET = 94, UNDERSCORE = 95, BACKTICK = 96,
  LBRACE = 123, PIPE = 124, RBRACE = 125, TILDE = 126, NBSP = 160;
/** Deeper `$(` nesting is left unterminated (and so uncertain) instead of recursing further. */
const MAX_NESTING = 32;

export function lexPowerShell(source: string): ShellTokenTable {
  const table = new ShellTokenTable(source, DIALECT_POWERSHELL);
  const length = source.length;
  let depth = 0, index = 0;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isBlank(code)) { index++; continue; }
    if (code === BACKTICK && isLineBreak(source.charCodeAt(index + 1))) { index = afterLineBreak(source, index + 1); continue; }
    if (code === HASH) { index = lineEnd(source, index); continue; }
    if (code === LT && source.charCodeAt(index + 1) === HASH) {
      const close = source.indexOf("#>", index + 2);
      if (close < 0) { table.unterminated = true; break; }
      index = close + 2; continue;
    }
    if (code === LF || code === CR || code === SEMI) { table.endSegment(SEGMENT_SEQUENCE, depth); index++; continue; }
    if (code === PIPE) {
      const double = source.charCodeAt(index + 1) === PIPE;
      table.endSegment(double ? SEGMENT_OR : SEGMENT_PIPE, depth); index += double ? 2 : 1; continue;
    }
    if (code === AMP) {
      if (source.charCodeAt(index + 1) === AMP) { table.endSegment(SEGMENT_AND, depth); index += 2; continue; }
      // `&` before a command is the call operator; after one it starts a background job.
      if (table.tokenCount !== table.segmentStart(table.segmentCount)) table.endSegment(SEGMENT_BACKGROUND, depth);
      index++; continue;
    }
    if (code === LPAREN) { table.endSegment(SEGMENT_OPEN, depth); depth++; index++; continue; }
    if (code === RPAREN) { table.endSegment(SEGMENT_CLOSE, depth); if (depth > 0) depth--; index++; continue; }
    const redirection = lexRedirection(source, index, table);
    if (redirection > 0) { index = redirection; continue; }
    index = lexWord(source, index, table);
    if (index < 0) { table.unterminated = true; break; }
  }
  table.endSegment(SEGMENT_END, depth);
  return table;
}

function isBlank(code: number): boolean {
  return code === SPACE || code === TAB || code === FF || code === NBSP;
}

function isLineBreak(code: number): boolean {
  return code === LF || code === CR;
}

function afterLineBreak(source: string, index: number): number {
  return source.charCodeAt(index) === CR && source.charCodeAt(index + 1) === LF ? index + 2 : index + 1;
}

function lineEnd(source: string, index: number): number {
  while (index < source.length && !isLineBreak(source.charCodeAt(index))) index++;
  return index;
}

function isWordEnd(code: number): boolean {
  return isBlank(code) || code === LF || code === CR || code === SEMI || code === PIPE || code === AMP
    || code === LPAREN || code === RPAREN || code === GT || code === LT;
}

function isVariableStart(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57
    || code === UNDERSCORE || code === QMARK || code === DOLLAR || code === CARET || code > 127;
}

/** `>`, `>>`, `n>`, `n>>`, `n>&m`, `*>`, `*>>` and `<`, at a token start. Returns the end or 0. */
function lexRedirection(source: string, index: number, table: ShellTokenTable): number {
  let code = source.charCodeAt(index), fd = -1, operator = index;
  if (code === STAR || code >= 49 && code <= 54) {
    if (source.charCodeAt(index + 1) !== GT) return 0;
    if (code !== STAR) fd = code - 48;
    operator = index + 1; code = GT;
  } else if (code !== GT && code !== LT) return 0;
  let end = operator + 1;
  if (code === GT) {
    const next = source.charCodeAt(end);
    if (next === GT) end++;
    else if (next === AMP) end++;
  }
  table.pushToken(operator, end, WORD_REDIRECTION, fd);
  return end;
}

/** Returns the index after the word, or -1 when a quote or subexpression is unterminated. */
function lexWord(source: string, start: number, table: ShellTokenTable): number {
  const length = source.length;
  const first = source.charCodeAt(start);
  if (first === AT && (source.charCodeAt(start + 1) === SQ || source.charCodeAt(start + 1) === DQ)) {
    const end = hereStringEnd(source, start);
    if (end === -1) return -1;
    if (end > 0) {
      let flags = WORD_QUOTED | WORD_DECODE;
      if (source.charCodeAt(start + 1) === DQ) flags |= markDoubleQuoted(source, start + 2, end - 2, table);
      table.pushToken(start, end, flags, -1);
      return end;
    }
  }
  let index = start, flags = first === TILDE ? EXPANSION_HOME : 0;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isWordEnd(code)) break;
    if (code === SQ) {
      if (index === start) flags |= WORD_QUOTED;
      flags |= WORD_DECODE;
      const close = singleQuoteClose(source, index + 1);
      if (close < 0) return -1;
      for (let cursor = index + 1; cursor < close; cursor++) if (source.charCodeAt(cursor) === COMMA) { flags |= WORD_QUOTED_COMMA; break; }
      index = close + 1; continue;
    }
    if (code === DQ) {
      if (index === start) flags |= WORD_QUOTED;
      flags |= WORD_DECODE;
      const close = doubleQuoteClose(source, index + 1, 0);
      if (close < 0) return -1;
      flags |= markDoubleQuoted(source, index + 1, close, table);
      index = close + 1; continue;
    }
    if (code === BACKTICK) {
      if (isLineBreak(source.charCodeAt(index + 1))) break; // a continuation ends the word
      if (index + 1 >= length) return -1;
      flags |= WORD_DECODE; index += 2; continue;
    }
    if ((code === DOLLAR || code === AT) && source.charCodeAt(index + 1) === LPAREN) {
      const close = subexpressionEnd(source, index + 1, 0);
      if (close < 0) return -1;
      table.pushNested(index + 2, close);
      flags |= EXPANSION_SUBSTITUTION; index = close + 1; continue;
    }
    if (code === DOLLAR && source.charCodeAt(index + 1) === LBRACE) {
      const close = source.indexOf("}", index + 2);
      if (close < 0) return -1;
      flags |= EXPANSION_VARIABLE; index = close + 1; continue;
    }
    if ((code === DOLLAR || code === AT) && isVariableStart(source.charCodeAt(index + 1))) flags |= EXPANSION_VARIABLE;
    else if (code === LBRACE || code === RBRACE) flags |= EXPANSION_BRACE;
    else if (code === STAR || code === QMARK || code === LBRACKET) flags |= EXPANSION_GLOB;
    else if (code === COMMA) flags |= WORD_UNQUOTED_COMMA;
    index++;
  }
  table.pushToken(start, index, flags, -1);
  return index;
}

/** Flags and nested bodies of a double-quoted range [start, end). */
function markDoubleQuoted(source: string, start: number, end: number, table: ShellTokenTable): number {
  let flags = 0;
  for (let index = start; index < end; index++) {
    const code = source.charCodeAt(index);
    if (code === BACKTICK) { index++; continue; }
    if (code === COMMA) flags |= WORD_QUOTED_COMMA;
    else if (code === DOLLAR) {
      const next = source.charCodeAt(index + 1);
      if (next === LPAREN) {
        const close = subexpressionEnd(source, index + 1, 0);
        if (close < 0 || close >= end) return flags | EXPANSION_SUBSTITUTION;
        table.pushNested(index + 2, close);
        flags |= EXPANSION_SUBSTITUTION; index = close;
      } else if (isVariableStart(next) || next === LBRACE) flags |= EXPANSION_QUOTED_VARIABLE;
    }
  }
  return flags;
}

function singleQuoteClose(source: string, index: number): number {
  for (; index < source.length; index++) {
    if (source.charCodeAt(index) !== SQ) continue;
    if (source.charCodeAt(index + 1) !== SQ) return index;
    index++;
  }
  return -1;
}

function doubleQuoteClose(source: string, index: number, nesting: number): number {
  for (; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === BACKTICK) index++;
    else if (code === DQ) {
      if (source.charCodeAt(index + 1) !== DQ) return index;
      index++;
    } else if (code === DOLLAR && source.charCodeAt(index + 1) === LPAREN) {
      const close = subexpressionEnd(source, index + 1, nesting + 1);
      if (close < 0) return -1;
      index = close;
    }
  }
  return -1;
}

/** Index of the `)` matching the `(` at `open`, skipping quoted text; -1 if none. */
export function subexpressionEnd(source: string, open: number, nesting: number): number {
  if (nesting > MAX_NESTING) return -1;
  let depth = 1;
  for (let index = open + 1; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === BACKTICK) index++;
    else if (code === SQ) { index = singleQuoteClose(source, index + 1); if (index < 0) return -1; }
    else if (code === DQ) { index = doubleQuoteClose(source, index + 1, nesting); if (index < 0) return -1; }
    else if (code === LPAREN) depth++;
    else if (code === RPAREN && --depth === 0) return index;
  }
  return -1;
}

/**
 * `@'` or `@"` ending its line opens a here-string, closed by `'@`/`"@` at a line start.
 * Returns the index after the closing pair, 0 when this is not a here-string, -1 if unclosed.
 */
function hereStringEnd(source: string, start: number): number {
  const quote = source.charCodeAt(start + 1);
  let index = start + 2;
  while (isBlank(source.charCodeAt(index))) index++;
  if (!isLineBreak(source.charCodeAt(index))) return 0;
  for (index = afterLineBreak(source, index); index < source.length; index = afterLineBreak(source, index)) {
    if (source.charCodeAt(index) === quote && source.charCodeAt(index + 1) === AT) return index + 2;
    index = lineEnd(source, index);
    if (index >= source.length) break;
  }
  return -1;
}

/** Text of a PowerShell word with quotes and escapes removed; substitutions stay as written. */
export function decodePowerShellWord(source: string, start: number, end: number): string {
  if (source.charCodeAt(start) === AT && source.charCodeAt(end - 1) === AT && end - start >= 4) {
    const quote = source.charCodeAt(start + 1);
    if (quote === SQ || quote === DQ) return decodeHereString(source, start, end, quote);
  }
  let text = "", chunk = start, index = start;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (code === SQ) {
      text += source.slice(chunk, index);
      // The lexer proved this quote closes inside the word; `''` is one quote.
      let cursor = index + 1;
      for (;;) {
        const close = source.indexOf("'", cursor);
        text += source.slice(cursor, close);
        if (source.charCodeAt(close + 1) !== SQ) { index = close + 1; break; }
        text += "'"; cursor = close + 2;
      }
      chunk = index; continue;
    }
    if (code === DQ) {
      text += source.slice(chunk, index);
      const close = doubleQuoteClose(source, index + 1, 0);
      text += decodeDoubleQuoted(source, index + 1, close, true);
      index = close + 1; chunk = index; continue;
    }
    if (code === BACKTICK) {
      text += source.slice(chunk, index) + source[index + 1];
      index += 2; chunk = index; continue;
    }
    if ((code === DOLLAR || code === AT) && source.charCodeAt(index + 1) === LPAREN) {
      index = subexpressionEnd(source, index + 1, 0) + 1; continue;
    }
    index++;
  }
  return chunk === start ? source.slice(start, end) : text + source.slice(chunk, end);
}

function decodeHereString(source: string, start: number, end: number, quote: number): string {
  let body = start + 2;
  while (isBlank(source.charCodeAt(body))) body++;
  body = afterLineBreak(source, body);
  let close = end - 2; // the closing quote, at a line start
  if (close > body && source.charCodeAt(close - 1) === LF) close--;
  if (close > body && source.charCodeAt(close - 1) === CR) close--;
  if (close < body) return "";
  return quote === SQ ? source.slice(body, close) : decodeDoubleQuoted(source, body, close, false);
}

/** Backtick escapes and (inside a `"` string) `""`; `$(...)` stays as written. */
function decodeDoubleQuoted(source: string, start: number, end: number, doubledQuote: boolean): string {
  let text = "", chunk = start;
  for (let index = start; index < end; index++) {
    const code = source.charCodeAt(index);
    if (code === BACKTICK) {
      text += source.slice(chunk, index) + escapedCharacter(source, index + 1);
      chunk = ++index + 1;
    } else if (code === DQ && doubledQuote) {
      text += source.slice(chunk, index + 1);
      chunk = ++index + 1;
    } else if (code === DOLLAR && source.charCodeAt(index + 1) === LPAREN) {
      index = subexpressionEnd(source, index + 1, 0);
      if (index < 0) break;
    }
  }
  return chunk === start ? source.slice(start, end) : text + source.slice(chunk, end);
}

function escapedCharacter(source: string, index: number): string {
  switch (source.charCodeAt(index)) {
    case 48: return "\0";
    case 97: return "\x07";
    case 98: return "\b";
    case 101: return "\x1b";
    case 102: return "\f";
    case 110: return "\n";
    case 114: return "\r";
    case 116: return "\t";
    case 118: return "\v";
    default: return source.charAt(index);
  }
}
