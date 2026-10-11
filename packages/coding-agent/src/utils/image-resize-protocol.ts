import type { ResizedImage } from "./image-resize-core.ts";

export type ResizeImageWorkerResponse =
	| { type: "image-resize-result"; result: ResizedImage | null; error?: never }
	| { type: "image-resize-result"; error: string; result?: never };

function isDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Check only fixed metadata; never copy or scan the encoded image payload. */
export function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	if (value === null || typeof value !== "object") return false;
	const response = value as Record<string, unknown>;
	if (response.type !== "image-resize-result") return false;
	if (typeof response.error === "string") return response.result === undefined;
	if (response.error !== undefined) return false;
	if (response.result === null) return true;
	if (typeof response.result !== "object") return false;
	const result = response.result as Record<string, unknown>;
	return typeof result.data === "string" && typeof result.mimeType === "string"
		&& isDimension(result.originalWidth) && isDimension(result.originalHeight)
		&& isDimension(result.width) && isDimension(result.height)
		&& typeof result.wasResized === "boolean";
}
