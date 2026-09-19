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
export function inspectHereDocuments(command: string): { command: string; substitutions: string[]; uncertain: boolean; heredoc?: true } {
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
   return { command, substitutions: [], uncertain: true, heredoc: true };
  }
 }
 return { command, substitutions: [], uncertain: arithmeticDepth !== 0 };
}

export interface ShellAnalysisView {
  /** Source-shaped text with heredoc bodies blanked, preserving command newlines. */
  command: string;
  /** Command substitutions found in unquoted heredoc bodies. */
  substitutions: string[];
  /** The body or delimiter could not be bounded without executing the shell. */
  uncertain: boolean;
  hasHeredoc: boolean;
}

function maskShellRange(output: string[] | undefined, start: number, end: number): void {
  if (!output) return;
  for (let index = start; index < end; index++) {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  }
}

interface HereDelimiter {
  value: string;
  quoted: boolean;
}

function collectHereDelimiters(command: string, start: number, end: number): HereDelimiter[] {
  const delimiters: HereDelimiter[] = [];
  let quote = "";
  let escaped = false;
  let arithmeticDepth = 0;
  for (let index = start; index < end; index++) {
    const c = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (arithmeticDepth) {
      if (c === "(") arithmeticDepth++;
      else if (c === ")") arithmeticDepth--;
      continue;
    }
    if (c !== "<" || command[index + 1] !== "<" || command[index + 2] === "<") continue;
    let cursor = index + 2;
    if (command[cursor] === "-") cursor++;
    while (command[cursor] === " " || command[cursor] === "\t") cursor++;
    let quoted = false;
    let value = "";
    if (command[cursor] === "'" || command[cursor] === '"') {
      quoted = true;
      const delimiterQuote = command[cursor]!;
      cursor++;
      const valueStart = cursor;
      while (cursor < end && command[cursor] !== delimiterQuote) cursor++;
      if (cursor >= end) return delimiters;
      value = command.slice(valueStart, cursor);
      cursor++;
    } else {
      const valueStart = cursor;
      while (cursor < end && command[cursor] !== " " && command[cursor] !== "\t" && command[cursor] !== "\r") cursor++;
      value = command.slice(valueStart, cursor);
    }
    if (value) delimiters.push({ value, quoted });
    index = cursor - 1;
  }
  return delimiters;
}

/**
 * Build the bounded source view used by mutation and permission analysis.
 * Heredoc bodies are data for the current command parser; they are not argv.
 * Unquoted bodies still expose command substitutions to the recursive scanner.
 */
export function prepareShellAnalysis(command: string): ShellAnalysisView {
  if (command.indexOf("<<") < 0 && command.indexOf("((") < 0) {
    return { command, substitutions: [], uncertain: false, hasHeredoc: false };
  }
  let output: string[] | undefined;
  const substitutions: string[] = [];
  let quote = "";
  let escaped = false;
  let arithmeticDepth = 0;
  let hasHeredoc = false;
  let uncertain = false;
  for (let index = 0; index < command.length; index++) {
    const c = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (arithmeticDepth) {
      if (c === "(") arithmeticDepth++;
      else if (c === ")") arithmeticDepth--;
      continue;
    }
    if (c !== "<" || command[index + 1] !== "<" || command[index + 2] === "<") continue;
    hasHeredoc = true;
    output ??= command.split("");
    const operatorStart = index;
    const lineEnd = command.indexOf("\n", index + 2);
    const delimiters = lineEnd < 0 ? [] : collectHereDelimiters(command, operatorStart, lineEnd);
    if (delimiters.length === 0 || lineEnd < 0) {
      uncertain = true;
      maskShellRange(output, operatorStart, command.length);
      break;
    }
    maskShellRange(output, operatorStart, lineEnd + 1);
    let bodyStart = lineEnd + 1;
    for (const delimiter of delimiters) {
      const contentStart = bodyStart;
      let bodyEnd = bodyStart;
      let delimiterLineStart = bodyStart;
      let foundDelimiter = false;
      while (bodyStart <= command.length) {
        const lineStart = bodyStart;
        const nextLine = command.indexOf("\n", bodyStart);
        const end = nextLine < 0 ? command.length : nextLine;
        const rawLine = command.slice(bodyStart, end);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === delimiter.value || line === `\t${delimiter.value}`) {
          delimiterLineStart = lineStart;
          bodyEnd = end;
          foundDelimiter = true;
          break;
        }
        bodyEnd = nextLine < 0 ? command.length : nextLine + 1;
        bodyStart = nextLine < 0 ? command.length + 1 : nextLine + 1;
      }
      if (!foundDelimiter) {
        uncertain = true;
        maskShellRange(output, contentStart, command.length);
        bodyStart = command.length;
        break;
      }
      if (!delimiter.quoted) {
        const body = command.slice(contentStart, delimiterLineStart);
        const nested = extractCommandSubstitutions(body, true);
        for (const script of nested.scripts) if (substitutions.length < MAX_SUBSTITUTIONS) substitutions.push(script);
        if (nested.unterminated || nested.unsupported) uncertain = true;
      }
      maskShellRange(output, contentStart, bodyEnd);
      const delimiterLineEnd = command.indexOf("\n", bodyEnd);
      bodyStart = delimiterLineEnd < 0 ? command.length : delimiterLineEnd + 1;
      maskShellRange(output, bodyEnd, bodyStart);
    }
    index = bodyStart - 1;
  }
  if (arithmeticDepth !== 0) uncertain = true;
  return { command: output ? output.join("") : command, substitutions, uncertain, hasHeredoc };
}
