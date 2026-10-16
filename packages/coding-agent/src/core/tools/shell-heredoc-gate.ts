import { MAX_BOUND_SHELL_INPUT_BYTES } from "./bounded-shell-input.ts";

/** 0: no visible heredoc; 1: general heredoc; 2: legacy bounded input.
 * One forward scan, primitive locals only: no AST, substrings, regex matches,
 * reconstructed source or retained references. Classification 2 preserves the
 * existing standalone-input diagnostic without materializing its analysis view. */
export function shellHeredocKind(command: string): number {
  const result = scanHeredocSyntax(command, 0, 0, 0);
  return result < 0 ? -result : 0;
}

function scanHeredocSyntax(command: string, start: number, closing: number, depth: number): number {
  let arithmetic = closing === 256 ? 2 : 0;
  const nameEnd = start === 0 && closing === 0 ? command.startsWith("cat") ? 3 : command.startsWith("node") ? 4 : 0 : 0;
  let boundedPrefix = nameEnd > 0;
  for (let index = start; index < command.length; index++) {
    const code = command.charCodeAt(index), next = command.charCodeAt(index + 1);
    // Extremely nested syntax is scanned conservatively, without an unbounded
    // recursion stack. It still does not refuse source lacking a << candidate.
    if (depth >= 64) {
      if (code === 60 && next === 60 && command.charCodeAt(index + 2) !== 60) return -1;
      continue;
    }
    if (closing !== 0 && closing !== 256 && code === closing) return index;
    if (code === 92) { boundedPrefix = false; index++; continue; }
    if (code === 36 && next === 123) {
      const end = scanHeredocSyntax(command, index + 2, 125, depth + 1);
      if (end < 0) return end;
      boundedPrefix = false; index = end; continue;
    }
    if (code === 36 && next === 40) {
      const nestedArithmetic = command.charCodeAt(index + 2) === 40;
      const end = scanHeredocSyntax(command, index + (nestedArithmetic ? 3 : 2), nestedArithmetic ? 256 : 41, depth + 1);
      if (end < 0) return end;
      boundedPrefix = false; index = end; continue;
    }
    if (code === 96) {
      const end = scanHeredocSyntax(command, index + 1, 96, depth + 1);
      if (end < 0) return end;
      boundedPrefix = false; index = end; continue;
    }
    if (arithmetic) {
      if (code === 40) arithmetic++;
      if (code === 41 && --arithmetic === 0) return index;
      continue;
    }
    if (closing === 93 || closing === 34) continue;
    if (closing === 125 && (code === 60 || code === 62) && next === 40) {
      const end = scanHeredocSyntax(command, index + 2, 41, depth + 1);
      if (end < 0) return end;
      index = end; continue;
    }
    if (code === 36 && next === 91 || code === 40 && closing !== 125) {
      const arithmeticStart = code === 40 && next === 40;
      const end = scanHeredocSyntax(command, index + (code === 36 || arithmeticStart ? 2 : 1), code === 36 ? 93 : arithmeticStart ? 256 : 41, depth + 1);
      if (end < 0) return end;
      boundedPrefix = false; index = end; continue;
    }
    if (code === 39 || code === 34) {
      boundedPrefix = false;
      if (code === 34) {
        const end = scanHeredocSyntax(command, index + 1, 34, depth + 1);
        if (end < 0) return end;
        index = end;
      } else {
        const ansi = command.charCodeAt(index - 1) === 36;
        while (++index < command.length) {
          if (command.charCodeAt(index) === 39) break;
          if (ansi && command.charCodeAt(index) === 92) index++;
        }
      }
      continue;
    }
    // Parameter words are expanded data. Only the nested substitutions handled
    // above introduce executable shell syntax; literal << is not a redirection.
    if (closing === 125) continue;
    const previous = command.charCodeAt(index - 1);
    if (code === 35 && (index === start || previous <= 32 || previous === 59 || previous === 124 || previous === 38 || previous === 40 || previous === 41)) {
      boundedPrefix = false;
      while (index < command.length && command.charCodeAt(index) !== 10) index++;
      continue;
    }
    if (code === 60) {
      let second = index + 1;
      while (command.charCodeAt(second) === 92 && command.charCodeAt(second + 1) === 10) second += 2;
      if (command.charCodeAt(second) === 60) {
        if (command.charCodeAt(second + 1) === 60) { boundedPrefix = false; index = second + 1; continue; }
        return boundedPrefix && second === index + 1 && index > nameEnd ? -classifyBoundedBody(command, second + 1) : -1;
      }
    }
    if (index >= nameEnd && code !== 32 && code !== 9) boundedPrefix = false;
  }
  return command.length;
}

function classifyBoundedBody(command: string, index: number): number {
  if (command.charCodeAt(index++) !== 39) return 1;
  const delimiterStart = index;
  while (index < command.length) {
    const code = command.charCodeAt(index);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 || index > delimiterStart && code >= 48 && code <= 57)) break;
    index++;
  }
  const length = index - delimiterStart;
  if (length < 1 || length > 32 || command.charCodeAt(index++) !== 39) return 1;
  while (command.charCodeAt(index) === 32 || command.charCodeAt(index) === 9) index++;
  if (command.charCodeAt(index++) !== 10) return 1;
  let bytes = index, matched = 0;
  for (; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (code === 0 || code === 13) return 1;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
    if (code >= 0xd800 && code <= 0xdbff && command.charCodeAt(index + 1) >= 0xdc00 && command.charCodeAt(index + 1) <= 0xdfff) { bytes++; index++; matched = -1; }
    if (bytes > MAX_BOUND_SHELL_INPUT_BYTES) return 1;
    if (code === 10) {
      if (matched === length) return index === command.length - 1 ? 2 : 1;
      matched = 0;
    } else if (matched >= 0) matched = matched < length && code === command.charCodeAt(delimiterStart + matched) ? matched + 1 : -1;
  }
  return matched === length ? 2 : 1;
}

export const CUSTOM_HEREDOC_REFUSAL = "[SHELL_HEREDOC] Bash not executed: heredoc consumers cannot be inspected with commandPrefix, a custom spawnHook or a changed backend.\nRetry: use the unchanged built-in Bash backend without a command prefix or custom spawn hook, or submit an inspectable command without heredoc input; resubmit for authorization.";
