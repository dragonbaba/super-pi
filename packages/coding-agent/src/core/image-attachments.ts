import { decodeImageLocally, type ImageDecodeObserver } from "../utils/image-decode.ts";
import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, UserMessage } from "@super-pi/ai";
import { CURSOR_MARKER, getImageDimensions } from "@super-pi/tui";

export const IMAGE_ATTACHMENT_VERSION = 1;
export const IMAGE_VISION_RESULT_TYPE = "image-vision-result-v1";
export interface ImageVisionResult { submissionId: string; inputHash: string; description: string; model: string; imageOrder: number[] }
export const IMAGE_ATTACHMENT_LIMITS = Object.freeze({ count: 8, bytes: 10 * 1024 * 1024, total: 40 * 1024 * 1024, pixels: 24_000_000 });
export interface ImageAttachment {
	version: 1;
	id: string;
	kind: "image";
	source: "clipboard" | "local-file" | "api";
	name: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	/** Index into the authoritative message image content, never a filesystem capability. */
	contentIndex: number;
	ownership: "application-snapshot";
}
export interface ImageSubmission {
	version: 1; id: string; attachments: ImageAttachment[];
	source?: "interactive" | "rpc" | "extension";
	/** Committed ordinary input transform; original user content remains authoritative for display. */
	inputProjection?: { text: string; images?: ImageContent[] };
}
export type AttachmentMessage = UserMessage & { imageSubmission?: ImageSubmission };
// Weak receipts retain metadata only; no global image bytes or mutable caller proof.
const decodedImages = new WeakMap<ImageContent, ImageAttachment>();
function rememberDecoded(image: ImageContent, metadata: ImageAttachment): void { Object.freeze(image); decodedImages.set(image, Object.freeze({ ...metadata })); }
function copyImage(image: ImageContent): ImageContent {
	const copy: ImageContent = { type: "image", data: image.data, mimeType: image.mimeType };
	const receipt = decodedImages.get(image); if (receipt) rememberDecoded(copy, receipt);
	return copy;
}
export function isDecodedImage(image: ImageContent): boolean { return decodedImages.has(image); }
export async function verifySubmittedImage(image: ImageContent, signal?: AbortSignal): Promise<void> {
	if (decodedImages.has(image)) return;
	const bytes = Buffer.from(image.data, "base64");
	const metadata = imageMetadata(bytes, "image", "api");
	if (metadata.mimeType !== image.mimeType) throw new Error("Invalid image content/MIME");
	Object.freeze(image);
	const decoded = await decodeImageLocally(bytes, signal ?? new AbortController().signal);
	if (decoded.width !== metadata.width || decoded.height !== metadata.height) throw new Error("图片尺寸不一致");
	rememberDecoded(image, metadata);
}

export function snapshotImageSubmission(images: readonly ImageContent[], submission?: ImageSubmission): { images: ImageContent[]; submission: ImageSubmission } {
	if (submission?.id != null && (typeof submission.id !== "string" || !submission.id.trim())) throw new Error("Image submission ID must be nonempty");
	if (images.length > IMAGE_ATTACHMENT_LIMITS.count) throw new Error("最多提交 8 张图片");
	const snapshot: ImageContent[] = [];
	const attachments: ImageAttachment[] = [];
	let total = 0;
	for (let index = 0; index < images.length; index++) {
		const image = copyImage(images[index]);
		const bytes = Buffer.byteLength(image.data, "base64");
		total += bytes;
		if (bytes > IMAGE_ATTACHMENT_LIMITS.bytes || total > IMAGE_ATTACHMENT_LIMITS.total) throw new Error("提交的图片超出字节限制");
		const supplied = submission?.attachments[index];
		if (supplied && (typeof supplied.id !== "string" || !supplied.id.trim())) throw new Error("Image attachment ID must be nonempty");
		const metadata = decodedImages.get(image) ?? imageMetadata(Buffer.from(image.data, "base64"), `image-${index + 1}`, "api");
		if (metadata.mimeType !== image.mimeType) throw new Error("Invalid image content/MIME");
		// A decoded receipt proves content, not identity: reusing the same image in
		// two slots without supplied metadata still creates two distinct attachments.
		const id = supplied ? supplied.id : randomUUID();
		for (const attachment of attachments) if (attachment.id === id) throw new Error("Image attachment IDs must be unique");
		attachments.push({ ...metadata, id, name: supplied?.name ?? metadata.name, contentIndex: index });
		snapshot.push(image);
	}
	return { images: snapshot, submission: { version: 1, id: submission?.id ?? randomUUID(), attachments, source: submission?.source } };
}
export interface DraftImage {
	id: string;
	name: string;
	source: ImageAttachment["source"];
	state: "preparing" | "ready" | "failed";
	error?: string;
	metadata?: ImageAttachment;
	image?: ImageContent;
}

function imageMime(bytes: Uint8Array): string {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
	if (b.length >= 10 && (b.toString("ascii", 0, 6) === "GIF89a" || b.toString("ascii", 0, 6) === "GIF87a")) return "image/gif";
	if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	throw new Error("图片格式无效：仅支持 PNG、JPEG、GIF、WebP");
}

function imageMetadata(bytes: Uint8Array, name: string, source: ImageAttachment["source"], id: string = randomUUID()): ImageAttachment {
	if (!bytes.length || bytes.length > IMAGE_ATTACHMENT_LIMITS.bytes) throw new Error("图片超过 10 MiB 或为空");
	const mimeType = imageMime(bytes);
	const dimensions = getImageDimensions(bytes, mimeType);
	if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 || dimensions.widthPx * dimensions.heightPx > IMAGE_ATTACHMENT_LIMITS.pixels) throw new Error("图片尺寸无效或超过 2400 万像素");
	return { version: 1, id, kind: "image", source, name, mimeType, bytes: bytes.length, width: dimensions.widthPx,
		height: dimensions.heightPx, contentIndex: 0, ownership: "application-snapshot" };
}
export function validateAttachment(bytes: Uint8Array, name: string, source: ImageAttachment["source"], id: string = randomUUID()): { metadata: ImageAttachment; image: ImageContent } {
	const metadata = imageMetadata(bytes, name, source, id);
	return { image: { type: "image", data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"), mimeType: metadata.mimeType }, metadata };
}

/** Restore/request boundary verification before freezing and memoizing content. No encode round-trip. */
export function verifyImmutableImage(image: ImageContent): void {
	if (decodedImages.has(image)) return;
	const data = Object.getOwnPropertyDescriptor(image, "data");
	const mime = Object.getOwnPropertyDescriptor(image, "mimeType");
	if (!data || !mime || typeof data.value !== "string" || typeof mime.value !== "string") throw new Error("Invalid image content properties");
	if (data.value.length > Math.ceil(IMAGE_ATTACHMENT_LIMITS.bytes / 3) * 4) throw new Error("图片超过 10 MiB");
	const bytes = Buffer.from(data.value, "base64");
	if (!bytes.length || bytes.length > IMAGE_ATTACHMENT_LIMITS.bytes || imageMime(bytes) !== mime.value) throw new Error("Invalid image content/MIME");
	const dimensions = getImageDimensions(bytes, mime.value);
	if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 || dimensions.widthPx * dimensions.heightPx > IMAGE_ATTACHMENT_LIMITS.pixels) throw new Error("图片尺寸无效或超过 2400 万像素");
	Object.freeze(image);
}

export function localImagePath(value: string, cwd: string): string {
	let path = value;
	if (/^file:/i.test(path)) {
		const url = new URL(path);
		if (url.hostname && url.hostname !== "localhost") throw new Error("不支持远程 file URI");
		path = fileURLToPath(url);
	}
	if (/^[\\/]{2}/.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("仅支持本地单文件图片");
	return resolve(cwd, path);
}

/** Parse one complete paste/add unit. No shell evaluation and no filesystem probes. */
export function parseImagePaths(text: string, explicit = false): string[] | undefined {
	if (text.length > 32768 || /[\r\n\x00]/.test(text)) return undefined;
	const paths: string[] = [];
	let offset = 0;
	while (offset < text.length) {
		while (text[offset] === " " || text[offset] === "\t") offset++;
		if (offset === text.length) break;
		let value = "";
		const quote = text[offset] === "'" || text[offset] === '"' ? text[offset++] : undefined;
		let closed = !quote;
		while (offset < text.length) {
			const char = text[offset++];
			if (quote && char === quote) {
				if (text[offset] === quote) { value += quote; offset++; continue; }
				closed = true; break;
			}
			if (!quote && (char === " " || char === "\t")) break;
			if (!quote && char === "\\" && text[offset] === " ") { value += " "; offset++; }
			else value += char;
		}
		if (!closed || !/\.(png|jpe?g|webp|gif)$/i.test(value)) return undefined;
		if (!explicit && !/^(?:[a-z]:[\\/]|\/|file:)/i.test(value)) return undefined;
		paths.push(value);
		if (paths.length > IMAGE_ATTACHMENT_LIMITS.count) return undefined;
	}
	return paths.length ? paths : undefined;
}

async function readLocalSnapshot(path: string, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	const canonical = await realpath(path);
	if (/^[\\/]{2}/.test(canonical)) throw new Error("图片重定向到远程路径");
	const handle = await open(canonical, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size < 1 || before.size > IMAGE_ATTACHMENT_LIMITS.bytes) throw new Error("图片不是普通文件或超过 10 MiB");
		const bytes = Buffer.allocUnsafe(before.size + 1);
		let count = 0;
		while (count < bytes.length) {
			signal.throwIfAborted();
			const read = await handle.read(bytes, count, bytes.length - count, count);
			if (!read.bytesRead) break;
			count += read.bytesRead;
		}
		const after = await handle.stat();
		if (count !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path) !== canonical) throw new Error("读取期间图片已变化，请重新添加");
		return bytes.subarray(0, count);
	} finally { await handle.close(); }
}

/** One host input owner. No paths, leases or draft bytes are exposed to tools. */
export class ImageAttachmentDraft {
	id = randomUUID();
	private records: DraftImage[] = [];
	private active: AbortController | undefined;
	private decoding: AbortController | undefined;
	private decodingRecord: DraftImage | undefined;
	private readonly changed: () => void;
	private readonly decodeObserver?: ImageDecodeObserver;
	constructor(changed: () => void, decodeObserver?: ImageDecodeObserver) { this.changed = changed; this.decodeObserver = decodeObserver; }
	get items(): readonly DraftImage[] { return this.records; }
	get busy(): boolean { return this.active !== undefined || this.decoding !== undefined; }
	begin(name: string, source: DraftImage["source"]): DraftImage {
		if (this.records.length >= IMAGE_ATTACHMENT_LIMITS.count) throw new Error("最多添加 8 张图片");
		const record: DraftImage = { id: randomUUID(), name, source, state: "preparing" };
		this.records.push(record); this.changed(); return record;
	}
	async finish(record: DraftImage, bytes: Uint8Array, isCurrent?: () => boolean): Promise<void> {
		if (!this.records.includes(record) || record.state !== "preparing" || (isCurrent && !isCurrent())) return;
		try {
			if (this.decoding) throw new Error("正在校验或停止上一张图片，请稍后重新添加");
			const loaded = validateAttachment(bytes, record.name, record.source, record.id);
			let total = loaded.metadata.bytes;
			for (const item of this.records) total += item.metadata?.bytes ?? 0;
			if (total > IMAGE_ATTACHMENT_LIMITS.total) throw new Error("图片总大小超过 40 MiB");
			const controller = new AbortController(); this.decoding = controller; this.decodingRecord = record;
			try {
				const decoded = await decodeImageLocally(bytes, controller.signal, this.decodeObserver);
				if (decoded.width !== loaded.metadata.width || decoded.height !== loaded.metadata.height) throw new Error("图片尺寸不一致");
			} finally { this.decoding = undefined; this.decodingRecord = undefined; }
			if (!this.records.includes(record) || record.state !== "preparing" || (isCurrent && !isCurrent())) return;
			// A queue restore can transfer ready records while the decoder is running.
			total = loaded.metadata.bytes;
			for (const item of this.records) total += item.metadata?.bytes ?? 0;
			if (total > IMAGE_ATTACHMENT_LIMITS.total) throw new Error("图片总大小超过 40 MiB");
			if (record.source === "local-file") {
				const expected = /\.(png|jpe?g|gif|webp)$/i.exec(record.name)?.[1].toLowerCase().replace("jpg", "jpeg");
				if (expected && loaded.image.mimeType !== `image/${expected}`) throw new Error("图片扩展名与实际格式不一致");
			}
			rememberDecoded(loaded.image, loaded.metadata);
			record.metadata = loaded.metadata; record.image = loaded.image; record.state = "ready";
		} catch (error) { this.fail(record, error); return; }
		this.changed();
	}
	fail(record: DraftImage, error: unknown): void {
		if (!this.records.includes(record)) return;
		record.state = "failed"; record.error = error instanceof Error ? error.message : String(error); this.changed();
	}
	remove(index: number): void { if (this.records[index] === this.decodingRecord) this.decoding?.abort(); this.records.splice(index, 1); this.changed(); }
	clear(): void { this.active?.abort(); this.decoding?.abort(); this.records = []; this.id = randomUUID(); this.changed(); }
	async addFiles(paths: readonly string[], cwd: string, isCurrent?: () => boolean): Promise<void> {
		if (this.busy || this.records.some(item => item.state === "preparing")) throw new Error("正在添加图片，请稍后再试");
		if (paths.length + this.records.length > IMAGE_ATTACHMENT_LIMITS.count) throw new Error("最多添加 8 张图片");
		const controller = new AbortController(); this.active = controller;
		// Optional clipboard ownership spans the nested local read/decode. Keep
		// only this bounded batch's records, never remove a competing draft's data.
		const owned: DraftImage[] | undefined = isCurrent ? [] : undefined;
		try {
			for (const path of paths) {
				if (controller.signal.aborted || (isCurrent && !isCurrent())) break;
				const record = this.begin(basename(path), "local-file");
				owned?.push(record);
				try {
					const bytes = await readLocalSnapshot(localImagePath(path, cwd), controller.signal);
					if (controller.signal.aborted || (isCurrent && !isCurrent())) break;
					await this.finish(record, bytes, isCurrent);
				}
				catch (error) { this.fail(record, error); }
			}
		} finally {
			if (owned && isCurrent && !isCurrent()) for (const record of owned) {
				const index = this.records.indexOf(record);
				if (index >= 0) this.remove(index);
			}
			if (this.active === controller) this.active = undefined;
		}
	}
	submit(): { images: ImageContent[]; submission: ImageSubmission } {
		if (this.busy || this.records.some(item => item.state === "preparing")) throw new Error("图片尚未就绪，完成后请再次发送");
		if (this.records.some(item => item.state === "failed")) throw new Error("图片添加失败，请修复或移除后再次发送");
		const images: ImageContent[] = [];
		const attachments: ImageAttachment[] = [];
		for (const record of this.records) {
			attachments.push({ ...record.metadata!, contentIndex: images.length });
			images.push(copyImage(record.image!));
		}
		const submission: ImageSubmission = { version: 1, id: randomUUID(), attachments };
		this.clear(); return { images, submission };
	}
	restore(images: ImageContent[], submission: ImageSubmission, prepend = false): void {
		if (this.records.length + images.length > IMAGE_ATTACHMENT_LIMITS.count) throw new Error("草稿图片数量超过限制，先移除图片后再恢复");
		let total = 0;
		for (const item of this.records) total += item.metadata?.bytes ?? 0;
		for (const metadata of submission.attachments) total += metadata.bytes;
		if (total > IMAGE_ATTACHMENT_LIMITS.total) throw new Error("恢复后草稿图片总大小超过 40 MiB");
		for (let i = 0; i < submission.attachments.length; i++) {
			const metadata = submission.attachments[prepend ? submission.attachments.length - 1 - i : i];
			const record: DraftImage = { id: metadata.id, name: metadata.name, source: metadata.source, state: "ready", metadata, image: images[metadata.contentIndex] };
			if (prepend) this.records.unshift(record); else this.records.push(record);
		}
		this.changed();
	}
}

export function attachmentLabel(name: string): string { return name.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�"); }
/** Multiline derived text: preserve line structure without terminal/bidi controls. */
export function attachmentDescription(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Bidi_Control}]/gu, "�");
}
export function draftAttachmentText(items: readonly DraftImage[], selectedId?: string): string {
	let text = "";
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		text += `${item.id === selectedId ? CURSOR_MARKER + "▶ " : ""}[图片 ${i + 1} · ${attachmentLabel(item.name)} · ${item.state === "preparing" ? "正在添加" : item.state === "failed" ? `失败：${attachmentLabel(item.error ?? "")}` : item.source === "clipboard" ? "已粘贴 · 未发送" : "已添加 · 未发送"}]\n`;
	}
	return text;
}
