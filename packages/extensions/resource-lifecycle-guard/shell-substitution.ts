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
export function extractCommandSubstitutions(command: string): CommandSubstitutionScan {
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
    if (code === 39 && quote === 0) {
      quote = 39;
      continue;
    }
    if (code === 34 && (quote === 0 || quote === 34)) {
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
      if (inner === 40) depth += 1;
      else if (inner === 41 && --depth === 0) break;
    }
    if (end >= command.length) return { scripts, unterminated: true };
    if (scripts.length < MAX_SUBSTITUTIONS) scripts.push(command.slice(index + 2, end));
    else return { scripts, unterminated: true };
    index = end;
  }
  return { scripts, unterminated: false };
}
