// Slow-path counters describe explicit string work, not V8's internal allocations.
// Only primitive counters survive a scan; source and decoded names are not retained.
export const codeMethodNameCounters = { nodeDecodes: 0, pythonNormalizations: 0, sourceSlices: 0, stringAppends: 0, codePointStrings: 0, failures: 0 };
const MAX_NODE_NAME_CHARS = 256;

export function isCodeMethodNamePart(code: number): boolean {
  return code === 36 || code === 95 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122
    || code >= 128 && code !== 160 && code !== 5760 && !(code >= 8192 && code <= 8202) && code !== 8232 && code !== 8233 && code !== 8239 && code !== 8287 && code !== 12288 && code !== 65279;
}

function hexDigit(code: number): number {
  return code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
}

/** Called only after an escape/non-ASCII property character was seen in the
 * existing mask. Write canonical names into that same array, preserving offsets. */
export function writeCodeMethodName(source: string, output: string[], start: number, language: "node" | "python"): number {
  let end = start;
  while (end < source.length) {
    const code = source.charCodeAt(end);
    if (language === "node" && code === 92) {
      if (source.charCodeAt(end + 1) !== 117) return failedName();
      end += 2;
      if (source.charCodeAt(end) === 123) {
        end++;
        while (end < source.length && source.charCodeAt(end) !== 125) { if (end - start >= MAX_NODE_NAME_CHARS || hexDigit(source.charCodeAt(end)) < 0) return failedName(); end++; }
        if (source.charCodeAt(end) !== 125) return failedName();
        end++;
      } else end += 4;
    } else if (isCodeMethodNamePart(code)) end++;
    else break;
    if (language === "node" && end - start > MAX_NODE_NAME_CHARS) return failedName();
  }
  let name: string | undefined;
  if (language === "python") {
    // Python names have no language length cap; the enclosing source is already
    // bounded. Ordinary Unicode names normalize without becoming a violation.
    codeMethodNameCounters.pythonNormalizations++; codeMethodNameCounters.sourceSlices++;
    name = source.slice(start, end).normalize("NFKC");
  } else name = decodeNodeName(source, start, end, false);
  if (name === undefined) return failedName();
  const recognized = language === "python" ? name === "rmtree" || name === "unlink" || name === "__call__"
    : nodeDeletionName(name) || name === "call" || name === "apply";
  writeName(output, start, end, recognized ? name : "", 0);
  return end;
}

/** Exact bracket literals only: concatenation and computed keys stay opaque.
 * ASCII keys take no decoding/string path. Interpolated template keys refuse. */
export function writeEscapedNodeMethodKey(source: string, output: string[], start: number): number {
  let before = start - 1;
  while (before >= 0 && keyWhitespace(output[before]?.charCodeAt(0) ?? -1)) before--;
  if (output[before] !== "[") return 0;
  if (!hasBracketReceiver(source, output, before)) return 0;
  const quote = source.charCodeAt(start);
  let end = start + 1, escape = false;
  for (; end < source.length; end++) {
    const code = source.charCodeAt(end);
    if (quote === 96 && code === 36 && source.charCodeAt(end + 1) === 123) return failedName();
    if (code === 92) {
      escape = true;
      // Every string escape, including a line continuation, belongs to the
      // same bounded decoder. Preserve the original closing-quote position.
      if (++end >= source.length) return failedName();
      if (source.charCodeAt(end) === 13 && source.charCodeAt(end + 1) === 10) end++;
      continue;
    }
    if (code === quote) break;
    if (quote !== 96 && (code === 10 || code === 13)) return failedName();
  }
  if (source.charCodeAt(end) !== quote) return failedName();
  const after = nodeKeyTriviaEnd(source, end + 1);
  if (source.charCodeAt(after) !== 93) return 0;
  if (end - start - 1 > MAX_NODE_NAME_CHARS) return failedName();
  const name = escape ? decodeNodeName(source, start + 1, end, true, quote === 96) : plainNodeDeletionName(source, start + 1, end);
  if (!escape && name === undefined) return 0;
  if (name === undefined) return failedName();
  writeName(output, start, end + 1, nodeDeletionName(name) ? name : "", quote);
  return end + 1;
}

function nodeDeletionName(name: string): boolean {
  return name === "rm" || name === "rmSync" || name === "unlink" || name === "unlinkSync";
}

function plainNodeDeletionName(source: string, start: number, end: number): string | undefined {
  const length = end - start;
  if (length === 2 && source.startsWith("rm", start)) return "rm";
  if (length === 6 && source.startsWith("rmSync", start)) return "rmSync";
  if (length === 6 && source.startsWith("unlink", start)) return "unlink";
  if (length === 10 && source.startsWith("unlinkSync", start)) return "unlinkSync";
  return undefined;
}

function nodeKeyTriviaEnd(source: string, index: number): number {
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (keyWhitespace(code)) { index++; continue; }
    if (code !== 47) break;
    if (source.charCodeAt(index + 1) === 47) {
      index += 2;
      while (index < source.length && source.charCodeAt(index) !== 10 && source.charCodeAt(index) !== 13 && source.charCodeAt(index) !== 8232 && source.charCodeAt(index) !== 8233) index++;
    } else if (source.charCodeAt(index + 1) === 42) {
      index += 2;
      while (index < source.length && !(source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47)) index++;
      index += 2;
    } else break;
  }
  return index;
}

function hasBracketReceiver(source: string, output: string[], bracket: number): boolean {
  let end = bracket;
  // The existing mask has already removed comments before this bracket.
  while (end > 0 && keyWhitespace(output[end - 1]?.charCodeAt(0) ?? -1)) end--;
  const code = output[end - 1]?.charCodeAt(0) ?? -1;
  if (code === 41 || code === 93 || code === 46) return true;
  if (!isCodeMethodNamePart(code)) return false;
  let start = end - 1;
  while (start > 0 && isCodeMethodNamePart(output[start - 1]?.charCodeAt(0) ?? -1)) start--;
  if (output[start - 1] === ".") return true;
  const length = end - start;
  // These introduce an array expression; their string elements are not keys.
  return !(length === 6 && (source.endsWith("return", end) || source.endsWith("typeof", end) || source.endsWith("delete", end))
    || length === 5 && (source.endsWith("yield", end) || source.endsWith("throw", end) || source.endsWith("await", end))
    || length === 4 && source.endsWith("void", end) || length === 3 && source.endsWith("new", end)
    || length === 2 && source.endsWith("in", end) || length === 10 && source.endsWith("instanceof", end));
}

function keyWhitespace(code: number): boolean {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

function failedName(): number { codeMethodNameCounters.failures++; return -1; }

function decodeNodeName(source: string, start: number, end: number, literal: boolean, template = false): string | undefined {
  codeMethodNameCounters.nodeDecodes++;
  if (end - start > MAX_NODE_NAME_CHARS || end > source.length) return undefined;
  let name = "";
  for (let index = start; index < end; index++) {
    let code = source.charCodeAt(index);
    if (code === 92) {
      const kind = source.charCodeAt(++index);
      if (kind === 117 || literal && kind === 120) {
        const braced = kind === 117 && source.charCodeAt(index + 1) === 123;
        let digits = 0, value = 0;
        if (braced) index++;
        while (++index < end) {
          if (braced && source.charCodeAt(index) === 125) break;
          const digit = hexDigit(source.charCodeAt(index));
          if (digit < 0) return undefined;
          value = value * 16 + digit; digits++;
          if (value > 0x10ffff) return undefined;
          if (!braced && digits === (kind === 120 ? 2 : 4)) break;
        }
        if (!digits || braced && source.charCodeAt(index) !== 125 || !braced && digits !== (kind === 120 ? 2 : 4)) return undefined;
        code = value;
      } else if (literal) {
        if (kind === 10 || kind === 13 || kind === 8232 || kind === 8233) { if (kind === 13 && source.charCodeAt(index + 1) === 10) index++; continue; }
        if (kind >= 48 && kind <= 55) {
          // Annex B octal escapes exist in non-strict quoted strings. Template
          // literals permit only \0 without a following decimal digit.
          if (template && (kind !== 48 || source.charCodeAt(index + 1) >= 48 && source.charCodeAt(index + 1) <= 57)) return undefined;
          code = kind - 48;
          if (!template) for (let digits = 1; digits < (kind <= 51 ? 3 : 2) && index + 1 < end; digits++) {
            const digit = source.charCodeAt(index + 1);
            if (digit < 48 || digit > 55) break;
            code = code * 8 + digit - 48; index++;
          }
        }
        else if (kind === 56 || kind === 57) { if (template) return undefined; code = kind; }
        else code = kind === 110 ? 10 : kind === 114 ? 13 : kind === 116 ? 9 : kind === 98 ? 8 : kind === 102 ? 12 : kind === 118 ? 11 : kind;
      }
      else return undefined;
      codeMethodNameCounters.codePointStrings++; codeMethodNameCounters.stringAppends++;
      name += String.fromCodePoint(code);
    } else {
      codeMethodNameCounters.stringAppends++;
      if (template && code === 13) { if (source.charCodeAt(index + 1) === 10) index++; name += "\n"; }
      else name += source[index];
    }
  }
  return name;
}

function writeName(output: string[], start: number, end: number, name: string, quote: number): void {
  for (let index = start; index < end; index++) output[index] = " ";
  if (!name) return;
  if (quote) output[start++] = quote === 34 ? '"' : "'";
  for (let index = 0; index < name.length; index++) output[start + index] = name[index]!;
  if (quote) output[start + name.length] = quote === 34 ? '"' : "'";
}
