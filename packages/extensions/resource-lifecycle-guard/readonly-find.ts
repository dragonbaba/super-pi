import { NONNEGATIVE_INTEGER_PATTERN } from "./regex.ts";

// All accepted single-word operators only combine tests or print to stdout.
// Effectful actions (-exec, -delete, -fprint, ...) deliberately stay outside this set.
const READ_ONLY_OPERATORS: ReadonlySet<string> = new Set([
	"-o", "-or", "-a", "-and", "!", "-not", "(", ")", "-print", "-print0",
]);
const RELATIVE_ROOT = /^[A-Za-z0-9_.][A-Za-z0-9_. /-]*$/;
const SORT_OPTIONS = /^-[urnVf]+$/;
const FIND_NEWER_PREDICATE = /^-newer[acmBt][acmBt]$/;
const FIND_OPERAND_PREDICATES = new Set([
	"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname",
	"-type", "-xtype", "-fstype", "-uid", "-gid", "-user", "-group", "-perm", "-links", "-inum", "-size", "-used",
	"-amin", "-atime", "-cmin", "-ctime", "-mmin", "-mtime", "-newer", "-anewer", "-cnewer", "-samefile",
	"-maxdepth", "-mindepth", "-regextype", "-context", "-printf", "-files0-from",
]);

/** Predicate/format arguments are data even when they spell an action. */
export function findPredicateHasOperand(word: string): boolean {
	return FIND_OPERAND_PREDICATES.has(word) || FIND_NEWER_PREDICATE.test(word);
}

/** One literal relative root; no options, devices, drives, expansion or UNC paths. */
export function isReadOnlyFindRoot(value: string | undefined): boolean {
	return value !== undefined && RELATIVE_ROOT.test(value);
}

/** Stdin-only sort. Do not admit output/temp paths, compressors or arbitrary options. */
export function isReadOnlySortTail(argv: readonly string[], commandIndex: number): boolean {
	for (let cursor = commandIndex + 1; cursor < argv.length; cursor++) if (!SORT_OPTIONS.test(argv[cursor]!)) return false;
	return true;
}

/** Read-only effects classification; find itself still validates expression grammar. */
export function isReadOnlyFindTail(argv: readonly string[], commandIndex: number): boolean {
	if (!isReadOnlyFindRoot(argv[commandIndex + 1])) return false;
	for (let cursor = commandIndex + 2; cursor < argv.length; cursor++) {
		const option = argv[cursor]!;
		if (READ_ONLY_OPERATORS.has(option)) continue;
		const operand = argv[++cursor];
		if (option === "-maxdepth" && operand && NONNEGATIVE_INTEGER_PATTERN.test(operand)) continue;
		if (option === "-type" && (operand === "d" || operand === "f")) continue;
		if ((option === "-iname" || option === "-name") && operand) continue;
		return false;
	}
	return true;
}
