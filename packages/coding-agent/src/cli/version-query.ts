/** Keep mixed arguments on the full parser's existing precedence/error path. */
export function isStandaloneVersionQuery(args: readonly string[]): boolean {
	let version = false;
	for (const arg of args) {
		if (arg === "--version" || arg === "-v") version = true;
		else if (arg !== "--offline") return false;
	}
	return version;
}
