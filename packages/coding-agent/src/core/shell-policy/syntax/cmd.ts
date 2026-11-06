import {
  DIALECT_CMD, EXPANSION_GLOB, EXPANSION_QUOTED_VARIABLE, EXPANSION_VARIABLE, SEGMENT_AND, SEGMENT_CLOSE, SEGMENT_END,
  SEGMENT_OPEN, SEGMENT_OR, SEGMENT_PIPE, SEGMENT_SEQUENCE, ShellTokenTable, WORD_DECODE, WORD_QUOTED, WORD_QUOTED_COMMA,
  WORD_REDIRECTION,
} from "./token-table.ts";

/*
 * cmd.exe tokens: `^` escapes outside quotes, `"` toggles quoting (no escapes inside),
 * space, tab, `,` and `;` delimit words, `&`/`&&`/`||`/`|`/newline end segments,
 * `n>`, `>>`, `<` and `n>&m` redirect, and a leading `@` is dropped. A backslash is an
 * ordinary path character. `%name%` and `!name!` mark a word as expanded.
 */

const TAB = 9, LF = 10, FF = 12, CR = 13, SPACE = 32, BANG = 33, DQ = 34, PERCENT = 37, AMP = 38, LPAREN = 40, RPAREN = 41,
  STAR = 42, COMMA = 44, SEMI = 59, LT = 60, GT = 62, QMARK = 63, AT = 64, CARET = 94, PIPE = 124;

export function lexCmd(source: string): ShellTokenTable {
  const table = new ShellTokenTable(source, DIALECT_CMD);
  const length = source.length;
  let depth = 0, index = 0;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isDelimiter(code)) { index++; continue; }
    if (code === CARET && isLineBreak(source.charCodeAt(index + 1))) { index = afterLineBreak(source, index + 1); continue; }
    if (code === LF || code === CR) { table.endSegment(SEGMENT_SEQUENCE, depth); index++; continue; }
    if (code === AMP) {
      const double = source.charCodeAt(index + 1) === AMP;
      table.endSegment(double ? SEGMENT_AND : SEGMENT_SEQUENCE, depth); index += double ? 2 : 1; continue;
    }
    if (code === PIPE) {
      const double = source.charCodeAt(index + 1) === PIPE;
      table.endSegment(double ? SEGMENT_OR : SEGMENT_PIPE, depth); index += double ? 2 : 1; continue;
    }
    const atSegmentStart = table.tokenCount === table.segmentStart(table.segmentCount);
    if (code === AT && atSegmentStart) { index++; continue; }
    if (code === LPAREN) { table.endSegment(SEGMENT_OPEN, depth); depth++; index++; continue; }
    if (code === RPAREN && depth > 0) { table.endSegment(SEGMENT_CLOSE, depth); depth--; index++; continue; }
    const redirection = lexRedirection(source, index, table);
    if (redirection > 0) { index = redirection; continue; }
    index = lexWord(source, index, depth, table);
  }
  table.endSegment(SEGMENT_END, depth);
  return table;
}

function isDelimiter(code: number): boolean {
  return code === SPACE || code === TAB || code === FF || code === COMMA || code === SEMI;
}

function isLineBreak(code: number): boolean {
  return code === LF || code === CR;
}

function afterLineBreak(source: string, index: number): number {
  return source.charCodeAt(index) === CR && source.charCodeAt(index + 1) === LF ? index + 2 : index + 1;
}

function lexRedirection(source: string, index: number, table: ShellTokenTable): number {
  let code = source.charCodeAt(index), fd = -1, operator = index;
  if (code >= 48 && code <= 57) {
    const next = source.charCodeAt(index + 1);
    if (next !== GT && next !== LT) return 0;
    fd = code - 48; operator = index + 1; code = next;
  } else if (code !== GT && code !== LT) return 0;
  let end = operator + 1;
  if (code === GT && source.charCodeAt(end) === GT) end++;
  if (source.charCodeAt(end) === AMP) end++;
  table.pushToken(operator, end, WORD_REDIRECTION, fd);
  return end;
}

function lexWord(source: string, start: number, depth: number, table: ShellTokenTable): number {
  const length = source.length;
  let index = start, flags = 0;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isDelimiter(code) || code === LF || code === CR || code === AMP || code === PIPE || code === GT || code === LT) break;
    if (code === RPAREN && depth > 0) break;
    if (code === CARET) { flags |= WORD_DECODE; index += isLineBreak(source.charCodeAt(index + 1)) ? afterLineBreak(source, index + 1) - index : 2; continue; }
    if (code === DQ) {
      if (index === start) flags |= WORD_QUOTED;
      flags |= WORD_DECODE;
      // An unclosed quote runs to the end of the line, as cmd reads it.
      for (index++; index < length; index++) {
        const quoted = source.charCodeAt(index);
        if (quoted === DQ || isLineBreak(quoted)) break;
        if (quoted === COMMA) flags |= WORD_QUOTED_COMMA;
        else if (quoted === PERCENT && isExpansion(source, index, PERCENT)) flags |= EXPANSION_QUOTED_VARIABLE;
      }
      if (source.charCodeAt(index) === DQ) index++;
      continue;
    }
    if ((code === PERCENT || code === BANG) && isExpansion(source, index, code)) flags |= EXPANSION_VARIABLE;
    else if (code === STAR || code === QMARK) flags |= EXPANSION_GLOB;
    index++;
  }
  table.pushToken(start, index > length ? length : index, flags, -1);
  return index;
}

/** `%name%`, `%1`, `%~dp0`, `%*`, or `!name!`: a marker followed by a non-delimiter. */
function isExpansion(source: string, index: number, marker: number): boolean {
  const next = source.charCodeAt(index + 1);
  if (Number.isNaN(next) || isDelimiter(next) || isLineBreak(next) || next === DQ) return false;
  return marker === PERCENT || source.indexOf("!", index + 2) > 0;
}

/** Text of a cmd word with quotes and `^` escapes removed. */
export function decodeCmdWord(source: string, start: number, end: number): string {
  let text = "", chunk = start, quoted = false;
  for (let index = start; index < end; index++) {
    const code = source.charCodeAt(index);
    if (code === DQ) { text += source.slice(chunk, index); chunk = index + 1; quoted = !quoted; }
    else if (code === CARET && !quoted) {
      text += source.slice(chunk, index);
      const next = source.charCodeAt(index + 1);
      if (isLineBreak(next)) { index = afterLineBreak(source, index + 1) - 1; chunk = index + 1; }
      else { chunk = index + 1; index++; }
    }
  }
  return text + source.slice(chunk, end);
}
