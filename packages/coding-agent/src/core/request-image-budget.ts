import type { ImageContent, Message, TextContent, ToolResultMessage } from "@super-pi/ai";
import { resizeImage, type ImageResizeOptions } from "../utils/image-resize.ts";
import { wasImageProcessed } from "../utils/processed-image.ts";
import type { ToolResultImageRange } from "./tool-result-presentation.ts";

export const IMAGE_KEEP_BYTES = 8 * 1024 * 1024;
export const IMAGE_STEP_BYTES = 4 * 1024 * 1024;
// Keep the established per-image fidelity defaults. Tighter views are explicit settings.
export const IMAGE_VIEW_BYTES = 4.5 * 1024 * 1024;
const CACHE_SOURCE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 128;
const PROJECTION_CACHE_BYTES = 2 * 1024 * 1024;
const CURRENT_BATCH_TOO_LARGE = "Request preparation blocked: current tool images exceed the image budget. Send a new text message to continue with this batch treated as history (some images may be omitted), or explicitly adjust images.requestBudget to inspect the whole batch. Original history and completed tools are unchanged; do not repeat completed tools.";
const OMITTED: TextContent = Object.freeze({ type: "text", text: "[Historical tool image omitted from this request. The original remains in session history; use its recorded source or manifest if still available. Do not repeat completed mutations.]" });

export interface RequestImageSettings {
	keepBytes?: number;
	stepBytes?: number;
	maxBytes?: number;
	maxWidth?: number;
	maxHeight?: number;
}
interface View { data: string; mimeType: string; image: ImageContent; note?: TextContent; bytes: number; sourceBytes: number; }
interface Projection { source: ToolResultMessage["content"]; result: ToolResultMessage; bytes: number; }
type Encoder = typeof resizeImage;
function positive(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Request preparation blocked: image settings must be positive safe integers");
	return value;
}

/** Session-owned request views. Never writes to canonical messages or session files. */
export class RequestImageBudget {
	private readonly views = new Map<ImageContent, View>();
	private seen = new WeakMap<ImageContent, number>();
	private seenData = new WeakMap<ImageContent, string>();
	private seenMime = new WeakMap<ImageContent, string>();
	private omittedUntil = new WeakMap<Message, number>();
	private projected = new WeakMap<Message, Projection>();
	private requestViews = new WeakMap<ImageContent, View>();
	private active = new WeakMap<ImageContent, number>();
	private retainedCounts = new WeakMap<ImageContent, number>();
	private updated = new WeakMap<ImageContent, number>();
	private sources = 0;
	private encoded = 0;
	private total = 0;
	private cutoff = 0;
	private policy = "";
	private generation = 0;
	private epoch = 0;
	private recovery = false;
	private lastBytes = 0;
	private previousWireBytes = 0;
	private wireLimit = 0;
	readonly metrics = { imagesInspected: 0, encodes: 0, cacheHits: 0, projectedMessages: 0, retainedImageBytes: 0,
		userImageBytes: 0, wireBytes: 0, uploads: 0, cacheSourceBytes: 0, cacheViewBytes: 0, projectionCacheBytes: 0, requestViewBytes: 0, requestViewBytesHighWaterMark: 0 };
	private resetProjections(): void { this.projected = new WeakMap(); this.metrics.projectionCacheBytes = 0; }
	private forgetProjection(message: Message): void {
		const previous = this.projected.get(message);
		if (previous) { this.metrics.projectionCacheBytes -= previous.bytes; this.projected.delete(message); }
	}
	private readonly encode: Encoder;
	constructor(encode: Encoder = resizeImage) { this.encode = encode; }
	clear(): void {
		this.generation++; this.views.clear(); this.sources = this.encoded = this.total = this.cutoff = 0;
		this.seen = new WeakMap(); this.seenData = new WeakMap(); this.seenMime = new WeakMap(); this.omittedUntil = new WeakMap(); this.resetProjections(); this.requestViews = new WeakMap(); this.active = new WeakMap(); this.retainedCounts = new WeakMap(); this.updated = new WeakMap();
		this.policy = ""; this.recovery = false; this.lastBytes = this.previousWireBytes = this.wireLimit = 0;
		this.metrics.cacheSourceBytes = this.metrics.cacheViewBytes = this.metrics.retainedImageBytes = 0;
		this.metrics.requestViewBytes = 0;
	}
	resetRecovery(): void {
		this.releaseRequestViews();
		if (this.recovery) { this.views.clear(); this.sources = this.encoded = 0; this.requestViews = new WeakMap(); this.resetProjections(); this.generation++; }
		this.metrics.cacheSourceBytes = this.sources; this.metrics.cacheViewBytes = this.encoded;
		this.recovery = false; this.wireLimit = 0;
	}
	/** Only the recovery upload must be smaller; later tool results may grow. */
	completeResponse(): void { this.wireLimit = 0; this.releaseRequestViews(); }
	releaseRequestViews(): void { if (this.metrics.requestViewBytes) { this.requestViews = new WeakMap(); this.metrics.requestViewBytes = 0; } }
	tighten(): boolean {
		if (this.recovery || this.lastBytes === 0 || this.metrics.uploads === 0) return false;
		this.recovery = true; this.previousWireBytes = this.metrics.wireBytes;
		this.releaseRequestViews();
		this.wireLimit = this.previousWireBytes;
		this.views.clear(); this.sources = this.encoded = 0; this.resetProjections(); this.generation++;
		this.metrics.cacheSourceBytes = this.metrics.cacheViewBytes = 0;
		return true;
	}
	/** Stable observer, called with the SDK's existing serialized body, never a copy. */
	readonly observeWireBytes = (bytes: number): void => {
		if (this.wireLimit && bytes >= this.wireLimit) throw new Error("Request preparation blocked: image recovery did not reduce the request body; reduce images/text or compact explicitly. Completed tools were not repeated.");
		this.metrics.wireBytes = bytes; this.metrics.uploads++;
	};
	private evict(source: ImageContent, view: View): void {
		this.views.delete(source); this.sources -= view.sourceBytes; this.encoded -= view.bytes;
	}
	private async view(source: ImageContent, options: ImageResizeOptions, generation: number, signal?: AbortSignal): Promise<View> {
		const cached = this.views.get(source);
		if (cached?.data === source.data && cached.mimeType === source.mimeType) { this.metrics.cacheHits++; return cached; }
		if (cached) this.evict(source, cached);
		signal?.throwIfAborted(); this.metrics.encodes++;
		const data = source.data, mimeType = source.mimeType, sourceBytes = this.seen.get(source) ?? Buffer.byteLength(data);
		const resized = await this.encode(Buffer.from(data, "base64"), mimeType, options);
		signal?.throwIfAborted();
		if (generation !== this.generation) throw new Error("Request preparation blocked: image policy changed during preparation");
		if (source.data !== data || source.mimeType !== mimeType) throw new Error("Request preparation blocked: image content changed during preparation");
		const image: ImageContent = resized && (resized.data !== source.data || resized.mimeType !== source.mimeType) ? { type: "image", data: resized.data, mimeType: resized.mimeType } : source;
		const note: TextContent | undefined = resized?.wasResized ? { type: "text", text: `[Request image view: ${resized.originalWidth}x${resized.originalHeight} -> ${resized.width}x${resized.height}; ${resized.mimeType}. Original session image is unchanged; this view cannot establish original-pixel details.]` }
			: !resized ? { type: "text", text: "[Image resizing unavailable; original retained within the request image budget.]" } : undefined;
		const bytes = image === source ? sourceBytes : image.data.length;
		const result = { data, mimeType, image, note, bytes, sourceBytes };
		while (this.views.size && (this.sources + sourceBytes > CACHE_SOURCE_BYTES || this.encoded + bytes > IMAGE_KEEP_BYTES + IMAGE_STEP_BYTES || this.views.size >= CACHE_ENTRIES)) {
			const first = this.views.keys().next().value!; this.evict(first, this.views.get(first)!);
		}
		if (sourceBytes <= CACHE_SOURCE_BYTES && bytes <= IMAGE_KEEP_BYTES + IMAGE_STEP_BYTES) {
			this.views.set(source, result); this.sources += sourceBytes; this.encoded += bytes;
		}
		return result;
	}
	async prepare(messages: Message[], settings: RequestImageSettings, autoResize: boolean, signal?: AbortSignal): Promise<void> {
		let generation = this.generation;
		try {
		let keep = positive(settings.keepBytes, IMAGE_KEEP_BYTES), step = positive(settings.stepBytes, IMAGE_STEP_BYTES);
		if (!Number.isSafeInteger(keep + step)) throw new Error("Request preparation blocked: image budget is too large");
		const maxBytes = positive(settings.maxBytes, IMAGE_VIEW_BYTES), maxWidth = positive(settings.maxWidth, 2000), maxHeight = positive(settings.maxHeight, 2000);
		const policy = `${keep}:${step}:${maxBytes}:${maxWidth}:${maxHeight}:${autoResize}`;
		if (policy !== this.policy) { const recovery = this.recovery, wireLimit = this.wireLimit; this.clear(); this.recovery = recovery; this.wireLimit = wireLimit; this.policy = policy; }
		if (this.recovery) { keep = Math.max(1, Math.floor(keep / 2)); step = Math.max(1, Math.floor(step / 2)); }
		const capacity = keep + step; generation = this.generation;
		let total = 0, latestStart = 0, latestIndex = messages.length, batchStart = 0, batchIndex = -1;
		let metadataChanged = false;
		this.metrics.userImageBytes = 0;
		for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
			const message = messages[messageIndex]!;
			// Protection belongs only to the outstanding tool batch. A later model
			// turn or explicit user submission makes earlier images historical,
			// including a batch whose first request was blocked before upload.
			if (message.role === "assistant" || message.role === "user") {
				latestStart = batchStart = total; latestIndex = messages.length;
				batchIndex = message.role === "assistant" ? messageIndex : -1;
			}
			if (message.role === "user" && Array.isArray(message.content)) {
				for (const block of message.content) if (block.type === "image") this.metrics.userImageBytes += block.data.length;
			}
			if (message.role !== "toolResult") continue;
			let bytes = 0;
			for (const block of message.content) if (block.type === "image") {
				let weight = this.seen.get(block);
				if (weight !== undefined && (this.seenData.get(block) !== block.data || this.seenMime.get(block) !== block.mimeType)) metadataChanged = true;
				if (weight === undefined || this.seenData.get(block) !== block.data) { this.metrics.imagesInspected++; weight = Buffer.byteLength(block.data); this.seen.set(block, weight); this.seenData.set(block, block.data); }
				this.seenMime.set(block, block.mimeType);
				bytes += weight;
			}
			if (bytes) { latestIndex = batchIndex >= 0 ? batchIndex : messageIndex; latestStart = batchIndex >= 0 ? batchStart : total; total += bytes; }
		}
		if (total === 0) { const recovery = this.recovery, wireLimit = this.wireLimit; this.clear(); this.recovery = recovery; this.wireLimit = wireLimit; return; }
		let cutoff = Math.max(0, Math.floor((total - keep) / step) * step);
		// A large current batch can straddle an ordinary stride. Keep that whole batch,
		// remove older images, then enforce the actual encoded-byte bound below.
		if (cutoff > latestStart) cutoff = latestStart;
		if (metadataChanged || total < this.total) this.resetProjections();
		this.total = total; this.cutoff = cutoff;
		let offset = 0, retained = 0, latestBytes = 0;
		const cycle = ++this.epoch;
		let activeCycle = cycle;
		const currentCounts = new WeakMap<ImageContent, number>();
		for (let index = latestIndex; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role === "toolResult") for (const block of message.content) if (block.type === "image") currentCounts.set(block, (currentCounts.get(block) ?? 0) + 1);
		}
		let pendingCurrent = 0, dropMessage = 0, dropIndex = 0;
		this.requestViews = new WeakMap(); this.metrics.requestViewBytes = this.metrics.requestViewBytesHighWaterMark = 0;
		const resizeOptions = { maxWidth, maxHeight, maxBytes: this.recovery ? Math.max(1, Math.floor(maxBytes / 2)) : maxBytes, preservePng: true };
		let completed = false;
		try {
			for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
				const message = messages[messageIndex]!;
				if (message.role !== "toolResult") continue;
				const previousOmission = this.omittedUntil.get(message) ?? 0;
				this.omittedUntil.set(message, 0);
				for (let index = 0; index < message.content.length; index++) {
					const block = message.content[index]!;
					if (block.type !== "image") continue;
					if (this.seenData.get(block) !== block.data || this.seenMime.get(block) !== block.mimeType) throw new Error("Request preparation blocked: image changed during preparation");
					const omit = offset < cutoff; offset += this.seen.get(block)!;
					if (omit) { this.omittedUntil.set(message, index + 1); continue; }
					const firstOccurrence = this.active.get(block) !== cycle;
					let view: View | undefined;
					if (autoResize) {
						view = this.requestViews.get(block) ?? this.views.get(block);
						if (view?.data === block.data && view.mimeType === block.mimeType) this.metrics.cacheHits++;
						else {
							if (view) this.evict(block, view);
							view = !this.recovery && settings.maxBytes === undefined && settings.maxWidth === undefined && settings.maxHeight === undefined && wasImageProcessed(block)
								? undefined : await this.view(block, resizeOptions, generation, signal);
							this.updated.set(block, cycle);
						}
						// Request ownership is independent of later cross-request LRU eviction.
						if (view && !this.requestViews.has(block)) {
							this.requestViews.set(block, view); this.metrics.requestViewBytes += view.bytes;
							this.metrics.requestViewBytesHighWaterMark = Math.max(this.metrics.requestViewBytesHighWaterMark, this.metrics.requestViewBytes);
						}
					}
					if (this.updated.get(block) === cycle) this.forgetProjection(message);
					const bytes = view?.bytes ?? this.seen.get(block)!;
					if (firstOccurrence) pendingCurrent += (currentCounts.get(block) ?? 0) * bytes;
					this.retainedCounts.set(block, firstOccurrence ? 1 : (this.retainedCounts.get(block) ?? 0) + 1);
					this.active.set(block, cycle);
					retained += bytes;
					if (messageIndex >= latestIndex) { latestBytes += bytes; pendingCurrent -= bytes; }
					if (latestBytes + pendingCurrent > capacity) throw new Error(CURRENT_BATCH_TOO_LARGE);
					// Converge while encoding, rather than retaining every expanded view
					// until a final pass. At most one just-produced view crosses capacity.
					while (retained + pendingCurrent > capacity && dropMessage < latestIndex && dropMessage <= messageIndex) {
						const previous = messages[dropMessage]!;
						if (previous.role !== "toolResult") { dropMessage++; dropIndex = 0; continue; }
						dropIndex = Math.max(dropIndex, this.omittedUntil.get(previous) ?? 0);
						const end = dropMessage === messageIndex ? index + 1 : previous.content.length;
						if (dropIndex >= end) { if (dropMessage === messageIndex) break; dropMessage++; dropIndex = 0; continue; }
						const discarded = previous.content[dropIndex++]!;
						if (discarded.type !== "image") continue;
						const discardedView = this.requestViews.get(discarded) ?? this.views.get(discarded);
						retained -= discardedView?.bytes ?? this.seen.get(discarded)!;
						const count = this.retainedCounts.get(discarded)! - 1;
						this.retainedCounts.set(discarded, count);
						this.omittedUntil.set(previous, dropIndex); this.forgetProjection(previous);
						if (count === 0 && !currentCounts.has(discarded)) {
							if (this.requestViews.delete(discarded)) this.metrics.requestViewBytes -= discardedView!.bytes;
							const cachedView = this.views.get(discarded); if (cachedView) this.evict(discarded, cachedView);
						}
					}
				}
				if (previousOmission !== (this.omittedUntil.get(message) ?? 0)) this.forgetProjection(message);
			}
			if (latestBytes > capacity) throw new Error(CURRENT_BATCH_TOO_LARGE);
			if (retained > capacity || pendingCurrent !== 0) throw new Error("Request preparation blocked: image budget did not converge");
			// Mark all surviving occurrences before pruning shared view ownership.
			activeCycle = ++this.epoch;
			for (const message of messages) if (message.role === "toolResult") {
				for (let index = this.omittedUntil.get(message) ?? 0; index < message.content.length; index++) {
					const block = message.content[index]!; if (block.type === "image") this.active.set(block, activeCycle);
				}
			}
			for (const message of messages) if (message.role === "toolResult") for (const block of message.content) {
				if (block.type !== "image" || this.active.get(block) === activeCycle) continue;
				const view = this.requestViews.get(block);
				if (view) { this.requestViews.delete(block); this.metrics.requestViewBytes -= view.bytes; }
			}
			this.lastBytes = retained; this.metrics.retainedImageBytes = retained;
			completed = true;
		} finally {
			if (generation === this.generation) {
				for (const source of this.views.keys()) if (!completed || this.active.get(source) !== activeCycle) this.evict(source, this.views.get(source)!);
				if (!completed) { this.requestViews = new WeakMap(); this.resetProjections(); }
				this.metrics.cacheSourceBytes = this.sources; this.metrics.cacheViewBytes = this.encoded;
			}
		}
		} catch (error) { if (generation === this.generation) this.clear(); throw error; }
	}
	readonly apply = (message: Message, source?: ToolResultMessage, sourceImageIndex?: number, omittedRange?: ToolResultImageRange | null): Message => {
		if (message.role !== "toolResult") return message;
		// Presentation wrappers are transient and their source decision may change.
		const cacheable = !source || source === message;
		const cached = cacheable ? this.projected.get(message) : undefined;
		if (cached && cached.source.length === message.content.length) {
			const previous = cached.result;
			let same = previous.toolCallId === message.toolCallId && previous.toolName === message.toolName && previous.isError === message.isError
				&& previous.timestamp === message.timestamp && previous.details === message.details && previous.usage === message.usage
				&& previous.addedToolNames === message.addedToolNames && previous.durationMs === message.durationMs;
			for (let i = 0; i < cached.source.length; i++) {
				const block = message.content[i]!;
				if (cached.source[i] !== block) { same = false; break; }
				if (block.type === "image" && (this.seenData.get(block) !== block.data || this.seenMime.get(block) !== block.mimeType)) throw new Error("Request preparation blocked: image changed after preparation");
			}
			if (same) return cached.result;
		}
		if (cached) this.forgetProjection(message);
		let content: (TextContent | ImageContent)[] | undefined;
		const original = source ?? message;
		const omittedUntil = this.omittedUntil.get(original) ?? 0;
		let sourceIndex = sourceImageIndex ?? 0;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i]!;
			let selected = block;
			let occurrence = i;
			if (block.type === "image" && original !== message) {
				if (sourceImageIndex !== undefined || omittedRange !== undefined) {
					while (sourceIndex < original.content.length) {
						if (omittedRange && sourceIndex >= omittedRange.start.blockIndex && sourceIndex < omittedRange.end.blockIndex) { sourceIndex = omittedRange.end.blockIndex; continue; }
						if (original.content[sourceIndex]!.type === "image") break;
						sourceIndex++;
					}
				} else {
					// Compatibility callers may supply a subsequence without a range.
					// Prefer exact identity before considering equal sanitized bytes.
					let identity = sourceIndex;
					while (identity < original.content.length && original.content[identity] !== block) identity++;
					if (identity < original.content.length) sourceIndex = identity;
					else while (sourceIndex < original.content.length) {
						const candidate = original.content[sourceIndex]!;
						if (candidate.type === "image" && candidate.data === block.data && candidate.mimeType === block.mimeType) break;
						sourceIndex++;
					}
				}
				if (sourceIndex === original.content.length) throw new Error("Request preparation blocked: image projection no longer matches its prepared source");
				occurrence = sourceIndex++;
				selected = original.content[occurrence]!;
				if (selected.type !== "image" || selected.data !== block.data || selected.mimeType !== block.mimeType) throw new Error("Request preparation blocked: image projection no longer matches its prepared source");
			}
			if (selected.type === "image" && this.seen.has(selected) && (this.seenData.get(selected) !== selected.data || this.seenMime.get(selected) !== selected.mimeType)) throw new Error("Request preparation blocked: image changed after preparation");
			const omit = block.type === "image" && occurrence < omittedUntil;
			const view = selected.type === "image" ? this.requestViews.get(selected) ?? this.views.get(selected) : undefined;
			if (!content && (omit || view && (view.image !== selected || view.note))) content = message.content.slice(0, i);
			if (content) {
				// A sanitizer's plain image must not regain the canonical MCP sidecars.
				let replacement: TextContent | ImageContent = view && view.image !== selected ? view.image : block;
				if (omit && block.type === "image") {
					replacement = { type: "text", text: `[Tool result ${message.toolCallId.slice(0,128)}, content block ${occurrence+1}] ${OMITTED.text}` };
				}
				content.push(replacement); if (!omit && view?.note) content.push(view.note);
			}
		}
		const projected = content ? { ...message, content } : message;
		if (content) this.metrics.projectedMessages++;
		if (content && cacheable) {
			let bytes = 256 + (message.content.length + content.length) * 16;
			for (const block of content) {
				if (block.type === "text") bytes += block.text.length * 2;
				else if (!this.seen.has(block)) bytes += block.data.length * 2;
			}
			if (bytes <= PROJECTION_CACHE_BYTES - this.metrics.projectionCacheBytes) {
				this.projected.set(message, { source: message.content.slice(), result: projected, bytes }); this.metrics.projectionCacheBytes += bytes;
			}
		}
		return projected;
	};
	applyMessages(messages: Message[]): Message[] {
		let result: Message[] | undefined;
		for (let i = 0; i < messages.length; i++) {
			const next = this.apply(messages[i]!);
			if (!result && next !== messages[i]) result = messages.slice(0, i);
			result?.push(next);
		}
		return result ?? messages;
	}
}
