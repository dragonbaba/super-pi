export function safeGoalMenuText(value: string, maxCharacters = 120) {
	const sanitized = [...value]
		.map((character) => (isTerminalControl(character) ? " " : character))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...sanitized];
	return characters.length <= maxCharacters
		? sanitized
		: `${characters.slice(0, maxCharacters).join("")}…`;
}

function isTerminalControl(character: string) {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}
