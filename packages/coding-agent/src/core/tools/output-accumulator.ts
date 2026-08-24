import { randomBytes } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	lstatSync,
	openSync,
	opendirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

const MAX_SPILL_BYTES = 5 * 1024 * 1024;
const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SPILL_MARKER = Buffer.from("\n[Super Pi spill file capped at 5 MiB; later output was not persisted.]\n");
const MAX_SPILL_PAYLOAD_BYTES = MAX_SPILL_BYTES - SPILL_MARKER.length;
const SPILL_OWNER_SUFFIX = ".sp-owned";
const SPILL_OWNER_MARKER = "super-pi-output-spill-v2\n";
const MAX_SPILL_CLEANUP_CANDIDATES = 256;
const MAX_APPEND_DECODE_BYTES = 64 * 1024;
let spillCleanupDone = false;

function cleanupOldSpillFiles(): void {
	if (spillCleanupDone) return;
	spillCleanupDone = true;
	const directory = tmpdir();
	const cutoff = Date.now() - SPILL_MAX_AGE_MS;
	let directoryHandle: ReturnType<typeof opendirSync> | undefined;
	try {
		directoryHandle = opendirSync(directory);
		let inspected = 0;
		while (inspected < MAX_SPILL_CLEANUP_CANDIDATES) {
			const entry = directoryHandle.readSync();
			if (!entry) break;
			inspected++;
			const name = entry.name;
			if (!name.endsWith(SPILL_OWNER_SUFFIX)) continue;
			const ownerPath = join(directory, name);
			const spillName = name.slice(0, -SPILL_OWNER_SUFFIX.length);
			if (!(spillName.startsWith("sp-bash-") || spillName.startsWith("sp-output-")) || !spillName.endsWith(".log")) continue;
			const spillPath = join(directory, spillName);
			try {
				const ownerInfo = lstatSync(ownerPath);
				if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.mtimeMs >= cutoff || readFileSync(ownerPath, "utf8") !== SPILL_OWNER_MARKER) continue;
				let spillInfo;
				try { spillInfo = lstatSync(spillPath); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") unlinkSync(ownerPath);
					continue;
				}
				if (!spillInfo.isFile() || spillInfo.isSymbolicLink() || spillInfo.mtimeMs >= cutoff) continue;
				unlinkSync(spillPath);
				unlinkSync(ownerPath);
			} catch {}
		}
	} catch {}
	finally { try { directoryHandle?.closeSync(); } catch {} }
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileBytes = 0;
	private tempFileCapped = false;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "sp-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedData(data);

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.writeTempData(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedData(data: Buffer): void {
		for (let offset = 0; offset < data.length; offset += MAX_APPEND_DECODE_BYTES) {
			const end = Math.min(data.length, offset + MAX_APPEND_DECODE_BYTES);
			this.appendDecodedText(this.decoder.decode(data.subarray(offset, end), { stream: true }));
		}
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private writeTempData(data: Buffer): void {
		if (!this.tempFileStream || this.tempFileCapped || data.length === 0) return;
		const remaining = MAX_SPILL_PAYLOAD_BYTES - this.tempFileBytes;
		if (remaining > 0) {
			const chunk = data.length <= remaining ? data : Buffer.from(data.subarray(0, remaining));
			this.tempFileStream.write(chunk);
			this.tempFileBytes += chunk.length;
		}
		if (data.length > remaining) {
			this.tempFileStream.write(SPILL_MARKER);
			this.tempFileCapped = true;
		}
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		cleanupOldSpillFiles();
		const spillPath = defaultTempFilePath(this.tempFilePrefix);
		const ownerPath = spillPath + SPILL_OWNER_SUFFIX;
		let spillCreated = false;
		let ownerCreated = false;
		let spillFd: number | undefined;
		try {
			spillFd = openSync(spillPath, "wx", 0o600);
			spillCreated = true;
			writeFileSync(ownerPath, SPILL_OWNER_MARKER, { encoding: "utf8", flag: "wx", mode: 0o600 });
			ownerCreated = true;
			this.tempFileStream = createWriteStream(spillPath, { fd: spillFd, autoClose: true });
			spillFd = undefined;
			this.tempFilePath = spillPath;
		} catch (error) {
			if (spillFd !== undefined) try { closeSync(spillFd); } catch {}
			if (ownerCreated) try { unlinkSync(ownerPath); } catch {}
			if (spillCreated) try { unlinkSync(spillPath); } catch {}
			throw error;
		}
		for (const chunk of this.rawChunks) {
			this.writeTempData(chunk);
		}
		this.rawChunks = [];
	}
}
