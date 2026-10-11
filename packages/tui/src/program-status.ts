/** Root-record OSC 7501 support. https://www.superlogical.com/rex/docs/build/program-status */
export type ProgramStatusState = "idle" | "working" | "blocked" | "done" | "error" | "clear";
export type ProgramStatusKind = "permission" | "question" | "auth";
export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
const REPLY_PATTERN = /^\x1b\]7501;\?(?::[^\x00-\x1f\x7f-\x9f]*)?(?:\x07|\x1b\\)$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]+/g;

export function isProgramStatusReply(sequence: string): boolean {
	return sequence.length <= 4096 && REPLY_PATTERN.test(sequence);
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
