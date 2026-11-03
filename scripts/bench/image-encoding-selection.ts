import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadPhoton } from "../../packages/coding-agent/src/utils/photon.ts";
import type { ImageResizeOptions, ResizedImage } from "../../packages/coding-agent/src/utils/image-resize-core.ts";
import { encodingFixture } from "../../tests/helpers/image-encoding-fixtures.ts";

const moduleIndex = process.argv.indexOf("--core-module");
const modulePath = resolve(moduleIndex < 0 ? "packages/coding-agent/src/utils/image-resize-core.ts" : process.argv[moduleIndex + 1]);
const { resizeImageInProcess } = await import(pathToFileURL(modulePath).href) as { resizeImageInProcess: (input: Uint8Array, mime: string, options: ImageResizeOptions) => Promise<ResizedImage | null> };
const smoke = process.argv.includes("--smoke"), optimized = moduleIndex < 0;
const photon = await loadPhoton(); assert.ok(photon); assert.ok(globalThis.gc, "run with --expose-gc");
type Image = InstanceType<typeof photon.PhotonImage>;
const warmup = 3, timingIterations = 16, profileIterations = 8, samplingInterval = 1024;
async function gc() { for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); } }

// Temporary instrumentation stores only primitive sizes and WeakRefs. It never owns image buffers.
async function count(input: Uint8Array, options: ImageResizeOptions, fault?: "png" | "jpeg" | "alpha") {
	const proto = photon!.PhotonImage.prototype;
	const imageClass = photon!.PhotonImage as typeof photon.PhotonImage & { __wrap(ptr: number): Image };
	const originals = { png: proto.get_bytes, jpeg: proto.get_bytes_jpeg, raw: proto.get_raw_pixels, free: proto.free,
		wrap: imageClass.__wrap, toString: Buffer.prototype.toString };
	const refs: WeakRef<object>[] = [];
	const stats = { png: 0, jpeg: 0, qualities: [] as number[], base64: 0, base64CodeUnits: 0, encodedBytes: 0,
		largestEncodingBytes: 0, rgbaBytes: 0, largestRgbaBytes: 0, imagesCreated: 0, imagesFreed: 0, liveImages: 0, peakImages: 0,
		zeroedPointers: 0, peakHeap: 0, peakExternal: 0, peakArrayBuffers: 0 };
	function sample() { const m = process.memoryUsage(); stats.peakHeap = Math.max(stats.peakHeap, m.heapUsed); stats.peakExternal = Math.max(stats.peakExternal, m.external); stats.peakArrayBuffers = Math.max(stats.peakArrayBuffers, m.arrayBuffers); }
	function image(value: Image) { stats.imagesCreated++; stats.liveImages++; stats.peakImages = Math.max(stats.peakImages, stats.liveImages); refs.push(new WeakRef(value)); return value; }
	function bytes(value: Uint8Array, raw = false) {
		refs.push(new WeakRef(value));
		if (raw) { stats.rgbaBytes += value.byteLength; stats.largestRgbaBytes = Math.max(stats.largestRgbaBytes, value.byteLength); }
		else { stats.encodedBytes += value.byteLength; stats.largestEncodingBytes = Math.max(stats.largestEncodingBytes, value.byteLength); }
		sample(); return value;
	}
	proto.get_bytes = function() { stats.png++; if (fault === "png") throw new Error("fixture encode error"); return bytes(originals.png.call(this)); };
	proto.get_bytes_jpeg = function(quality) { stats.jpeg++; stats.qualities.push(quality); if (fault === "jpeg") throw new Error("fixture encode error"); return bytes(originals.jpeg.call(this, quality)); };
	proto.get_raw_pixels = function() { if (fault === "alpha") throw new Error("fixture pixel error"); return bytes(originals.raw.call(this), true); };
	proto.free = function() { originals.free.call(this); stats.imagesFreed++; stats.liveImages--; if ((this as Image & { __wbg_ptr: number }).__wbg_ptr === 0) stats.zeroedPointers++; };
	imageClass.__wrap = function(ptr) { return image(originals.wrap(ptr)); };
	Buffer.prototype.toString = function(...args) { const value = originals.toString.apply(this, args); if (args[0] === "base64") { stats.base64++; stats.base64CodeUnits += value.length; } return value; };
	let result: ResizedImage | null;
	try { result = await resizeImageInProcess(input, "image/png", options); }
	finally {
		proto.get_bytes = originals.png; proto.get_bytes_jpeg = originals.jpeg; proto.get_raw_pixels = originals.raw; proto.free = originals.free;
		imageClass.__wrap = originals.wrap; Buffer.prototype.toString = originals.toString;
	}
	await gc();
	const retainedTemporaryObjects = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
	assert.equal(stats.imagesCreated, stats.imagesFreed); assert.equal(stats.liveImages, 0);
	assert.equal(stats.zeroedPointers, stats.imagesFreed); assert.equal(retainedTemporaryObjects, 0);
	if (fault) assert.equal(result, null);
	return { ...stats, retainedTemporaryObjects, result: result && { mimeType: result.mimeType, width: result.width, height: result.height, base64CodeUnits: result.data.length },
		// Source invariant proves at most two encoded byte slots, not that the GC immediately frees garbage.
		liveEncodedSlotBytesUpperBound: optimized ? 2 * stats.largestEncodingBytes : null };
}

function profileStats(root: any) {
	let total = 0; const sites = new Map<string, number>();
	function visit(node: any) { total += node.selfSize; const label = `${node.callFrame.functionName || "(anonymous)"}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`; sites.set(label, (sites.get(label) ?? 0) + node.selfSize); for (const child of node.children) visit(child); }
	visit(root); return { total, topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
async function measure(size: number, input: Uint8Array) {
	const options = { maxWidth: size / 2 };
	for (let i = 0; i < warmup; i++) await resizeImageInProcess(input, "image/png", options);
	await gc(); const before = process.memoryUsage(); const cpu = process.cpuUsage(); const times: number[] = [];
	for (let i = 0; i < timingIterations; i++) { const start = performance.now(); await resizeImageInProcess(input, "image/png", options); times.push(performance.now() - start); }
	const elapsedCpu = process.cpuUsage(cpu); await gc(); const after = process.memoryUsage();
	const session = new Session(); session.connect();
	let profile;
	try {
		await session.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < profileIterations; i++) await resizeImageInProcess(input, "image/png", options);
		profile = (await session.post("HeapProfiler.stopSampling")).profile;
	} finally { session.disconnect(); }
	const allocations = profileStats(profile.head); times.sort((a, b) => a - b);
	return { size, p50Ms: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
		cpuUsPerImage: (elapsedCpu.user + elapsedCpu.system) / timingIterations, sampledBytesPerImage: allocations.total / profileIterations,
		topSites: allocations.topSites, before, after };
}

const counters = [], profiles = [];
for (const size of [256, 512, 1024]) {
	const input = await encodingFixture("photo", size, size * 3 / 4);
	const row = await count(input, { maxWidth: size / 2 });
	if (optimized) { assert.equal(row.png, 1); assert.equal(row.jpeg, 1); assert.equal(row.base64, 1); assert.equal(row.peakImages, 2); assert.equal(row.rgbaBytes, size / 2 * size * 3 / 8 * 4); }
	counters.push({ kind: "photo", size, ...row });
	if (!smoke) profiles.push(await measure(size, input));
}
for (const kind of ["transparent", "text"] as const) {
	const row = await count(await encodingFixture(kind), { maxWidth: 256 });
	if (optimized) { assert.equal(row.base64, 1); if (kind === "transparent") assert.equal(row.jpeg, 0); }
	counters.push({ kind, size: 512, ...row });
}
const input = await encodingFixture("photo", 128, 96);
const lifecycle = [];
for (const fault of ["png", "jpeg", ...(optimized ? ["alpha"] as const : [])] as const) lifecycle.push({ reason: fault, ...await count(input, { maxWidth: 64 }, fault) });
const impossible = await count(input, { maxWidth: 64, maxBytes: 1 });
assert.equal(impossible.result, null); if (optimized) assert.equal(impossible.base64, 0);
lifecycle.push({ reason: "impossible-cap", ...impossible });
const fast = await count(input, {}); assert.equal(fast.png + fast.jpeg, 0); assert.equal(fast.rgbaBytes, 0); assert.equal(fast.base64, 1);
lifecycle.push({ reason: "fast-path", ...fast });
console.log(JSON.stringify({ node: process.version, platform: process.platform, modulePath, sourceSha256: createHash("sha256").update(readFileSync(modulePath)).digest("hex"), optimized,
	warmup, timingIterations, profileIterations, samplingInterval, counters, lifecycle, profiles,
	notes: "V8 sampling excludes most WASM/native buffers; encoded/RGBA byte counters are exact JS-returned lengths. WASM capacity may remain reserved after free. Peak memory is sampled at encodes, not a process-wide absolute peak. Inputs and returned base64 remain caller-owned during GC checks." }, null, 2));
