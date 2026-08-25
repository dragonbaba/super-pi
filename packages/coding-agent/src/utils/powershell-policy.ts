const READ_ONLY_POWERSHELL_COMMANDS = new Set([
	"cat",
	"compare-object",
	"diff",
	"dir",
	"echo",
	"fl",
	"format-list",
	"format-table",
	"ft",
	"gc",
	"gci",
	"get-childitem",
	"get-content",
	"get-filehash",
	"get-item",
	"get-location",
	"gi",
	"gl",
	"ls",
	"measure",
	"measure-object",
	"out-string",
	"pwd",
	"resolve-path",
	"select-string",
	"sls",
	"sort",
	"sort-object",
	"test-path",
	"type",
	"write-output",
]);

function hasUnsafePowerShellCharacter(command: string): boolean {
	for (let index = 0; index < command.length; index++) {
		const code = command.charCodeAt(index);
		if (
			code === 0 ||
			code === 10 ||
			code === 13 ||
			code === 36 ||
			code === 38 ||
			code === 40 ||
			code === 41 ||
			code === 60 ||
			code === 62 ||
			code === 64 ||
			code === 91 ||
			code === 93 ||
			code === 96 ||
			code === 123 ||
			code === 125
		) {
			return true;
		}
	}
	return false;
}

function splitPowerShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || hasUnsafePowerShellCharacter(trimmed)) return undefined;
	const segments: string[] = [];
	let quote = 0;
	let start = 0;
	for (let index = 0; index < trimmed.length; index++) {
		const code = trimmed.charCodeAt(index);
		if (quote !== 0) {
			if (code === quote) quote = 0;
			continue;
		}
		if (code === 34 || code === 39) {
			quote = code;
			continue;
		}
		if (code !== 59 && code !== 124) continue;
		const segment = trimmed.slice(start, index).trim();
		if (!segment) return undefined;
		segments.push(segment);
		start = index + 1;
	}
	if (quote !== 0) return undefined;
	const finalSegment = trimmed.slice(start).trim();
	if (!finalSegment) return undefined;
	segments.push(finalSegment);
	return segments;
}

function powerShellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote = 0;
	for (let index = 0; index < segment.length; index++) {
		const code = segment.charCodeAt(index);
		if (quote !== 0) {
			if (code === quote) quote = 0;
			else word += segment[index];
			continue;
		}
		if (code === 34 || code === 39) {
			quote = code;
			continue;
		}
		if (code === 32 || code === 9) {
			if (word) {
				words.push(word);
				word = "";
			}
			continue;
		}
		word += segment[index];
	}
	if (quote !== 0) return undefined;
	if (word) words.push(word);
	return words;
}

function referencesNonFileProvider(value: string): boolean {
	const colon = value.indexOf(":");
	if (colon < 0) return false;
	if (colon === 1) {
		const drive = value.charCodeAt(0) | 0x20;
		if (drive >= 0x61 && drive <= 0x7a) return false;
	}
	return true;
}

function isReadOnlyPowerShellSegment(segment: string): boolean {
	const words = powerShellWords(segment);
	if (!words || words.length === 0) return false;
	const command = words[0]!.toLowerCase();
	if (!READ_ONLY_POWERSHELL_COMMANDS.has(command)) return false;
	for (let index = 1; index < words.length; index++) {
		if (referencesNonFileProvider(words[index]!.toLowerCase())) return false;
	}
	return true;
}

/**
 * Return the first PowerShell segment outside the conservative read-only
 * filesystem policy. Dynamic expressions, script blocks and redirection are
 * rejected before command classification.
 */
export function findUnsafePowerShellSegment(command: string): string | undefined {
	const segments = splitPowerShellSegments(command);
	if (!segments) return command.trim() || "(empty command)";
	for (const segment of segments) {
		if (!isReadOnlyPowerShellSegment(segment)) return segment;
	}
	return undefined;
}
