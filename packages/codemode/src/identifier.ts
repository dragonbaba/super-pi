/**
 * The identifier a script uses for a tool: characters that are not valid in a JavaScript
 * identifier become `_`. `mcp__docs__search` stays as is, `my-tool` becomes `my_tool`.
 */
export function toCodemodeIdentifier(name: string): string {
	let identifier = "";
	for (const char of name) {
		const code = char.charCodeAt(0);
		const valid = code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95 || code === 36
			|| identifier !== "" && code >= 48 && code <= 57;
		identifier += valid ? char : "_";
	}
	return identifier === "" ? "_" : identifier;
}

/**
 * Collision-free identifiers for one catalog. A name that is already an identifier keeps it;
 * any other name takes its normalized form, or `_2`, `_3`, ... when that form is taken
 * (`foo-bar` beside `foo_bar` becomes `foo_bar_2`). Names are visited in sorted order, so
 * every caller holding the same set of names derives the same mapping.
 */
export function assignCodemodeIdentifiers(names: Iterable<string>): Map<string, string> {
	const sorted = Array.from(names).sort();
	const used = new Set<string>();
	for (const name of sorted) if (toCodemodeIdentifier(name) === name) used.add(name);
	const identifiers = new Map<string, string>();
	for (const name of sorted) {
		const base = toCodemodeIdentifier(name);
		let identifier = base;
		if (base !== name) {
			for (let suffix = 2; used.has(identifier); suffix++) identifier = `${base}_${suffix}`;
			used.add(identifier);
		}
		identifiers.set(name, identifier);
	}
	return identifiers;
}
