import { isReadOnlyFindTail, isReadOnlySortTail } from "./readonly-find.ts";

const START = /^\s*for[ \t\n]/;
const NAME = /^[a-z_][a-z0-9_]*$/;
const EXCLUDED = new Set(["_", "path", "cdpath", "fpath"]);
const BARE = /^[A-Za-z0-9_./:=!+-]+$/;
const END = /[ \t\n;|&()<>]/;
const COUNT = /^[0-9]{1,6}$/;
type Word = { value: string; quote: number };
function keyword(word: Word | undefined, value: string): boolean { return word?.quote === 0 && word.value === value; }

// Request-boundary parser only. Quotes are provenance, never discarded separators.
// This does not evaluate filenames or rewrite the original command for execution.
function tokenize(source: string): Word[] | undefined {
  const words: Word[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (char === " " || char === "\t") { index++; continue; }
    let operator: string | undefined;
    if (source.startsWith("$(", index)) operator = "$(";
    else if (source.startsWith("2>&1", index)) operator = "2>&1";
    else if (source.startsWith("||", index)) operator = "||";
    else if (source.startsWith("&&", index)) operator = "&&";
    else if (char === ";" || char === "\n") operator = ";";
    else if (char === "|" || char === ")") operator = char;
    if (operator) {
      if (operator !== ";" || !keyword(words.at(-1), ";")) words.push({ value: operator, quote: 0 });
      index += char === "\n" ? 1 : operator.length;
      if (operator === "2>&1" && index < source.length && !END.test(source[index]!)) return undefined;
    } else {
      const quote = char === "'" ? 39 : char === '"' ? 34 : 0;
      const start = quote ? ++index : index;
      if (quote) {
        while (index < source.length && source.charCodeAt(index) !== quote) index++;
        if (index === source.length) return undefined;
      } else while (index < source.length && !END.test(source[index]!)) index++;
      const value = source.slice(start, index);
      if (quote) {
        index++;
        if (index < source.length && !END.test(source[index]!)) return undefined;
        if (value.includes("\n") || (quote === 34 && (value.includes("\\") || value.includes("`")))) return undefined;
      } else if (!BARE.test(value)) return undefined;
      words.push({ value, quote });
    }
    if (words.length > 256) return undefined;
  }
  return words;
}

function literal(word: Word): boolean { return word.quote === 39 || !word.value.includes("$"); }
function label(word: Word, variable: string, braced: string): boolean {
  if (word.quote === 39) return true;
  for (let index = 0; index < word.value.length; index++) {
    if (word.value.charCodeAt(index) !== 36) continue;
    if (word.quote !== 34) return false;
    if (word.value.startsWith(braced, index)) index += braced.length - 1;
    else if (word.value.startsWith(variable, index)) {
      index += variable.length - 1;
      const next = word.value.charCodeAt(index + 1);
      if (next === 95 || next >= 48 && next <= 57 || next >= 65 && next <= 90 || next >= 97 && next <= 122) return false;
    } else return false;
  }
  return true;
}
function separator(word: Word): boolean { return keyword(word, ";") || keyword(word, "|") || keyword(word, "||") || keyword(word, "&&"); }

/** Minimal full-source recipe. Word splitting/globbing of the find output is NOT
 * made lossless: every resulting value can only be a quoted operand after --, or
 * echo data. In particular it can never become an option or a shell redirection.
 */
export function isReadOnlyFindLoop(source: string): boolean {
  if (source.length > 4096 || !START.test(source) || source.includes("\r") || source.includes("\0")) return false;
  const words = tokenize(source);
  if (!words) return false;
  let index = keyword(words[0], ";") ? 1 : 0;
  if (!keyword(words[index++], "for")) return false;
  const name = words[index++];
  if (!name || name.quote || !NAME.test(name.value) || EXCLUDED.has(name.value)) return false;
  if (!keyword(words[index++], "in") || !keyword(words[index++], "$(") || !keyword(words[index], "find")) return false;
  const find: string[] = [];
  while (index < words.length && !keyword(words[index], ")") && !keyword(words[index], "|")) {
    const word = words[index++]!;
    if (!literal(word) || (word.quote === 0 && (separator(word) || word.value === "$(" || word.value === "2>&1"))) return false;
    find.push(word.value);
  }
  if (!isReadOnlyFindTail(find, 0)) return false;
  if (keyword(words[index], "|")) {
    index++;
    if (!keyword(words[index++], "sort")) return false;
    const sort = ["sort"];
    while (index < words.length && !keyword(words[index], ")")) {
      const word = words[index++]!;
      if (!literal(word)) return false;
      sort.push(word.value);
    }
    if (!isReadOnlySortTail(sort, 0)) return false;
  }
  if (!keyword(words[index++], ")") || !keyword(words[index++], ";") || !keyword(words[index++], "do")) return false;
  if (keyword(words[index], ";")) index++;
  const variable = "$" + name.value, braced = "${" + name.value + "}";
  let commands = 0, reads = 0;
  let piped = false;
  while (index < words.length && !keyword(words[index], "done")) {
    const command = words[index++];
    if (!command || command.quote || ++commands > 32) return false;
    const start = index;
    while (index < words.length && !separator(words[index]!)) index++;
    let end = index;
    if (keyword(words[end - 1], "2>&1")) end--;
    let cursor = start;
    if (piped) {
      // Pipes can consume stdout only through bounded head, never a program launcher.
      if (command.value !== "head" || !keyword(words[cursor++], "-n") || !words[cursor] || !literal(words[cursor]!) || !COUNT.test(words[cursor++]!.value) || cursor !== end) return false;
    } else if (command.value === "echo") {
      for (; cursor < end; cursor++) {
        const word = words[cursor]!;
        if (keyword(word, "2>&1") || keyword(word, "$(") || keyword(word, ")") || !label(word, variable, braced)) return false;
      }
    } else {
      if (command.value === "node") { if (!keyword(words[cursor++], "--check")) return false; }
      else if (command.value === "head") {
        if (!keyword(words[cursor++], "-n") || !words[cursor] || !literal(words[cursor]!) || !COUNT.test(words[cursor++]!.value)) return false;
      } else if (command.value === "wc") { if (!keyword(words[cursor++], "-l")) return false; }
      else if (command.value !== "cat") return false;
      if (!keyword(words[cursor++], "--")) return false;
      const file = words[cursor++];
      if (file?.quote !== 34 || (file.value !== variable && file.value !== braced) || cursor !== end) return false;
      reads++;
    }
    const boundary = words[index++];
    if (!boundary) return false;
    piped = keyword(boundary, "|");
    if (keyword(words[index], "done") && !keyword(boundary, ";")) return false;
  }
  if (!keyword(words[index++], "done")) return false;
  if (keyword(words[index], ";")) index++;
  return reads > 0 && index === words.length;
}
