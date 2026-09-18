import { deflateSync, crc32 } from "node:zlib";

/** Deterministic, non-sensitive PNGs; creation is outside every measured region. */
function chunk(type: string, data: Buffer): Buffer {
	const name = Buffer.from(type); const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4); return out;
}
export function pngFixture(width: number, height: number, noise = false): Buffer {
	const raw = Buffer.alloc((width * 4 + 1) * height); let seed = 123456789;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const offset = y * (width * 4 + 1) + 1 + x * 4;
		seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
		raw[offset] = noise ? seed & 255 : Math.floor(x / 64) % 2 ? 40 : 220;
		raw[offset + 1] = noise ? seed >>> 8 & 255 : Math.floor(y / 64) % 2 ? 80 : 230;
		raw[offset + 2] = noise ? seed >>> 16 & 255 : 170;
		raw[offset + 3] = noise ? seed >>> 24 & 255 : 255;
	}
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}
export function oversizedHeader(): Buffer {
	const header = Buffer.alloc(13); header.writeUInt32BE(100000); header.writeUInt32BE(100000, 4); header[8] = 8; header[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IEND", Buffer.alloc(0))]);
}
