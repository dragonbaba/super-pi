import type { ImageContent, Message } from "@super-pi/ai";
const processed = new WeakMap<ImageContent, { data: string; mimeType: string; autoResize: boolean }>();
/** Admission-only provenance. Mutating a block invalidates its proof. */
export function processedImage(data: string, mimeType: string, autoResize = true): ImageContent {
	const image: ImageContent = { type: "image", data, mimeType };
	processed.set(image, { data, mimeType, autoResize }); return image;
}
export function wasImageProcessed(image: ImageContent, autoResize = true): boolean {
	const known = processed.get(image); return known?.data === image.data && known.mimeType === image.mimeType && (!autoResize || known.autoResize);
}
export function rememberProcessedImage(image: ImageContent, autoResize = true): void { processed.set(image, { data: image.data, mimeType: image.mimeType, autoResize }); }

/** Reconcile ordered hook clones after hooks finish. Changed/reordered blocks keep their own identity. */
export function reuseUnchangedToolImages(messages: Message[], original: Message[]): void {
	if (messages === original) return;
	let sourceIndex = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		let source: Message | undefined;
		while (sourceIndex < original.length) {
			const candidate = original[sourceIndex++]!;
			if (candidate.role === "toolResult" && candidate.toolCallId === message.toolCallId) { source = candidate; break; }
		}
		if (!source || source.role !== "toolResult") break;
		if (source === message) continue;
		for (let index = 0; index < message.content.length && index < source.content.length; index++) {
			const block = message.content[index]!, previous = source.content[index]!;
			if (block.type === "image" && previous.type === "image" && block.data === previous.data && block.mimeType === previous.mimeType) message.content[index] = previous;
		}
	}
}
