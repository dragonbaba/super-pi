// GNU sort's complete long_options catalog: 30 names plus its NULL sentinel.
// https://github.com/coreutils/coreutils/blob/master/src/sort.c
const SORT_LONG_OPTIONS = [
  "ignore-leading-blanks", "check", "compress-program", "debug", "dictionary-order",
  "ignore-case", "files0-from", "general-numeric-sort", "ignore-nonprinting", "key",
  "merge", "month-sort", "numeric-sort", "human-numeric-sort", "version-sort",
  "random-sort", "random-source", "sort", "output", "reverse", "stable", "batch-size",
  "buffer-size", "field-separator", "temporary-directory", "unique", "zero-terminated",
  "parallel", "help", "version",
] as const;
const SORT_REQUIRED_VALUES = new Set<string>([
  "compress-program", "files0-from", "key", "random-source", "sort", "output", "batch-size",
  "buffer-size", "field-separator", "temporary-directory", "parallel",
]);

/** getopt_long: exact match wins, otherwise exactly one prefix. Empty denotes an
 * ambiguous option (sort exits); undefined denotes an unknown option (opaque).
 * Compare spans without constructing a per-option substring or result object. */
export function sortLongOption(token: string, end: number): string | undefined {
  let match: string | undefined, ambiguous = false;
  for (const name of SORT_LONG_OPTIONS) {
    if (end - 2 > name.length) continue;
    let index = 2;
    while (index < end && token.charCodeAt(index) === name.charCodeAt(index - 2)) index++;
    if (index !== end) continue;
    if (end - 2 === name.length) return name;
    if (match !== undefined) ambiguous = true;
    match = name;
  }
  return ambiguous ? "" : match;
}

export function sortOptionRequiresValue(name: string): boolean { return SORT_REQUIRED_VALUES.has(name); }
