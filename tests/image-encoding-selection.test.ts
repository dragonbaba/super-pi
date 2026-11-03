import assert from "node:assert/strict";
import test from "node:test";
import { resizeImageInProcess } from "../packages/coding-agent/src/utils/image-resize-core.ts";
import { loadPhoton } from "../packages/coding-agent/src/utils/photon.ts";
import { encodingFixture } from "./helpers/image-encoding-fixtures.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";

test("opaque photo chooses the smaller encoding at the requested quality and materializes base64 once", async t => {
	const photon = await loadPhoton(); assert.ok(photon);
	const input = await encodingFixture("photo");
	const source = photon.PhotonImage.new_from_byteslice(input);
	const reference = photon.resize(source, 256, 192, photon.SamplingFilter.Lanczos3);
	let png: Uint8Array, jpeg: Uint8Array;
	try { png = reference.get_bytes(); jpeg = reference.get_bytes_jpeg(80); }
	finally { reference.free(); source.free(); }
	assert.ok(jpeg.length < png.length);
	let base64 = 0; const qualities: number[] = [];
	const toString = Buffer.prototype.toString, encode = photon.PhotonImage.prototype.get_bytes_jpeg;
	t.mock.method(Buffer.prototype, "toString", function(this: Buffer, ...args: Parameters<Buffer["toString"]>) { if (args[0] === "base64") base64++; return toString.apply(this, args); });
	t.mock.method(photon.PhotonImage.prototype, "get_bytes_jpeg", function(this: InstanceType<typeof photon.PhotonImage>, quality: number) { qualities.push(quality); return encode.call(this, quality); });
	const result = await resizeImageInProcess(input, "image/png", { maxWidth: 256 });
	assert.ok(result);
	assert.equal(result.mimeType, "image/jpeg");
	assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(jpeg));
	assert.deepEqual(qualities, [80]);
	assert.equal(base64, 1);
});

for (const kind of ["photo", "transparent", "text"] as const) test(`${kind}: dimensions, alpha and visual error survive encoding selection`, async t => {
	const photon = await loadPhoton(); assert.ok(photon);
	const input = await encodingFixture(kind);
	const source = photon.PhotonImage.new_from_byteslice(input);
	const reference = photon.resize(source, 256, 192, photon.SamplingFilter.Lanczos3);
	try {
		const result = await resizeImageInProcess(input, "image/png", { maxWidth: 256 }); assert.ok(result);
		assert.deepEqual([result.width, result.height], [256, 192]);
		const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
		try {
			const expected = reference.get_raw_pixels(), actual = decoded.get_raw_pixels();
			assert.equal(actual.length, expected.length);
			let squared = 0, classified = 0, correct = 0;
			for (let i = 0; i < actual.length; i += 4) {
				assert.equal(actual[i + 3], expected[i + 3], "alpha must be exact");
				for (let c = 0; c < 3; c++) squared += (actual[i + c] - expected[i + c]) ** 2;
				if (kind === "text" && (expected[i] < 50 || expected[i] > 210)) { classified++; if ((actual[i] < 128) === (expected[i] < 128)) correct++; }
			}
			const rmse = Math.sqrt(squared / (actual.length / 4 * 3));
			assert.ok(rmse < 15, "RGB RMSE below 15 against lossless resize");
			if (kind === "text") assert.ok(correct / classified > 0.99, "at least 99% strong text/background samples preserve contrast");
			if (kind === "transparent") { assert.equal(result.mimeType, "image/png"); assert.deepEqual(actual, expected); }
			t.diagnostic(JSON.stringify({ kind, mimeType: result.mimeType, rmse, textContrastAccuracy: classified ? correct / classified : null, base64CodeUnits: result.data.length }));
		} finally { decoded.free(); }
	} finally { reference.free(); source.free(); }
});

test("lossless PNG remains selected when smaller than JPEG", async () => {
	const result = await resizeImageInProcess(pngFixture(8, 4), "image/png", { maxWidth: 4 });
	assert.ok(result); assert.equal(result.mimeType, "image/png");
});

test("transparent oversized image never drops alpha to satisfy the size cap", async t => {
	const photon = await loadPhoton(); assert.ok(photon);
	const input = await encodingFixture("transparent", 128, 96);
	t.mock.method(photon.PhotonImage.prototype, "get_bytes_jpeg", () => { assert.fail("transparent images must not use JPEG"); });
	const result = await resizeImageInProcess(input, "image/png", { maxBytes: 3000 });
	assert.ok(result); assert.equal(result.mimeType, "image/png"); assert.ok(result.data.length < 3000);
	assert.ok(result.width < 128);
});

test("lower qualities are tried only as needed and never exceed the requested quality", async t => {
	const photon = await loadPhoton(); assert.ok(photon);
	const input = await encodingFixture("photo", 128, 96);
	const encode = photon.PhotonImage.prototype.get_bytes_jpeg;
	const qualities: number[] = [];
	t.mock.method(photon.PhotonImage.prototype, "get_bytes_jpeg", function(this: InstanceType<typeof photon.PhotonImage>, quality: number) { qualities.push(quality); return encode.call(this, quality); });
	const result = await resizeImageInProcess(input, "image/png", { maxWidth: 64, maxBytes: 1300, jpegQuality: 60 });
	assert.ok(result); assert.ok(result.data.length < 1300);
	assert.ok(qualities.every(quality => quality <= 60));
	assert.ok(qualities.includes(55));
});
