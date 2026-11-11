import type { ImageContent } from "@super-pi/ai";
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
