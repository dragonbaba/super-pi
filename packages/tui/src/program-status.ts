/** Root-record OSC 7501 support. https://www.superlogical.com/rex/docs/build/program-status */
export type ProgramStatusState = "idle" | "working" | "blocked" | "done" | "error" | "clear";
export type ProgramStatusKind = "permission" | "question" | "auth";
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";
export const DEFAULT_PROGRAM_STATUS_CAPABILITIES = 0x071f;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const REPLY_PATTERN = /^\x1b\]7501;\?(?::[^\x00-\x1f\x7f-\x9f]*)?(?:\x07|\x1b\\)$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]+/g;

export function isProgramStatusReply(sequence: string): boolean {
	return sequence.length <= 4096 && REPLY_PATTERN.test(sequence);
}

function stateBit(state: string): number {
	switch (state) {
		case "idle": return 1;
		case "working": return 2;
		case "blocked": return 4;
		case "done": return 8;
		case "error": return 16;
		default: return 0;
	}
}
function kindBit(kind: string): number {
	switch (kind) {
		case "permission": return 1;
		case "question": return 2;
		case "auth": return 4;
		default: return 0;
	}
}

/** Startup-only parsing: five state bits and three kind bits, no retained reply. */
export function parseProgramStatusCapabilities(sequence: string): number {
	let capabilities = DEFAULT_PROGRAM_STATUS_CAPABILITIES;
	const end = sequence.length - (sequence.endsWith("\x07") ? 1 : 2);
	let start = 9; // ESC ] 7501 ; ? :
	while (start < end) {
		let next = sequence.indexOf(":", start);
		if (next < 0 || next > end) next = end;
		const equals = sequence.indexOf("=", start);
		if (equals > start && equals < next) {
			const key = sequence.slice(start, equals).trim();
			if (key === "states" || key === "kinds") {
				let mask = 0;
				let valueStart = equals + 1;
				while (valueStart < next) {
					let valueEnd = sequence.indexOf(",", valueStart);
					if (valueEnd < 0 || valueEnd > next) valueEnd = next;
					const value = sequence.slice(valueStart, valueEnd).trim();
					mask |= key === "states" ? stateBit(value) : kindBit(value);
					valueStart = valueEnd + 1;
				}
				capabilities = key === "states" ? (capabilities & 0x0700) | mask : (capabilities & 0x001f) | (mask << 8);
			}
		}
		start = next + 1;
	}
	return capabilities;
}

export function supportedProgramStatusState(state: ProgramStatusState, capabilities: number): ProgramStatusState {
	if (state === "clear" || (capabilities & stateBit(state)) !== 0) return state;
	return (capabilities & 1) !== 0 ? "idle" : "clear";
}

export function supportedProgramStatusKind(kind: ProgramStatusKind | undefined, capabilities: number): ProgramStatusKind | undefined {
	if (!kind || ((capabilities >> 8) & kindBit(kind)) !== 0) return kind;
	return (capabilities & 0x0200) !== 0 ? "question" : undefined;
}

/** Bound work and retained text before encoding; never split a UTF-8 code point. */
export function sanitizeProgramStatusMessage(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const bounded = text.slice(0, 2048).replace(CONTROLS, " ").trim();
	let bytes = 0;
	let end = 0;
	while (end < bounded.length) {
		const point = bounded.codePointAt(end)!;
		const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
		if (bytes + size > 2048) break;
		// A high surrogate cut at the input bound must not become a replacement character.
		if (point >= 0xd800 && point <= 0xdbff && end + 1 === bounded.length) break;
		bytes += size;
		end += point > 0xffff ? 2 : 1;
	}
	return bounded.slice(0, end) || undefined;
}

/** Called only for changed state. Primitive arguments avoid a per-report wrapper. */
export function formatProgramStatus(
	state: ProgramStatusState, message?: string, kind?: ProgramStatusKind, app?: string,
): string {
	let body = `\x1b]7501;state=${state}`;
	if (app && app.length <= 32 && APP_PATTERN.test(app)) body += `:app=${app}`;
	if (state === "blocked" && kind) body += `:kind=${kind}`;
	const safeMessage = sanitizeProgramStatusMessage(message);
	if (safeMessage) body += `:msg=${Buffer.from(safeMessage, "utf8").toString("base64")}`;
	return body + "\x1b\\";
}
