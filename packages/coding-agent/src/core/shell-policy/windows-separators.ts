/** PowerShell escapes with a backtick, in bare words and inside double quotes. */
export const POWERSHELL_ESCAPE = 96;
/** cmd escapes with a caret in bare words only. */
export const CMD_ESCAPE = 94;

/**
 * The existing scanners read words with Bash rules, where an unquoted backslash is an
 * escape. In PowerShell and cmd it is a path separator: `..\out\x` must not become
 * `..outx` inside the workspace. Give the scanners the equivalent Windows separator;
 * this is path spelling only, not new command grammar. Only unquoted words change:
 * Bash already keeps a backslash literal inside single quotes and before ordinary
 * characters in double quotes, and a quoted argument may be a nested script
 * (`bash -c '...'`) whose backslashes keep their own meaning. Returns `source` itself
 * when nothing changes, so the common case allocates nothing.
 */
export function respellUnquotedBackslashes(source: string, escape: number, escapeInDouble: boolean): string {
  if (!source.includes("\\")) return source;
  let quote = 0, spelled = "", start = 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (quote === 0) {
      if (code === escape) index++;
      else if (code === 39 || code === 34) quote = code;
      else if (code === 92) { spelled += source.slice(start, index) + "/"; start = index + 1; }
    } else if (quote === 34 && escapeInDouble && code === escape) index++;
    else if (code === quote) quote = 0; // '' and "" reopen at once, with the same effect.
  }
  return start === 0 ? source : spelled + source.slice(start);
}
