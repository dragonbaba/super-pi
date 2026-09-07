import { createHash, createHmac } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";

export const READ_SMALL_FILE_BYTES = 256 * 1024;
export const READ_CHUNK_BYTES = 256 * 1024;
// Invalid UTF-8 can expand to three output bytes per source byte. These limits
// keep even that case below the existing 50 KiB output ceiling.
export const READ_WINDOW_BYTES = 16 * 1024;
export const READ_WINDOW_CODE_UNITS = 16 * 1024;
export const READ_CURSOR_MAX_CHARS = 8192;
const VERSION = 1;

/** @internal Nonserializing metadata handoff; never attached to public details. */
export const READ_EVIDENCE_CAPTURE = Symbol("read-evidence-capture");
export const READ_EVIDENCE_IDENTITY = Symbol("read-evidence-identity");
export interface ValidatedReadIdentity {
	canonicalPath: string;
	fileGeneration: string;
	precise: boolean;
	location: string;
}
export function createValidatedReadIdentity(): ValidatedReadIdentity {
	return { canonicalPath: "", fileGeneration: "", precise: false, location: "" };
}
export function readFileGeneration(info: BigIntStats): string {
	return generation(info);
}
export function hasPreciseReadIdentity(info: BigIntStats): boolean {
	return info.isFile() && info.ino > 0n && info.size >= 0n &&
		typeof info.mtimeNs === "bigint" && typeof info.ctimeNs === "bigint" &&
		info.mtimeNs > 0n && info.ctimeNs > 0n &&
		info.mtimeNs % 1_000_000n !== 0n && info.ctimeNs % 1_000_000n !== 0n;
}
function handoffIdentity(target: ValidatedReadIdentity | undefined, canonical: string, info: BigIntStats, location: string): void {
	if (!target) return;
	target.canonicalPath = canonical;
	target.fileGeneration = generation(info);
	target.precise = hasPreciseReadIdentity(info);
	target.location = location;
}
export function attachReadIdentity<T extends object>(result: T, identity: ValidatedReadIdentity | undefined): T {
	if (identity?.precise) Object.defineProperty(result, READ_EVIDENCE_IDENTITY, { value: identity });
	return result;
}

export class ReadCursorError extends Error {
	readonly code: "invalid-cursor" | "stale-cursor";
	constructor(code: "invalid-cursor" | "stale-cursor") {
		super(code === "stale-cursor" ? "Stale read cursor: file changed or disappeared. Read again without cursor." : "Invalid read cursor or workspace/session scope. Read again without cursor.");
		this.name = "ReadCursorError";
		this.code = code;
	}
}

export class UnreliableReadSizeError extends Error {
	readonly code = "unreliable-size";
	constructor() {
		super("File content exceeds its reported size; use a regular-file snapshot for safe continuation.");
		this.name = "UnreliableReadSizeError";
	}
}

interface Cursor {
	v: number;
	path: string;
	scope: string;
	generation: string;
	encoding: string;
	byte: number;
	line: number;
	partial: boolean;
}

export interface ReadWindowInput { offset?: number; limit?: number; cursor?: string }
export interface ReadWindowResult {
	text: string;
	startByte: number;
	nextByte: number;
	endByte: number;
	startLine: number;
	nextLine: number;
	partial: boolean;
	startsPartial: boolean;
	done: boolean;
	cursor?: string;
	binary: boolean;
}

export function createReadWindowCounters() {
	return {
		bytesRead: 0, decodedCharacters: 0, separatorsInspected: 0, scanBytes: 0,
		maximumRetainedChunk: 0, lineArrayEntries: 0, completeFileCopies: 0,
		bufferAllocations: 0, decodersCreated: 0, decoderFlushes: 0,
		fileOpens: 0, fileCloses: 0, continuationCount: 0, cursorSize: 0,
		readCalls: 0, bufferViews: 0, decodedStrings: 0, outputAppends: 0, maximumOutputCodeUnits: 0,
		eofProbes: 0, eofProbeBytes: 0, shortReadFillCalls: 0, shortReadBytes: 0,
		unreliableSizeDetections: 0, zeroProgressPrevented: 0,
	};
}
export type ReadWindowCounters = ReturnType<typeof createReadWindowCounters>;

function generation(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}`;
}

/** Simple small-file snapshot: bounded allocation and positional reads through EOF.
 * A changed or large file goes back to the window scanner, never to readFile.
 */
export async function readSmallFileIfStable(path: string, signal?: AbortSignal, evidenceIdentity?: ValidatedReadIdentity): Promise<Buffer | undefined> {
	checkAbort(signal);
	const canonical = await realpath(path);
	const handle = await open(canonical, "r");
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile() || info.size > BigInt(READ_SMALL_FILE_BYTES)) return undefined;
		// procfs/sysfs can report zero (or an upper bound) while returning data.
		// One extra byte distinguishes a real EOF from a filled reported-size buffer.
		let buffer = Buffer.allocUnsafe(info.size === 0n ? 4096 : Number(info.size) + 1);
		let position = 0;
		while (true) {
			checkAbort(signal);
			const read = await handle.read(buffer, position, buffer.length - position, position);
			if (read.bytesRead === 0) break;
			position += read.bytesRead;
			if (position > READ_SMALL_FILE_BYTES) {
				if ((await handle.stat({ bigint: true })).size <= BigInt(READ_SMALL_FILE_BYTES)) {
					throw new UnreliableReadSizeError();
				}
				return undefined;
			}
			if (position === buffer.length) {
				const larger = Buffer.allocUnsafe(Math.min(READ_SMALL_FILE_BYTES + 1, buffer.length * 2));
				buffer.copy(larger, 0, 0, position);
				buffer = larger;
			}
		}
		checkAbort(signal);
		const identity = generation(info);
		if (generation(await handle.stat({ bigint: true })) !== identity ||
			await realpath(path) !== canonical || generation(await stat(canonical, { bigint: true })) !== identity) return undefined;
		checkAbort(signal);
		if (evidenceIdentity && info.size === BigInt(position)) handoffIdentity(evidenceIdentity, canonical, info, "small-file line policy v1");
		return buffer.subarray(0, position);
	} finally {
		await handle.close();
	}
}

function scopeKey(workspace: string, session: string): string {
	return createHash("sha256").update(workspace).update("\0").update(session).digest("hex");
}

function cursorSignature(payload: string, workspace: string, session: string): string {
	// Scope-bound integrity, not a filesystem authorization boundary. The caller
	// still needs access to the file. Stable session identity permits resume.
	return createHmac("sha256", session).update(workspace).update("\0").update(payload).digest("base64url");
}

function parseCursor(value: string, scope: string, workspace: string, session: string): Cursor {
	if (value.length > READ_CURSOR_MAX_CHARS || !value.startsWith("read-v1.")) throw new ReadCursorError("invalid-cursor");
	const separator = value.lastIndexOf(".");
	const payload = value.substring(8, separator);
	if (separator <= 8 || value.substring(separator + 1) !== cursorSignature(payload, workspace, session)) throw new ReadCursorError("invalid-cursor");
	let state: Cursor;
	try { state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
	catch { throw new ReadCursorError("invalid-cursor"); }
	if (!state || state.v !== VERSION || state.encoding !== "utf-8" || state.scope !== scope ||
		typeof state.path !== "string" || typeof state.generation !== "string" ||
		!Number.isSafeInteger(state.byte) || state.byte < 0 || !Number.isSafeInteger(state.line) || state.line < 1 ||
		typeof state.partial !== "boolean") throw new ReadCursorError("invalid-cursor");
	return state;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

// Never flush a valid UTF-8 prefix as replacement merely because a window ended.
// Incomplete/invalid sequences at actual EOF are still decoded with replacement.
function safeEnd(bytes: Buffer, start: number, end: number): number {
	let lead = end - 1;
	while (lead >= start && end - lead <= 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
	if (lead >= start) {
		const value = bytes[lead];
		const width = value >= 0xc2 && value <= 0xdf ? 2 : value >= 0xe0 && value <= 0xef ? 3 : value >= 0xf0 && value <= 0xf4 ? 4 : 1;
		if (end - lead < width) end = lead;
	}
	if (end > start && bytes[end - 1] === 13) end--;
	return end;
}

/** Bounded, call-owned scanner. No retained source, index, cursor registry or telemetry. */
export async function readWindow(
	path: string, workspace: string, session: string, input: ReadWindowInput,
	signal?: AbortSignal, counters = createReadWindowCounters(), evidenceIdentity?: ValidatedReadIdentity,
): Promise<ReadWindowResult> {
	checkAbort(signal);
	const canonicalWorkspace = await realpath(workspace);
	const scope = scopeKey(canonicalWorkspace, session);
	const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor, scope, canonicalWorkspace, session);
	if (cursor && input.offset !== undefined) throw new ReadCursorError("invalid-cursor");
	const offset = input.offset ? Math.max(1, Math.trunc(input.offset)) : 1;
	const limit = input.limit === undefined ? 2000 : input.limit;
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("Large-file reads require an integer offset and a positive integer limit");
	}
	let canonical: string;
	try { canonical = await realpath(path); }
	catch (error) { if (cursor) throw new ReadCursorError("stale-cursor"); throw error; }
	if (cursor && cursor.path !== canonical) throw new ReadCursorError("stale-cursor");
	let handle;
	try { handle = await open(canonical, "r"); }
	catch (error) { if (cursor) throw new ReadCursorError("stale-cursor"); throw error; }
	counters.fileOpens++;
	try {
		const info = await handle.stat({ bigint: true });
		const identity = generation(info);
		if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Large-file read requires a regular file with a safe byte size");
		const size = Number(info.size);
		if (cursor && (cursor.generation !== identity || cursor.byte > size)) throw new ReadCursorError("stale-cursor");
		let position = cursor?.byte ?? 0;
		let line = cursor?.line ?? 1;
		let startByte = position;
		let startLine = line;
		let selected = !!cursor || offset === 1;
		let remainingLines = Math.min(limit, 2000);
		let sourceBytes = 0;
		let text = "";
		let partial = false;
		let stoppedAtLine = false;
		let binary = false;
		const buffer = Buffer.allocUnsafe(selected ? READ_WINDOW_BYTES : READ_CHUNK_BYTES);
		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const decodeOptions = { stream: true };
		counters.bufferAllocations++;
		counters.decodersCreated++;
		counters.maximumRetainedChunk = Math.max(counters.maximumRetainedChunk, buffer.length);
		while (position < size) {
			checkAbort(signal);
			const previousPosition = position;
			const requested = Math.min(buffer.length, size - position);
			let count = 0;
			while (count < requested) {
				checkAbort(signal);
				const readPosition = position + count;
				const bytesRead = (await handle.read(buffer, count, requested - count, readPosition)).bytesRead;
				counters.readCalls++;
				if (count > 0) counters.shortReadFillCalls++;
				if (bytesRead > 0 && bytesRead < requested - count) counters.shortReadBytes += bytesRead;
				counters.bytesRead += bytesRead;
				checkAbort(signal);
				if (bytesRead === 0) break;
				count += bytesRead;
			}
			// True EOF before the descriptor's stated end means this snapshot changed
			// or its size is overreported. Never decode/trim a short, incomplete chunk.
			if (count !== requested) throw new ReadCursorError("stale-cursor");
			let begin = 0;
			if (!selected) {
				while (line < offset) {
					const newline = buffer.indexOf(10, begin);
					if (newline < 0 || newline >= count) { begin = count; break; }
					counters.separatorsInspected++;
					line++;
					begin = newline + 1;
				}
				counters.scanBytes += begin;
				if (line === offset) { selected = true; startByte = position + begin; startLine = line; }
			}
			if (!selected) {
				position += count;
				if (position <= previousPosition) {
					counters.zeroProgressPrevented++;
					throw new Error("Read window made no forward progress");
				}
				continue;
			}
			let end = Math.min(count, begin + READ_WINDOW_BYTES - sourceBytes);
			const windowFull = sourceBytes + end - begin === READ_WINDOW_BYTES;
			// Re-read at most three UTF-8 prefix bytes (or one CR) on the next
			// iteration. No undecoded source bytes need to live in a persisted cursor.
			if (position + end < size) end = safeEnd(buffer, begin, end);
			let search = begin;
			let next = end;
			while (search < end) {
				const newline = buffer.indexOf(10, search);
				if (newline < 0 || newline >= end) break;
				counters.separatorsInspected++;
				line++;
				remainingLines--;
				if (remainingLines === 0) { end = newline; next = newline + 1; stoppedAtLine = true; break; }
				search = newline + 1;
			}
			const view = buffer.subarray(begin, end);
			counters.bufferViews++;
			if (view.includes(0)) binary = true;
			const decoded = decoder.decode(view, decodeOptions);
			counters.decodedStrings++;
			counters.decodedCharacters += decoded.length;
			text += decoded;
			counters.outputAppends++;
			counters.maximumOutputCodeUnits = Math.max(counters.maximumOutputCodeUnits, text.length);
			sourceBytes += end - begin;
			counters.scanBytes += end - begin;
			position += next;
			if (stoppedAtLine) break;
			if (windowFull && position < size) {
				partial = end === begin || buffer[end - 1] !== 10;
				break;
			}
			if (position <= previousPosition) {
				counters.zeroProgressPrevented++;
				throw new Error("Read window made no forward progress");
			}
		}
		const done = position === size && !stoppedAtLine;
		let eofProbeBytes = 0;
		if (done) {
			checkAbort(signal);
			eofProbeBytes = (await handle.read(buffer, 0, 1, size)).bytesRead;
			counters.readCalls++;
			counters.bytesRead += eofProbeBytes;
			counters.eofProbes++;
			counters.eofProbeBytes += eofProbeBytes;
		}
		checkAbort(signal);
		// Validate both the opened descriptor and the addressed path after the scan.
		// Replacing a symlink or a file during the read cannot silently return a cursor.
		try {
			if (generation(await handle.stat({ bigint: true })) !== identity ||
				await realpath(path) !== canonical || generation(await stat(canonical, { bigint: true })) !== identity) {
				throw new ReadCursorError("stale-cursor");
			}
		} catch { throw new ReadCursorError("stale-cursor"); }
		checkAbort(signal);
		if (eofProbeBytes > 0) {
			counters.unreliableSizeDetections++;
			throw new UnreliableReadSizeError();
		}
		const tail = decoder.decode();
		counters.decoderFlushes++;
		counters.decodedCharacters += tail.length;
		text += tail;
		if (!selected) throw new Error(`Offset ${input.offset} is beyond end of file (${line} lines total)`);
		let nextCursor: string | undefined;
		if (!done) {
			if (position <= startByte) {
				counters.zeroProgressPrevented++;
				throw new Error("Read window made no forward progress");
			}
			const state: Cursor = { v: VERSION, path: canonical, scope, generation: identity, encoding: "utf-8", byte: position, line, partial };
			const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
			nextCursor = "read-v1." + payload + "." + cursorSignature(payload, canonicalWorkspace, session);
			if (nextCursor.length > READ_CURSOR_MAX_CHARS) throw new ReadCursorError("invalid-cursor");
			counters.continuationCount++;
			counters.cursorSize = nextCursor.length;
		}
		if (evidenceIdentity && !binary) handoffIdentity(evidenceIdentity, canonical, info, `bytes ${startByte}-${position - (stoppedAtLine ? 1 : 0)}; lines ${startLine}-${line}; window policy v1`);
		return { text, startByte, endByte: position - (stoppedAtLine ? 1 : 0), nextByte: position, startLine, nextLine: line, partial, startsPartial: cursor?.partial ?? false, done, cursor: nextCursor, binary };
	} finally {
		await handle.close();
		counters.fileCloses++;
	}
}
