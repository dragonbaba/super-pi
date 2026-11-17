import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Producer-owned data, separate from decorated/truncated tool presentation. */
export type CapturedOutput = Readonly<
	{ kind: "text"; text: string } |
	{ kind: "file"; path: string; bytes: number; dev: number; ino: number; sha256: string; capped: boolean }
>;
const CAPTURED_OUTPUT = Symbol.for("super-pi.captured-output.v1");

export function attachCapturedOutput<T extends { type: string; text?: string }[]>(content: T, source: CapturedOutput): T {
	Object.defineProperty(content, CAPTURED_OUTPUT, { value: Object.freeze({ source: Object.freeze(source), block: content[0], text: content[0]?.text }) });
	return content;
}

export function capturedOutput(content: object): CapturedOutput | undefined {
	const capture = (content as Record<symbol, { source: CapturedOutput; block: unknown; text?: string } | undefined>)[CAPTURED_OUTPUT];
	// A hook that replaces/redacts the presentation must opt out of the original raw data.
	return capture && Array.isArray(content) && content.length === 1 && content[0] === capture.block
		&& content[0]?.text === capture.text ? capture.source : undefined;
}

/** Read only a producer-issued file, never a caller-supplied path or a new command.
 * Hash the original buffers while writing; verify this exact capture before parsing.
 * Historical output deliberately supplies no mutation read evidence.
 */
export async function readCapturedOutput(source: CapturedOutput, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	if (source.kind === "text") return source.text;
	if (source.capped) throw new Error("[OUTPUT_INCOMPLETE] The saved output is capped; it is not a complete document. Do not repeat completed commands.");
	const file = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await file.stat();
		if (!before.isFile() || before.dev !== source.dev || before.ino !== source.ino || before.size !== source.bytes) throw new Error("[OUTPUT_CHANGED] The captured output file changed or was replaced.");
		const buffer = Buffer.allocUnsafe(source.bytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			signal?.throwIfAborted();
			const read = await file.read(buffer, offset, buffer.length - offset, offset);
			if (!read.bytesRead) break;
			offset += read.bytesRead;
		}
		const after = await file.stat();
		signal?.throwIfAborted();
		if (offset !== source.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs
			|| createHash("sha256").update(buffer.subarray(0, offset)).digest("hex") !== source.sha256) throw new Error("[OUTPUT_CHANGED] The captured output contents changed.");
		return buffer.toString("utf8", 0, offset);
	} finally { await file.close(); }
}
