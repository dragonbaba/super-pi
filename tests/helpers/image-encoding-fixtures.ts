import assert from "node:assert/strict";
import { loadPhoton } from "../../packages/coding-agent/src/utils/photon.ts";

/** Synthetic images, generated outside measured regions; no user image data. */
export async function encodingFixture(kind: "photo" | "transparent" | "text", width = 512, height = 384) {
	const photon = await loadPhoton(); assert.ok(photon);
	const pixels = new Uint8Array(width * height * 4);
	let seed = 123456789;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const i = (y * width + x) * 4;
		seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
		const noise = (seed & 31) - 16;
		if (kind === "text") {
			// Repeated E/H-like glyphs, thin rules and a colored heading on a white page.
			const gx = x % 20, gy = y % 28;
			const ink = gx >= 3 && gx <= 14 && gy >= 4 && gy <= 22 && (gx <= 5 || gy <= 6 || (gy >= 12 && gy <= 14) || gy >= 20);
			const value = ink || x % 97 === 0 || y % 83 === 0 ? 12 : 245;
			pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = y < 30 && ink ? 180 : value;
		} else {
			pixels[i] = Math.max(0, Math.min(255, 30 + 180 * x / width + noise));
			pixels[i + 1] = Math.max(0, Math.min(255, 40 + 150 * y / height + noise));
			pixels[i + 2] = Math.max(0, Math.min(255, 110 + 60 * Math.sin(x / 19) * Math.cos(y / 27) + noise));
		}
		pixels[i + 3] = kind === "transparent" && x < width / 2 ? 96 : 255;
	}
	const image = new photon.PhotonImage(pixels, width, height);
	try { return image.get_bytes(); } finally { image.free(); }
}
