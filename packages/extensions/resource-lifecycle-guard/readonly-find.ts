import { NONNEGATIVE_INTEGER_PATTERN } from "./regex.ts";

// All accepted single-word operators only combine tests or print to stdout.
// Effectful actions (-exec, -delete, -fprint, ...) deliberately stay outside this set.
const READ_ONLY_OPERATORS: ReadonlySet<string> = new Set([
	"-o", "-or", "-a", "-and", "!", "-not", "(", ")", "-print", "-print0",
]);

/** Read-only effects classification; find itself still validates expression grammar. */
export function isReadOnlyFindTail(argv: readonly string[], commandIndex: number): boolean {
	if (argv[commandIndex + 1] !== ".") return false;
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
