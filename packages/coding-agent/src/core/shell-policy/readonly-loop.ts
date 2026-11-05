import { isBashNetworkRedirectionTarget } from "./shell-redirection.ts";

const LOOP_START = /^\s*for[ \t\r\n]/;
const LOCAL_NAME = /^[a-z_][a-z0-9_]*$/;
const EXCLUDED_VARIABLES = new Set(["_", "path", "cdpath", "fpath"]);
const BARE_WORD = /^[A-Za-z0-9_./:=-]+$/;
const STATIC_PATH = /^[A-Za-z0-9_./: =-]+$/;
const WORD_END = /[ \t\r\n;<]/;
type Word = { value: string; quote: number };

/** A bounded read-only recipe, not variable evaluation or a general shell exemption.
 * Execution still receives the original bytes. Anything outside this grammar goes
 * through the existing scanners, including all writes, wrappers and substitutions.
 */
export function isLiteralReadLoop(source: string): boolean {
  // CR handling differs across Bash builds/options. The exemption accepts LF
  // only; never classify a possibly different executable after stripping CR.
  if (source.length > 4096 || !LOOP_START.test(source) || source.includes("\r")) return false;
  const words: Word[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\r") { index++; continue; }
    if (char === ";" || char === "\n" || char === "<") {
      const value = char === "\n" ? ";" : char;
      // Quoted ";" is data. Only coalesce actual command separators, or a
      // following command could be mistaken for arguments to the previous one.
      if (value !== ";" || !keyword(words.at(-1), ";")) words.push({ value, quote: 0 });
      index++;
    } else {
      const quote = char === "'" ? 39 : char === '"' ? 34 : 0;
      const start = quote ? ++index : index;
      if (quote) {
        while (index < source.length && source.charCodeAt(index) !== quote) index++;
        if (index === source.length) return false;
      } else while (index < source.length && !WORD_END.test(source[index]!)) index++;
      const value = source.slice(start, index);
      if (quote) {
        index++;
        if (index < source.length && !WORD_END.test(source[index]!)) return false;
        // No escape interpretation, command substitution or multiline quoted code.
        if (value.includes("\n") || value.includes("\r") || (quote === 34 && (value.includes("\\") || value.includes("`")))) return false;
      } else if (!BARE_WORD.test(value)) return false;
      words.push({ value, quote });
    }
    if (words.length > 256) return false;
  }
  let index = 0;
  if (keyword(words[index], ";")) index++;
  if (!keyword(words[index++], "for")) return false;
  const variable = words[index++];
  // Exclude Bash special names and lower-case lookup names used by other shells.
  if (!variable || variable.quote || EXCLUDED_VARIABLES.has(variable.value) || !LOCAL_NAME.test(variable.value)) return false;
  if (!keyword(words[index++], "in")) return false;
  let paths = 0;
  while (index < words.length && !keyword(words[index], ";")) {
    const path = words[index++]!;
    if (++paths > 16 || !STATIC_PATH.test(path.value) || isBashNetworkRedirectionTarget(path.value)) return false;
  }
  if (paths === 0 || !keyword(words[index++], ";") || !keyword(words[index++], "do")) return false;
  if (keyword(words[index], ";")) index++;
  const plainVariable = "$" + variable.value;
  const bracedVariable = "${" + variable.value + "}";
  let commands = 0;
  let reads = 0;
  while (index < words.length && !keyword(words[index], "done")) {
    const command = words[index++];
    if (!command || command.quote || (command.value !== "echo" && command.value !== "cat" && command.value !== "tr") || ++commands > 32) return false;
    let input = false;
    while (index < words.length && !keyword(words[index], ";")) {
      const word = words[index++]!;
      if (keyword(word, "<")) {
        const target = words[index++];
        if (input || command.value === "echo" || target?.quote !== 34 || (target.value !== plainVariable && target.value !== bracedVariable)) return false;
        input = true; reads++;
      } else if (!dataWord(word, plainVariable, bracedVariable, command.value === "echo")) return false;
    }
    if (command.value !== "echo" && !input) return false;
    if (!keyword(words[index++], ";")) return false;
  }
  if (!keyword(words[index++], "done")) return false;
  if (keyword(words[index], ";")) index++;
  return reads > 0 && index === words.length;
}

function keyword(word: Word | undefined, value: string): boolean { return word?.quote === 0 && word.value === value; }

function dataWord(word: Word, variable: string, braced: string, interpolate: boolean): boolean {
  if (word.quote === 39) return true;
  for (let index = 0; index < word.value.length; index++) {
    if (word.value.charCodeAt(index) !== 36) continue;
    if (!interpolate || word.quote !== 34) return false;
    if (word.value.startsWith(braced, index)) index += braced.length - 1;
    else if (word.value.startsWith(variable, index)) {
      index += variable.length - 1;
      const next = word.value.charCodeAt(index + 1);
      if (next === 95 || next >= 48 && next <= 57 || next >= 65 && next <= 90 || next >= 97 && next <= 122) return false;
    } else return false;
  }
  return true;
}
