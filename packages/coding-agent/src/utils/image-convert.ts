import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export type LoadedPngConverter = typeof import("@silvia-odwyer/photon-node");
export type ConvertedPngImage = { data: string; mimeType: string };

/** @internal Load the shared converter without retaining any image source. */
export function loadPngConverter(): Promise<LoadedPngConverter | null> {
	return loadPhoton();
}

/** @internal Convert bytes synchronously after the shared converter is ready. */
export function convertImageBytesToPngWithLoadedConverter(
	photon: LoadedPngConverter,
	bytes: Uint8Array,
): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPngConverter();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}
	return convertImageBytesToPngWithLoadedConverter(photon, bytes);
}

/** @internal Decode and convert only after converter readiness has been established. */
export function convertToPngWithLoadedConverter(
	photon: LoadedPngConverter,
	base64Data: string,
	mimeType: string,
): ConvertedPngImage | null {
	if (mimeType === "image/png") return { data: base64Data, mimeType };
	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = convertImageBytesToPngWithLoadedConverter(photon, bytes);
	if (!pngBytes) return null;
	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<ConvertedPngImage | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}
	const photon = await loadPngConverter();
	if (!photon) return null;
	return convertToPngWithLoadedConverter(photon, base64Data, mimeType);
}
