export type StructuredReadonlyCommandName = "git" | "rg";

export interface StructuredReadonlyArgumentClassification {
  pathArguments: readonly string[];
  rgSearchPaths: readonly string[];
  rgOptionPaths: readonly string[];
  rgUnboundDashArguments: readonly string[];
}

const EMPTY_ARGUMENTS: readonly string[] = Object.freeze([]);
const RG_REGEXP_PREFIX = "--regexp=";
const RG_FILE_PREFIX = "--file=";
const RG_IGNORE_FILE_PREFIX = "--ignore-file=";
const RG_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  "-A", "--after-context", "-B", "--before-context", "-C", "--context",
  "-E", "--encoding", "-e", "--regexp", "-f", "--file", "-g", "--glob",
  "--iglob", "--ignore-file", "-j", "--threads", "-m", "--max-count",
  "-M", "--max-columns", "--max-depth", "--max-filesize", "--path-separator",
  "-r", "--replace", "--sort", "--sortr", "-t", "--type", "--type-add",
  "--type-clear",
]);
const RG_PATTERN_VALUE_OPTIONS = new Set(["-e", "--regexp", "-f", "--file"]);
const RG_PATH_VALUE_OPTIONS = new Set(["-f", "--file", "--ignore-file"]);

function attachedLongValue(argument: string, prefix: string): string | undefined {
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined;
}

/**
 * Classify structured read-only argv by command grammar. Only returned path
 * arguments may participate in workspace authorization; regexes and other
 * option values are deliberately excluded.
 */
export function classifyStructuredReadonlyArguments(
  command: StructuredReadonlyCommandName,
  args: readonly string[],
): StructuredReadonlyArgumentClassification {
  if (command === "git") {
    return {
      pathArguments: args,
      rgSearchPaths: EMPTY_ARGUMENTS,
      rgOptionPaths: EMPTY_ARGUMENTS,
      rgUnboundDashArguments: EMPTY_ARGUMENTS,
    };
  }

  const searchPaths: string[] = [];
  const optionPaths: string[] = [];
  const unboundDashArguments: string[] = [];
  let expectedOption: string | undefined;
  let patternProvidedByOption = false;
  let positionalPatternSeen = false;
  let optionsEnded = false;

  for (const argument of args) {
    if (expectedOption !== undefined) {
      if (RG_PATTERN_VALUE_OPTIONS.has(expectedOption)) patternProvidedByOption = true;
      if (RG_PATH_VALUE_OPTIONS.has(expectedOption)) optionPaths.push(argument);
      expectedOption = undefined;
      continue;
    }
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded) {
      const regexpValue = attachedLongValue(argument, RG_REGEXP_PREFIX);
      if (regexpValue !== undefined || (argument.startsWith("-e") && !argument.startsWith("--") && argument.length > 2)) {
        patternProvidedByOption = true;
        continue;
      }
      const fileValue = attachedLongValue(argument, RG_FILE_PREFIX);
      if (fileValue !== undefined) {
        patternProvidedByOption = true;
        optionPaths.push(fileValue);
        continue;
      }
      if (argument.startsWith("-f") && !argument.startsWith("--") && argument.length > 2) {
        patternProvidedByOption = true;
        optionPaths.push(argument.slice(2));
        continue;
      }
      const ignoreFileValue = attachedLongValue(argument, RG_IGNORE_FILE_PREFIX);
      if (ignoreFileValue !== undefined) {
        optionPaths.push(ignoreFileValue);
        continue;
      }
      if (RG_OPTIONS_WITH_SEPARATE_VALUE.has(argument)) {
        expectedOption = argument;
        continue;
      }
      if (argument === "--files") {
        patternProvidedByOption = true;
        continue;
      }
      if (argument.startsWith("-")) {
        if (!patternProvidedByOption && !positionalPatternSeen) unboundDashArguments.push(argument);
        continue;
      }
    }

    if (patternProvidedByOption || positionalPatternSeen) searchPaths.push(argument);
    else positionalPatternSeen = true;
  }

  return {
    pathArguments: [...optionPaths, ...searchPaths],
    rgSearchPaths: searchPaths,
    rgOptionPaths: optionPaths,
    rgUnboundDashArguments: unboundDashArguments,
  };
}
