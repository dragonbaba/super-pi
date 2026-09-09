const UNSUPPORTED_CASE_PATTERN = /\bcase[ \t\r\n]/;
const SUBSTITUTION_COMMENT_BOUNDARY = /[ \t\r\n;|&()]/;
export interface CommandSubstitutionScan {
  scripts: string[];
  unterminated: boolean;
}

const MAX_SUBSTITUTIONS = 16;

/**
 * Extract shell command substitutions that execute in the current script.
 * Single quotes are literal; double quotes still permit $(...) and backticks.
 * Arithmetic expansion $((...)) is not itself a command substitution, though
 * nested substitutions remain visible to the outer scan.
 */
export function extractCommandSubstitutions(command: string, heredocData = false): CommandSubstitutionScan {
  const scripts: string[] = [];
  let quote = 0;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (code === 92 && quote !== 39) {
      escaped = true;
      continue;
    }
    if (quote === 39) {
      if (code === 39) quote = 0;
      continue;
    }
    if (!heredocData && code === 39 && quote === 0) {
      quote = 39;
      continue;
    }
    if (!heredocData && code === 34 && (quote === 0 || quote === 34)) {
      quote = quote === 34 ? 0 : 34;
      continue;
    }
    if (code === 96) {
      let end = index + 1;
      let innerEscaped = false;
      for (; end < command.length; end++) {
        const inner = command.charCodeAt(end);
        if (innerEscaped) {
          innerEscaped = false;
          continue;
        }
        if (inner === 92) {
          innerEscaped = true;
          continue;
        }
        if (inner === 96) break;
      }
      if (end >= command.length) return { scripts, unterminated: true };
      if (scripts.length < MAX_SUBSTITUTIONS) scripts.push(command.slice(index + 1, end));
      else return { scripts, unterminated: true };
      index = end;
      continue;
    }
    if (code !== 36 || command.charCodeAt(index + 1) !== 40 || command.charCodeAt(index + 2) === 40) continue;

    let depth = 1;
    let innerQuote = 0;
    let innerEscaped = false;
    let end = index + 2;
    for (; end < command.length; end++) {
      const inner = command.charCodeAt(end);
      if (innerEscaped) {
        innerEscaped = false;
        continue;
      }
      if (inner === 92 && innerQuote !== 39) {
        innerEscaped = true;
        continue;
      }
      if (innerQuote === 39) {
        if (inner === 39) innerQuote = 0;
        continue;
      }
      if (innerQuote === 34) {
        if (inner === 34) innerQuote = 0;
        continue;
      }
      if (inner === 39 && innerQuote === 0) {
        innerQuote = 39;
        continue;
      }
      if (inner === 34 && (innerQuote === 0 || innerQuote === 34)) {
        innerQuote = innerQuote === 34 ? 0 : 34;
        continue;
      }
      if (inner === 35 && (end === index + 2 || SUBSTITUTION_COMMENT_BOUNDARY.test(command[end - 1]!))) {
        const newline = command.indexOf("\n", end);
        if (newline < 0) return { scripts, unterminated: true };
        end = newline;
        continue;
      }
      if (inner === 40) depth += 1;
      else if (inner === 41 && --depth === 0) break;
    }
    if (end >= command.length) return { scripts, unterminated: true };
    const script = command.slice(index + 2, end);
    // Case-pattern parentheses require shell grammar; never mask a potentially truncated body.
    if (UNSUPPORTED_CASE_PATTERN.test(script)) return { scripts, unterminated: true };
    if (scripts.length < MAX_SUBSTITUTIONS) scripts.push(script);
    else return { scripts, unterminated: true };
    index = end;
  }
  return { scripts, unterminated: false };
}


// Only this literal data consumer may hide a body. Evaluators and compound headers are uncertain.
const DATA_HEREDOC_HEADER = /^[ \t]*(?:\/(?:usr\/)?bin\/)?cat(?:[ \t]+|(?=<))[A-Za-z0-9_./: \t<>\'"\\-]*$/;
const COMMENT_BOUNDARY = /[ \t\r\n;|&]/;
const LEADING_TABS = /^\t+/;
const HEREDOC_WORD = /^(?:'([A-Za-z0-9_]{1,128})'|"([A-Za-z0-9_]{1,128})"|(\\?)([A-Za-z0-9_]{1,128}))(?=$|[ \t\r\n;&|<>])/;
/** Bounded literal-delimiter recognition, not a Bash parser. Unsupported syntax is uncertain. */
export function inspectHereDocuments(command: string): { command: string; substitutions: string[]; uncertain: boolean } {
 if (!command.includes("<<")) return { command, substitutions: [], uncertain: false };
 const pieces: string[] = []; const substitutions: string[] = [];
 const pending: Array<{ word: string; quoted: boolean; tabs: boolean }> = [];
 let quote = ""; let escaped = false; let copied = 0; let count = 0; let arithmeticDepth = 0; let lineStart = 0;
 for (let index = 0; index < command.length; index++) {
  const c = command[index];
  if (escaped) { escaped = false; continue; }
  if (c === "\\" && quote !== "'") { escaped = true; continue; }
  if (quote) { if (c === quote) quote = ""; continue; }
  if (c === "'" || c === '"') { quote = c; continue; }
  if (c === "#" && (index === 0 || COMMENT_BOUNDARY.test(command[index - 1]!))) {
   const end = command.indexOf("\n", index); if (end < 0) break; index = end - 1; continue;
  }
  if (c === "$" && command[index + 1] === "(" && command[index + 2] === "(") { arithmeticDepth += 2; index += 2; continue; }
  if (c === "(" && command[index + 1] === "(") { arithmeticDepth += 2; index++; continue; }
  if (arithmeticDepth) { if (c === "(") arithmeticDepth++; else if (c === ")") arithmeticDepth--; continue; }
  if (c === "<" && command[index + 1] === "<") {
   if (command[index + 2] === "<") { index += 2; continue; }
   if (++count > 16) return { command: "", substitutions: [], uncertain: true };
   let start = index + 2; const tabs = command[start] === "-"; if (tabs) start++;
   while (command[start] === " " || command[start] === "\t") start++;
   const word = HEREDOC_WORD.exec(command.slice(start, start + 132));
   if (!word) return { command: "", substitutions: [], uncertain: true };
   pending.push({ word: word[1] ?? word[2] ?? word[4]!, quoted: !!(word[1] || word[2] || word[3]), tabs });
   index = start + word[0].length - 1; continue;
  }
  if (c !== "\n") continue;
  if (pending.length === 0) { lineStart = index + 1; continue; }
  const header = command.slice(lineStart, index).replace(/\r$/, "");
  if (command.slice(0, lineStart).trim() || !DATA_HEREDOC_HEADER.test(header) || header.endsWith("\\")) return { command: "", substitutions: [], uncertain: true };
  pieces.push(command.slice(copied, index + 1));
  let position = index + 1;
  for (const doc of pending) {
   const bodyStart = position; let found = false;
   while (position <= command.length) {
    const end = command.indexOf("\n", position); const lineEnd = end < 0 ? command.length : end;
    let line = command.slice(position, lineEnd); if (line.endsWith("\r")) line = line.slice(0, -1);
    if (doc.tabs) line = line.replace(LEADING_TABS, "");
    // Backslash-newline folding changes delimiter recognition; refuse this unsupported form.
    if (!doc.quoted && line.endsWith("\\")) return { command: "", substitutions: [], uncertain: true };
    if (line === doc.word) {
     if (!doc.quoted) {
      const expanded = extractCommandSubstitutions(command.slice(bodyStart, position), true);
      if (expanded.unterminated || substitutions.length + expanded.scripts.length > 16) return { command: "", substitutions: [], uncertain: true };
      substitutions.push(...expanded.scripts);
     }
     position = end < 0 ? command.length : end + 1; found = true; break;
    }
    if (end < 0) break; position = end + 1;
   }
   if (!found) return { command: "", substitutions: [], uncertain: true };
  }
  pending.length = 0; copied = position; lineStart = position; index = position - 1;
 }
 // No preceding setup/override or subsequent staged execution is inferred safe.
 if (copied > 0 && command.slice(copied).trim()) return { command: "", substitutions: [], uncertain: true };
 if (pending.length || arithmeticDepth) return { command: "", substitutions: [], uncertain: true };
 pieces.push(command.slice(copied));
 return { command: pieces.join(""), substitutions, uncertain: false };
}
