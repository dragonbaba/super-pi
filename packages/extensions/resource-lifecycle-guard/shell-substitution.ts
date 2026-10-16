import {
	CASE_WORD_END_PATTERN,
	COMMAND_START_KEYWORD_PATTERN,
	COMMENT_BOUNDARY_PATTERN,
	SUBSTITUTION_COMMENT_BOUNDARY_PATTERN,
} from "./regex.ts";
import { isSimpleBashAnsiCQuote, shellRedirectionLength } from "./shell-redirection.ts";
export interface CommandSubstitutionScan {
  scripts: string[];
  unterminated: boolean;
  /** Grammar or budget could not be inspected; not proof of termination or safety. */
  unsupported: boolean;
  limitExceeded: false | "count" | "nesting";
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

/** Closing delimiter index, -1 for unterminated input, -2 for unsupported grammar, -3 for nesting exhaustion.
 * Shared with argv scanners so substitution operators never become outer segments.
 * Returns only a primitive; callers retain the original word and inspect its body separately.
 */
export function commandSubstitutionEnd(command: string, start: number, nesting = 0): number {
  if (nesting >= MAX_SUBSTITUTION_NESTING) return -3;
  if (command.charCodeAt(start) === 96) {
    let escaped = false;
    for (let end = start + 1; end < command.length; end++) {
      const inner = command.charCodeAt(end);
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
  for (let end = start + 2; end < command.length; end++) {
    const inner = command.charCodeAt(end);
    if (escaped) { escaped = false; continue; }
    if (inner === 92 && quote !== 39) {
      if (command[end + 1] !== "\n") commandStart = false;
      escaped = true;
      continue;
    }
    if (quote === 39) { if (inner === 39) quote = 0; continue; }
    // Nested substitutions have their own quoting context, even inside double quotes.
    if (inner === 96 || inner === 36 && command.charCodeAt(end + 1) === 40 && command.charCodeAt(end + 2) !== 40) {
      const nestedEnd = commandSubstitutionEnd(command, end, nesting + 1);
      if (nestedEnd < 0) return nestedEnd;
      end = nestedEnd;
      commandStart = false;
      continue;
    }
    if (quote === 34) { if (inner === 34) quote = 0; continue; }
    // An escaped apostrophe in ANSI-C quoting is not a closing quote. Refuse
    // escapes the argv scanners cannot decode instead of truncating the body.
    if (inner === 36 && command.charCodeAt(end + 1) === 39 && !isSimpleBashAnsiCQuote(command, end)) return -2;
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
    if (inner === 123 && CASE_WORD_END_PATTERN.test(command[end + 1] ?? "")) { commandStart = true; continue; }
    if (commandStart) {
      if ((command.startsWith("time", end) && CASE_WORD_END_PATTERN.test(command[end + 4] ?? ""))
        || (command.startsWith("coproc", end) && CASE_WORD_END_PATTERN.test(command[end + 6] ?? ""))
        || (command.startsWith("case", end) && CASE_WORD_END_PATTERN.test(command[end + 4] ?? ""))) return -2;
      const keyword = COMMAND_START_KEYWORD_PATTERN.exec(command.slice(end, end + 7));
      if (keyword) { end += keyword[0].length - 1; continue; }
      commandStart = false;
    }
    if (inner === 40) { depth++; commandStart = true; }
    else if (inner === 41 && --depth === 0) return end;
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
    if (code !== 96 && (code !== 36 || command.charCodeAt(index + 1) !== 40 || command.charCodeAt(index + 2) === 40)) continue;
    if (scripts.length === MAX_SUBSTITUTIONS) return { scripts, unterminated: false, unsupported: true, limitExceeded: "count" };
    const end = commandSubstitutionEnd(command, index);
    if (end < 0) return { scripts, unterminated: end === -1, unsupported: end !== -1, limitExceeded: end === -3 ? "nesting" : false };
    scripts.push(command.slice(index + (code === 96 ? 1 : 2), end));
    index = end;
  }
  return { scripts, unterminated: false, unsupported: false, limitExceeded: false };
}


/** Detection only: actual heredocs are unsupported; never remove source/body text. */
export function inspectHereDocuments(command: string): { command: string; substitutions: string[]; uncertain: boolean; heredoc?: true } {
 let quote = ""; let escaped = false; let arithmeticDepth = 0;
 for (let index = 0; index < command.length; index++) {
  const c = command[index];
  if (escaped) { escaped = false; continue; }
  if (c === "\\" && quote !== "'") { escaped = true; continue; }
  if (quote) { if (c === quote) quote = ""; continue; }
  if (c === "'" || c === '"') { quote = c; continue; }
  if (c === "#" && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!))) {
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
  substitutionUncertain?: boolean;
  /** Unknown body boundaries may hide executable input or following commands. */
  unboundedHeredoc?: boolean;
  hereDocuments?: { header: string; pipelineHeader?: string; contextEnd: number; bodyEnd: number; body: string; expanded: boolean; priorSource: boolean; descriptor: number }[];
}

function maskShellRange(output: string[] | undefined, start: number, end: number): void {
  if (!output) return;
  for (let index = start; index < end; index++) {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  }
}

interface HereDelimiter {
  descriptors: number[];
  value: string;
  quoted: boolean;
  stripTabs: boolean;
  maskStart: number;
  maskEnd: number;
  headerEnd: number;
  pipelineEnd: number;
}

interface HereDelimiterScan {
  delimiters: HereDelimiter[];
  uncertain: boolean;
}

function isShellWordBoundary(c: string | undefined): boolean {
  return c === undefined || c === " " || c === "\t" || c === "\r" || c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">";
}

/** Numeric literal copy, including quoted digits; moves encode -(fd + 2).
 * -1 means unknown/closure. No shell expansion or retained binding state. */
function heredocDescriptorCopy(command: string, start: number, end: number): number {
  while (start < end && (command[start] === " " || command[start] === "\t")) start++;
  let quote = "", value = 0, digits = 0, move = false;
  for (; start < end; start++) {
    let c = command[start]!;
    if (quote) { if (c === quote) { quote = ""; continue; } }
    else {
      if (c === "'" || c === '"') { quote = c; continue; }
      if (isShellWordBoundary(c)) break;
      if (c === "\\") {
        c = command[++start] ?? "";
        if (c === "\n") continue;
      }
    }
    if (c === "-" && digits && !move) { move = true; continue; }
    const code = c.charCodeAt(0);
    if (move || code < 48 || code > 57) return -1;
    value = value * 10 + code - 48; digits++;
    if (!Number.isSafeInteger(value + 2)) return -1;
  }
  return quote || !digits ? -1 : move ? -(value + 2) : value;
}

function collectHereDelimiters(command: string, start: number, end: number): HereDelimiterScan {
  const delimiters: HereDelimiter[] = [];
  let quote = "";
  let escaped = false;
  let arithmeticDepth = 0;
  let uncertain = false;
  let pendingHeader = 0;
  let pendingPipeline = 0;
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
    if (comment || c === ";" || c === "(" || c === ")" || c === "&" && command[index - 1] !== ">" && command[index - 1] !== "<" && command[index - 1] !== "|" && command[index + 1] !== ">"
      || c === "|" && (command[index + 1] === "|" || command[index - 1] === "|")) {
      while (pendingPipeline < delimiters.length) delimiters[pendingPipeline++]!.pipelineEnd = index;
    }
    if (comment || c === ";" || c === "|" || c === "(" || c === ")" || c === "&" && command[index - 1] !== ">" && command[index - 1] !== "<" && command[index + 1] !== ">") {
      // A redirect may precede its executable. Retain its entire simple command,
      // but never borrow a consumer from the following pipeline/list member.
      while (pendingHeader < delimiters.length) delimiters[pendingHeader++]!.headerEnd = index;
      if (comment) break;
    }
    if (c !== "<" && c !== ">") continue;
    let maskStart = index;
    let descriptor = c === "<" ? 0 : 1;
    let fdStart = index;
    while (fdStart > 0 && command.charCodeAt(fdStart - 1) >= 48 && command.charCodeAt(fdStart - 1) <= 57) fdStart--;
    if (fdStart < index && isShellWordBoundary(command[fdStart - 1])) {
      descriptor = Number(command.slice(fdStart, index));
      maskStart = fdStart;
    }
    // Preserve aliases before rebinding/closing a descriptor. Only this simple
    // command participates; each call-owned list is capped at 16 descriptors.
    const copy = command[index + 1] === "&" ? heredocDescriptorCopy(command, index + 2, end) : -1;
    const sourceDescriptor = copy < -1 ? -copy - 2 : copy;
    for (let prior = pendingHeader; prior < delimiters.length; prior++) {
      const descriptors = delimiters[prior]!.descriptors;
      const copied = sourceDescriptor >= 0 && descriptors.includes(sourceDescriptor);
      let kept = 0;
      for (const bound of descriptors) if (bound !== descriptor && !(copy < -1 && bound === sourceDescriptor) && !(c === ">" && command[index - 1] === "&" && bound === 2)) descriptors[kept++] = bound;
      descriptors.length = kept;
      if (copied) {
        if (descriptors.length === MAX_SUBSTITUTIONS) uncertain = true;
        else descriptors.push(descriptor);
      }
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
        while (cursor < end && command[cursor] !== delimiterQuote) cursor++;
        if (cursor >= end) return { delimiters, uncertain: true };
        value += command.slice(valueStart, cursor++);
      } else {
        const valueStart = cursor;
        while (cursor < end && !isShellWordBoundary(command[cursor]) && command[cursor] !== "'" && command[cursor] !== '"') cursor++;
        value += command.slice(valueStart, cursor);
      }
    }
    if (value.includes("$") || value.includes("`") || value.includes("\\")) uncertain = true;
    if (delimiters.length === MAX_SUBSTITUTIONS) return { delimiters, uncertain: true };
    if (value) delimiters.push({ descriptors: [descriptor], value, quoted, stripTabs, maskStart, maskEnd: cursor, headerEnd: end, pipelineEnd: end });
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
  let substitutionUncertain = false;
  let unboundedHeredoc = false;
  let logicalLineStart = 0;
  let hereDocuments: ShellAnalysisView["hereDocuments"];
  for (let index = 0; index < command.length; index++) {
    const c = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\n") { logicalLineStart = index + 1; continue; }
    if (c === "#" && (index === 0 || COMMENT_BOUNDARY_PATTERN.test(command[index - 1]!))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      logicalLineStart = newline + 1;
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
    if (c !== "<" || command[index + 1] !== "<" || command[index + 2] === "<") continue;
    hasHeredoc = true;
    output ??= command.split("");
    const operatorStart = index;
    const lineEnd = heredocDeclarationEnd(command, index + 2);
    if (lineEnd >= 0) {
      const headerSubstitutions = extractCommandSubstitutions(command.slice(operatorStart, lineEnd));
      if (headerSubstitutions.unterminated || headerSubstitutions.unsupported) substitutionUncertain = uncertain = true;
    }
    const delimiterScan = lineEnd < 0 ? { delimiters: [], uncertain: true } : collectHereDelimiters(command, operatorStart, lineEnd);
    const delimiters = delimiterScan.delimiters;
    uncertain ||= delimiterScan.uncertain;
    for (const delimiter of delimiters) maskShellRange(output, delimiter.maskStart, delimiter.maskEnd);
    if (delimiters.length === 0 || lineEnd < 0) {
      uncertain = true;
      unboundedHeredoc = true;
      maskShellRange(output, operatorStart, Math.min(command.length, operatorStart + 2));
      break;
    }
    let bodyStart = lineEnd + 1;
    for (const delimiter of delimiters) {
      if (delimiterScan.uncertain) {
        uncertain = true;
        unboundedHeredoc = true;
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
        let contentEnd = end > bodyStart && command.charCodeAt(end - 1) === 13 ? end - 1 : end;
        let backslashes = 0;
        if (!delimiter.quoted && nextLine >= 0) for (let cursor = contentEnd - 1; cursor >= bodyStart && command.charCodeAt(cursor) === 92; cursor--) backslashes++;
        const continued = backslashes % 2 === 1;
        if (continued) contentEnd--;
        let cursor = bodyStart;
        if (delimiter.stripTabs && delimiterMatched === 0) while (cursor < contentEnd && command.charCodeAt(cursor) === 9) cursor++;
        for (; cursor < contentEnd; cursor++) {
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
        unboundedHeredoc = true;
        maskShellRange(output, contentStart, command.length);
        bodyStart = command.length;
        break;
      }
      const rawBody = command.slice(contentStart, delimiterLineStart);
      const body = delimiter.quoted ? rawBody : removeHeredocContinuations(rawBody);
      let expanded = false;
      if (!delimiter.quoted) {
        for (let cursor = 0; cursor < body.length; cursor++) {
          if (body[cursor] === "\\") { cursor++; continue; }
          if (body[cursor] === "$" || body[cursor] === "`") { expanded = true; break; }
        }
        const nested = extractCommandSubstitutions(body, true);
        for (const script of nested.scripts) {
          if (substitutions.length < MAX_SUBSTITUTIONS) substitutions.push(script);
          else substitutionUncertain = uncertain = true;
        }
        if (nested.unterminated || nested.unsupported) substitutionUncertain = uncertain = true;
      }
      hereDocuments ??= [];
      if (delimiter.descriptors.length) {
        const header = command.slice(logicalLineStart, delimiter.headerEnd);
        const pipelineHeader = delimiter.pipelineEnd > delimiter.headerEnd ? command.slice(logicalLineStart, delimiter.pipelineEnd) : undefined;
        for (const descriptor of delimiter.descriptors) {
          if (hereDocuments.length < MAX_SUBSTITUTIONS) hereDocuments.push({ header, pipelineHeader, contextEnd: delimiter.pipelineEnd, bodyEnd, body, expanded, priorSource: logicalLineStart > 0, descriptor });
          else substitutionUncertain = uncertain = true;
        }
      }
      maskShellRange(output, contentStart, bodyEnd);
      const delimiterLineEnd = command.indexOf("\n", bodyEnd);
      bodyStart = delimiterLineEnd < 0 ? command.length : delimiterLineEnd + 1;
      maskShellRange(output, bodyEnd, bodyStart);
    }
    index = bodyStart - 1;
    logicalLineStart = bodyStart;
  }
  if (arithmeticDepth !== 0) uncertain = true;
  return { command: output ? output.join("") : command, substitutions, uncertain, hasHeredoc, substitutionUncertain, unboundedHeredoc, hereDocuments };
}

/** One bounded normalized body only when Bash removes a continuation. The
 * original input/mask offsets remain unchanged; no line array is retained. */
function removeHeredocContinuations(source: string): string {
  let result = "", start = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (source.charCodeAt(cursor) !== 92) continue;
    const next = source.charCodeAt(cursor + 1);
    const width = next === 10 ? 2 : next === 13 && source.charCodeAt(cursor + 2) === 10 ? 3 : 0;
    if (width) { result += source.slice(start, cursor); cursor += width - 1; start = cursor + 1; }
    else cursor++;
  }
  return start === 0 ? source : result + source.slice(start);
}
