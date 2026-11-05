import {
	CASE_WORD_END_PATTERN,
	COMMAND_START_KEYWORD_PATTERN,
	COMMENT_BOUNDARY_PATTERN,
	SUBSTITUTION_COMMENT_BOUNDARY_PATTERN,
} from "./regex.ts";
import { isSimpleBashAnsiCQuote, shellRedirectionLength } from "./shell-redirection.ts";
export interface CommandSubstitutionScan {
  scripts: string[];
  /** Grammar or budget could not be inspected; not proof of termination or safety. */
  uncertain: boolean;
}

export const MAX_SUBSTITUTIONS = 16;
export const MAX_SUBSTITUTION_NESTING = 4;

// Numeric-only instrumentation at the real scanner entries. Input bytes count
// UTF-16 code units submitted to each scan, including recursive invocations;
// they do not claim to count regex engine reads or V8 backing-store bytes.
export const shellAnalysisCounters = {
  prepareCalls: 0, prepareInputBytes: 0,
  substitutionCalls: 0, substitutionInputBytes: 0,
};

/** Bash 5.3 function substitution; parameter words do not satisfy this prefix. */
export function isFunctionSubstitutionStart(command: string, index: number): boolean {
  if (command.charCodeAt(index) !== 36 || command.charCodeAt(index + 1) !== 123) return false;
  const next = command.charCodeAt(index + 2);
  return next === 32 || next === 9 || next === 10 || next === 124;
}

/** Closing index, or -1 when the boundary is uncertain.
 * Shared with argv scanners so substitution operators never become outer segments.
 * Returns only a primitive; callers retain the original word and inspect its body separately.
 */
export function commandSubstitutionEnd(command: string, start: number, nesting = 0): number {
  if (nesting >= MAX_SUBSTITUTION_NESTING) return -1;
  if (command.charCodeAt(start) === 96) {
    let escaped = false;
    for (let end = start + 1; end < command.length; end++) {
      const inner = command.charCodeAt(end);
      if (inner === 92 && command.charCodeAt(end + 1) === 13) return -1;
      if (escaped) { escaped = false; continue; }
      if (inner === 92) { escaped = true; continue; }
      if (inner === 96) return end;
    }
    return -1;
  }
  let depth = 1;
  let quote = 0;
  let escaped = false;
  let commandStart = true;
  const functionBody = command.charCodeAt(start + 1) === 123;
  for (let end = start + 2; end < command.length; end++) {
    const inner = command.charCodeAt(end);
    if (inner === 92 && command.charCodeAt(end + 1) === 13) return -1;
    if (escaped) { escaped = false; continue; }
    if (inner === 92 && quote !== 39) {
      if (command[end + 1] !== "\n") commandStart = false;
      escaped = true;
      continue;
    }
    if (quote === 39) { if (inner === 39) quote = 0; continue; }
    // Nested substitutions have their own quoting context, even inside double quotes.
    const nestedFunction = isFunctionSubstitutionStart(command, end);
    if (inner === 96 || inner === 36 && command.charCodeAt(end + 1) === 40 && command.charCodeAt(end + 2) !== 40 || nestedFunction) {
      if (nestedFunction && quote === 34) return -1;
      const nestedEnd = commandSubstitutionEnd(command, end, nesting + 1);
      if (nestedEnd < 0) return -1;
      end = nestedEnd;
      commandStart = false;
      continue;
    }
    if (quote === 34) { if (inner === 34) quote = 0; continue; }
    if (functionBody && (inner === 40 && command.charCodeAt(end + 1) === 40 || inner === 60 && command.charCodeAt(end + 1) === 60)) return -1;
    // An escaped apostrophe in ANSI-C quoting is not a closing quote. Refuse
    // escapes the argv scanners cannot decode instead of truncating the body.
    if (inner === 36 && command.charCodeAt(end + 1) === 39 && !isSimpleBashAnsiCQuote(command, end)) return -1;
    if (inner === 39 || inner === 34) { commandStart = false; quote = inner; continue; }
    if (inner === 35 && (end === start + 2 || SUBSTITUTION_COMMENT_BOUNDARY_PATTERN.test(command[end - 1]!))) {
      const newline = command.indexOf("\n", end);
      if (newline < 0) return -1;
      end = newline;
      commandStart = true;
      continue;
    }
    if (inner === 32 || inner === 9 || inner === 13) continue;
    if (inner === 10 || inner === 59 || inner === 124 || inner === 38) { commandStart = true; continue; }
    if (functionBody && inner === 123) { depth++; commandStart = true; continue; }
    if (functionBody && inner === 125) {
      if (--depth === 0) return commandStart ? end : -1;
      continue;
    }
    if (inner === 123 && CASE_WORD_END_PATTERN.test(command[end + 1] ?? "")) { commandStart = true; continue; }
    if (commandStart) {
      if ((command.startsWith("time", end) && CASE_WORD_END_PATTERN.test(command[end + 4] ?? ""))
        || (command.startsWith("coproc", end) && CASE_WORD_END_PATTERN.test(command[end + 6] ?? ""))
        || (command.startsWith("case", end) && CASE_WORD_END_PATTERN.test(command[end + 4] ?? ""))) {
        return -1;
      }
      if (!functionBody) {
        const keyword = COMMAND_START_KEYWORD_PATTERN.exec(command.slice(end, end + 7));
        if (keyword) { end += keyword[0].length - 1; continue; }
      }
      commandStart = false;
    }
    if (!functionBody && inner === 40) { depth++; commandStart = true; }
    else if (!functionBody && inner === 41 && --depth === 0) return end;
  }
  return -1;
}

/**
 * Extract shell command substitutions that execute in the current script.
 * Single quotes are literal; double quotes still permit $(...) and backticks.
 * Arithmetic expansion $((...)) is not itself a command substitution, though
 * nested substitutions remain visible to the outer scan.
 */
export function extractCommandSubstitutions(command: string, heredocData = false): CommandSubstitutionScan {
  shellAnalysisCounters.substitutionCalls++;
  shellAnalysisCounters.substitutionInputBytes += command.length * 2;
  const scripts: string[] = [];
  let quote = 0;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (code === 92 && command.charCodeAt(index + 1) === 13) return { scripts, uncertain: true };
    if (!heredocData && !escaped && quote === 0 && code === 35 && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) break;
      index = newline; continue;
    }
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
    const functionBody = isFunctionSubstitutionStart(command, index);
    if (!functionBody && code !== 96 && (code !== 36 || command.charCodeAt(index + 1) !== 40 || command.charCodeAt(index + 2) === 40)) continue;
    if (scripts.length === MAX_SUBSTITUTIONS) return { scripts, uncertain: true };
    const end = commandSubstitutionEnd(command, index);
    if (end < 0 || functionBody && quote === 34) return { scripts, uncertain: true };
    scripts.push(command.slice(index + (code === 96 ? 1 : functionBody && command.charCodeAt(index + 2) === 124 ? 3 : 2), end));
    index = end;
  }
  return { scripts, uncertain: false };
}


export interface ShellAnalysisView {
  /** Source-shaped text with heredoc bodies blanked, preserving command newlines. */
  command: string;
  /** Command substitutions found in unquoted heredoc bodies. */
  substitutions: string[];
  /** Substitution or heredoc syntax could not be fully inspected. */
  uncertain: boolean;
  hasHeredoc: boolean;
  hereDocuments?: { body: string; expanded: boolean }[];
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
  stripTabs: boolean;
  maskStart: number;
  maskEnd: number;
}

interface HereDelimiterScan {
  delimiters: HereDelimiter[];
  uncertain: boolean;
}

function isShellWordBoundary(c: string | undefined): boolean {
  return c === undefined || c === " " || c === "\t" || c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">";
}

function collectHereDelimiters(command: string, start: number, end: number): HereDelimiterScan {
  if (end > start && command.charCodeAt(end - 1) === 13) end--;
  const delimiters: HereDelimiter[] = [];
  let quote = "";
  let escaped = false;
  let arithmeticDepth = 0;
  let uncertain = false;
  for (let index = start; index < end; index++) {
    const c = command[index]!;
    if (c === "\r") uncertain = true;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (!arithmeticDepth && c === "(" && command[index + 1] === "(") {
      arithmeticDepth = 2;
      index++;
      continue;
    }
    if (arithmeticDepth) {
      if (c === "(") arithmeticDepth++;
      else if (c === ")") arithmeticDepth--;
      continue;
    }
    const comment = c === "#" && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!));
    if (comment) break;
    if (c !== "<" && c !== ">") continue;
    let maskStart = index;
    let fdStart = index;
    while (fdStart > 0 && command.charCodeAt(fdStart - 1) >= 48 && command.charCodeAt(fdStart - 1) <= 57) fdStart--;
    if (fdStart < index && isShellWordBoundary(command[fdStart - 1])) {
      maskStart = fdStart;
    }
    if (c !== "<" || command[index + 1] !== "<") { index += shellRedirectionLength(command, index) - 1; continue; }
    if (command[index + 2] === "<") { index += 2; continue; }
    let cursor = index + 2;
    const stripTabs = command[cursor] === "-";
    if (stripTabs) cursor++;
    while (command[cursor] === " " || command[cursor] === "\t") cursor++;
    let quoted = false;
    let value = "";
    while (cursor < end && !isShellWordBoundary(command[cursor])) {
      if (command[cursor] === "'" || command[cursor] === '"') {
        quoted = true;
        const delimiterQuote = command[cursor++]!;
        const valueStart = cursor;
        while (cursor < end && command[cursor] !== delimiterQuote) { if (command.charCodeAt(cursor) === 13) uncertain = true; cursor++; }
        if (cursor >= end) return { delimiters, uncertain: true };
        value += command.slice(valueStart, cursor++);
      } else {
        const valueStart = cursor;
        while (cursor < end && !isShellWordBoundary(command[cursor]) && command[cursor] !== "'" && command[cursor] !== '"') { if (command.charCodeAt(cursor) === 13) uncertain = true; cursor++; }
        value += command.slice(valueStart, cursor);
      }
    }
    if (value.includes("$") || value.includes("`") || value.includes("\\")) uncertain = true;
    if (delimiters.length === MAX_SUBSTITUTIONS) return { delimiters, uncertain: true };
    if (value) delimiters.push({ value, quoted, stripTabs, maskStart, maskEnd: cursor });
    else uncertain = true;
    index = cursor - 1;
  }
  return { delimiters, uncertain };
}

/** A heredoc body begins after the logical declaration, not a quoted/escaped LF. */
function heredocDeclarationEnd(command: string, start: number): number {
  let quote = "", escaped = false;
  for (let index = start; index < command.length; index++) {
    const c = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!))) return command.indexOf("\n", index);
    if (c === "\n") return index;
  }
  return -1;
}

/**
 * Build the bounded source view used by mutation and permission analysis.
 * Heredoc bodies are data for the current command parser; they are not argv.
 * Unquoted bodies still expose command substitutions to the recursive scanner.
 */
export function prepareShellAnalysis(command: string): ShellAnalysisView {
  shellAnalysisCounters.prepareCalls++;
  shellAnalysisCounters.prepareInputBytes += command.length * 2;
  if (command.indexOf("<") < 0 && command.indexOf("((") < 0) {
    return { command, substitutions: [], uncertain: false, hasHeredoc: false };
  }
  let output: string[] | undefined;
  const substitutions: string[] = [];
  let quote = "";
  let escaped = false;
  let arithmeticDepth = 0;
  let hasHeredoc = false;
  let uncertain = false;
  let hereDocuments: ShellAnalysisView["hereDocuments"];
  for (let index = 0; index < command.length; index++) {
    const c = command[index]!;
    if (c === "\\" && command.charCodeAt(index + 1) === 13) { uncertain = true; break; }
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== "'" && isFunctionSubstitutionStart(command, index)) {
      const end = commandSubstitutionEnd(command, index);
      if (end < 0) { uncertain = true; break; }
      index = end; continue;
    }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\n") continue;
    if (c === "#" && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (c === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      arithmeticDepth = 2;
      index += 2;
      continue;
    }
    if (!arithmeticDepth && c === "(" && command[index + 1] === "(") {
      arithmeticDepth = 2;
      index++;
      continue;
    }
    if (arithmeticDepth) {
      if (c === "(") arithmeticDepth++;
      else if (c === ")") arithmeticDepth--;
      continue;
    }
    if (c !== "<") continue;
    // Bash removes continuations before forming the redirect operator. Keep
    // split heredoc operators uninspectable without normalizing/copying source
    // or teaching the bounded delimiter/argv parsers another representation.
    let second = index + 1;
    while (command.charCodeAt(second) === 92 && command.charCodeAt(second + 1) === 10) second += 2;
    if (command.charCodeAt(second) !== 60) continue;
    let third = second + 1;
    while (command.charCodeAt(third) === 92 && command.charCodeAt(third + 1) === 10) third += 2;
    if (command.charCodeAt(third) === 60) continue;
    if (second !== index + 1) { hasHeredoc = uncertain = true; break; }
    hasHeredoc = true;
    output ??= command.split("");
    const operatorStart = index;
    const lineEnd = heredocDeclarationEnd(command, index + 2);
    if (lineEnd >= 0) {
      if (command.charCodeAt(lineEnd - 1) === 13) uncertain = true;
      const headerSubstitutions = extractCommandSubstitutions(command.slice(operatorStart, lineEnd));
      if (headerSubstitutions.uncertain) uncertain = true;
    }
    const delimiterScan = lineEnd < 0 ? { delimiters: [], uncertain: true } : collectHereDelimiters(command, operatorStart, lineEnd);
    const delimiters = delimiterScan.delimiters;
    uncertain ||= delimiterScan.uncertain;
    for (const delimiter of delimiters) maskShellRange(output, delimiter.maskStart, delimiter.maskEnd);
    if (delimiters.length === 0 || lineEnd < 0) {
      uncertain = true;
      maskShellRange(output, operatorStart, Math.min(command.length, operatorStart + 2));
      break;
    }
    let bodyStart = lineEnd + 1;
    for (const delimiter of delimiters) {
      if (delimiterScan.uncertain) {
        uncertain = true;
        maskShellRange(output, bodyStart, command.length);
        bodyStart = command.length;
        break;
      }
      const contentStart = bodyStart;
      let bodyEnd = bodyStart;
      let delimiterLineStart = bodyStart;
      let foundDelimiter = false;
      let logicalBodyLineStart = bodyStart, delimiterMatched = 0, delimiterMatches = true;
      while (bodyStart <= command.length) {
        const nextLine = command.indexOf("\n", bodyStart);
        const end = nextLine < 0 ? command.length : nextLine;
        let contentEnd = end;
        let backslashes = 0;
        if (!delimiter.quoted && nextLine >= 0) for (let cursor = contentEnd - 1; cursor >= bodyStart && command.charCodeAt(cursor) === 92; cursor--) backslashes++;
        const continued = backslashes % 2 === 1;
        if (contentEnd > bodyStart && command.charCodeAt(contentEnd - 1) === 13) { uncertain = true; contentEnd--; }
        if (continued) contentEnd--;
        let cursor = bodyStart;
        if (delimiter.stripTabs && delimiterMatched === 0) while (cursor < contentEnd && command.charCodeAt(cursor) === 9) cursor++;
        for (; cursor < contentEnd; cursor++) {
          if (command.charCodeAt(cursor) === 13) uncertain = true;
          if (command[cursor] !== delimiter.value[delimiterMatched]) delimiterMatches = false;
          delimiterMatched++;
        }
        if (!continued && delimiterMatches && delimiterMatched === delimiter.value.length) {
          delimiterLineStart = logicalBodyLineStart;
          bodyEnd = end;
          foundDelimiter = true;
          break;
        }
        bodyEnd = nextLine < 0 ? command.length : nextLine + 1;
        bodyStart = nextLine < 0 ? command.length + 1 : nextLine + 1;
        if (!continued) { logicalBodyLineStart = bodyStart; delimiterMatched = 0; delimiterMatches = true; }
      }
      if (!foundDelimiter) {
        uncertain = true;
        maskShellRange(output, contentStart, command.length);
        bodyStart = command.length;
        break;
      }
      const rawBody = command.slice(contentStart, delimiterLineStart);
      const body = delimiter.quoted ? rawBody : removeHeredocContinuations(rawBody);
      let expanded = false;
      if (!delimiter.quoted) {
        for (let cursor = 0; cursor < body.length; cursor++) {
          if (body[cursor] === "\\") {
            const next = body.charCodeAt(cursor + 1);
            if (next === 36 || next === 96 || next === 92) expanded = true;
            cursor++; continue;
          }
          if (body[cursor] === "$" || body[cursor] === "`") { expanded = true; break; }
        }
        const nested = extractCommandSubstitutions(body, true);
        for (const script of nested.scripts) {
          if (substitutions.length < MAX_SUBSTITUTIONS) substitutions.push(script);
          else uncertain = true;
        }
        if (nested.uncertain) uncertain = true;
      }
      hereDocuments ??= [];
      if (hereDocuments.length < MAX_SUBSTITUTIONS) hereDocuments.push({ body, expanded });
      else uncertain = true;
      maskShellRange(output, contentStart, bodyEnd);
      const delimiterLineEnd = command.indexOf("\n", bodyEnd);
      bodyStart = delimiterLineEnd < 0 ? command.length : delimiterLineEnd + 1;
      maskShellRange(output, bodyEnd, bodyStart);
    }
    index = bodyStart - 1;
  }
  if (arithmeticDepth !== 0) uncertain = true;
  return { command: output ? output.join("") : command, substitutions, uncertain, hasHeredoc, hereDocuments };
}

/** One bounded normalized body only when Bash removes a continuation. The
 * original input/mask offsets remain unchanged; no line array is retained. */
function removeHeredocContinuations(source: string): string {
  let result = "", start = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (source.charCodeAt(cursor) !== 92) continue;
    const next = source.charCodeAt(cursor + 1);
    const width = next === 10 ? 2 : 0;
    if (width) { result += source.slice(start, cursor); cursor += width - 1; start = cursor + 1; }
    else cursor++;
  }
  return start === 0 ? source : result + source.slice(start);
}
