const CASE_WORD_END = /[ \t\r\n]/;
const COMMAND_START_KEYWORD = /^(?:then|do|else|elif|if|while|until|time|!)(?=[ \t\r\n])/;
const SUBSTITUTION_COMMENT_BOUNDARY = /[ \t\r\n;|&()]/;
export interface CommandSubstitutionScan {
  scripts: string[];
  unterminated: boolean;
  /** Boundary/grammar could not be inspected; not proof of termination or safety. */
  unsupported: boolean;
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
      if (end >= command.length) return { scripts, unterminated: true, unsupported: false };
      if (scripts.length < MAX_SUBSTITUTIONS) scripts.push(command.slice(index + 1, end));
      else return { scripts, unterminated: false, unsupported: true };
      index = end;
      continue;
    }
    if (code !== 36 || command.charCodeAt(index + 1) !== 40 || command.charCodeAt(index + 2) === 40) continue;

    let depth = 1;
    let innerQuote = 0;
    let innerEscaped = false;
    let commandStart = true;
    let end = index + 2;
    for (; end < command.length; end++) {
      const inner = command.charCodeAt(end);
      if (innerEscaped) {
        innerEscaped = false;
        continue;
      }
      if (inner === 92 && innerQuote !== 39) {
        if (command[end + 1] !== "\n") commandStart = false;
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
        commandStart = false;
        innerQuote = 39;
        continue;
      }
      if (inner === 34 && (innerQuote === 0 || innerQuote === 34)) {
        commandStart = false;
        innerQuote = innerQuote === 34 ? 0 : 34;
        continue;
      }
      if (inner === 35 && (end === index + 2 || SUBSTITUTION_COMMENT_BOUNDARY.test(command[end - 1]!))) {
        const newline = command.indexOf("\n", end);
        if (newline < 0) return { scripts, unterminated: true, unsupported: false };
        end = newline;
        commandStart = true;
        continue;
      }
      if (inner === 32 || inner === 9 || inner === 13) continue;
      if (inner === 10 || inner === 59 || inner === 124 || inner === 38) { commandStart = true; continue; }
      if (inner === 123 && CASE_WORD_END.test(command[end + 1] ?? "")) { commandStart = true; continue; }
      if (commandStart) {
        if ((command.startsWith("time", end) && CASE_WORD_END.test(command[end + 4] ?? "")) || (command.startsWith("coproc", end) && CASE_WORD_END.test(command[end + 6] ?? ""))) return { scripts, unterminated: false, unsupported: true };
        if (command.startsWith("case", end) && CASE_WORD_END.test(command[end + 4] ?? "")) return { scripts, unterminated: false, unsupported: true };
        const keyword = COMMAND_START_KEYWORD.exec(command.slice(end, end + 7));
        if (keyword) { end += keyword[0].length - 1; continue; }
        commandStart = false;
      }
      if (inner === 40) { depth += 1; commandStart = true; }
      else if (inner === 41 && --depth === 0) break;
    }
    if (end >= command.length) return { scripts, unterminated: true, unsupported: false };
    const script = command.slice(index + 2, end);
    // Actual unquoted case commands are refused before pattern parentheses can truncate this body.
    if (scripts.length < MAX_SUBSTITUTIONS) scripts.push(script);
    else return { scripts, unterminated: false, unsupported: true };
    index = end;
  }
  return { scripts, unterminated: false, unsupported: false };
}


const COMMENT_BOUNDARY = /[ \t\r\n;|&]/;
/** Detection only: actual heredocs are unsupported; never remove source/body text. */
export function inspectHereDocuments(command: string): { command: string; substitutions: string[]; uncertain: boolean } {
 let quote = ""; let escaped = false; let arithmeticDepth = 0;
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
   return { command, substitutions: [], uncertain: true };
  }
 }
 return { command, substitutions: [], uncertain: arithmeticDepth !== 0 };
}
