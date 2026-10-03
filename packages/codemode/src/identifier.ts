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
