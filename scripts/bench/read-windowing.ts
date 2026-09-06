import assert from "node:assert/strict";
import fsPromises, { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { setImmediate as immediate } from "node:timers/promises";
import { createReadToolDefinition } from "../../packages/coding-agent/src/core/tools/read.ts";
import { createReadWindowCounters, readWindow, READ_CHUNK_BYTES, READ_WINDOW_BYTES, type ReadWindowResult } from "../../packages/coding-agent/src/core/tools/read-window.ts";
import { truncateHead } from "../../packages/coding-agent/src/core/tools/truncate.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../packages/coding-agent/src/utils/mime.ts";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-read-bench-"));
const mode = process.argv[2] ?? "timing";
const rows = 10 * 1024 * 1024 / 64;
const smallPath = join(directory, "small.txt");
const largePath = join(directory, "large.txt");
const singlePath = join(directory, "single.txt");
const ctx = { sessionManager: { getSessionId: () => "benchmark-session" } } as ExtensionContext;

async function baseline(path: string, offset: number, limit: number) {
	const bytes = await readFile(path);
	const text = bytes.toString("utf8");
	const lines = text.split("\n");
	return truncateHead(lines.slice(offset - 1, offset - 1 + limit).join("\n"));
}

try {
	await writeFile(smallPath, "small file\n".repeat(32));
	await writeFile(largePath, ("a".repeat(63) + "\n").repeat(rows));
	await writeFile(singlePath, "x".repeat(10 * 1024 * 1024));
	if (mode === "timing") {
		const local = createReadToolDefinition(directory);
		const legacy = createReadToolDefinition(directory, { operations: { readFile, access, detectImageMimeType: detectSupportedImageMimeTypeFromFile } });
		const timings = [];
		for (const name of ["small", "middle", "end", "single"]) {
			const path = name === "small" ? smallPath : name === "single" ? singlePath : largePath;
			const offset = name === "middle" ? rows / 2 : name === "end" ? rows - 10 : 1;
			const before: number[] = [];
			const after: number[] = [];
			let counters = createReadWindowCounters();
			for (let i = 0; i < 8; i++) {
				let start = performance.now();
				if (name === "small") await legacy.execute("bench", { path, limit: 10 }, undefined, undefined, ctx);
				else await baseline(path, offset, 10);
				before.push(performance.now() - start);
				counters = createReadWindowCounters();
				start = performance.now();
				if (name === "small") await local.execute("bench", { path, limit: 10 }, undefined, undefined, ctx);
				else await readWindow(path, directory, "benchmark-session", { offset, limit: 10 }, undefined, counters);
				after.push(performance.now() - start);
			}
			before.sort((a, b) => a - b); after.sort((a, b) => a - b);
			timings.push({ name, beforeMedianMs: before[4], afterMedianMs: after[4], counters });
		}
		console.log(JSON.stringify({ mode, node: process.version, platform: process.platform, timings }));
	} else if (mode === "allocation") {
		const inspector = new Session();
		inspector.connect();
		await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
		const initialHeap = process.memoryUsage().heapUsed;
		let peakHeap = initialHeap;
		const counters = createReadWindowCounters();
		for (let i = 0; i < 12; i++) {
			await readWindow(largePath, directory, "bench", { offset: rows / 2, limit: 10 }, undefined, counters);
			await readWindow(singlePath, directory, "bench", { limit: 1 }, undefined, counters);
			peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		}
		const { profile } = await inspector.post("HeapProfiler.stopSampling");
		inspector.disconnect();
		const sites = new Map<string, number>();
		function visit(node: typeof profile.head) {
			const name = `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
			sites.set(name, (sites.get(name) ?? 0) + node.selfSize);
			for (const child of node.children ?? []) visit(child);
		}
		visit(profile.head);
		console.log(JSON.stringify({ mode, initialHeap, peakHeap, finalHeap: process.memoryUsage().heapUsed, counters, leadingSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 15) }));
	} else if (mode === "gc") {
		assert.ok(global.gc, "run with --expose-gc");
		const references: WeakRef<object>[] = [];
		const originalAlloc = Buffer.allocUnsafe;
		const originalOpen = fsPromises.open;
		const OriginalDecoder = TextDecoder;
		Buffer.allocUnsafe = function trackedAlloc(size: number) {
			const value = originalAlloc(size);
			if (size === READ_CHUNK_BYTES || size === READ_WINDOW_BYTES) references.push(new WeakRef(value));
			return value;
		};
		fsPromises.open = async function trackedOpen(...args: Parameters<typeof originalOpen>) {
			const value = await originalOpen(...args);
			references.push(new WeakRef(value));
			return value;
		};
		globalThis.TextDecoder = class extends OriginalDecoder {
			constructor(...args: ConstructorParameters<typeof OriginalDecoder>) { super(...args); references.push(new WeakRef(this)); }
		};
		syncBuiltinESMExports();
		global.gc();
		const initialHeap = process.memoryUsage().heapUsed;
		let peakHeap = initialHeap;
		const counters = createReadWindowCounters();
		try {
			let result: ReadWindowResult | undefined = await readWindow(singlePath, directory, "bench", {}, undefined, counters);
			references.push(new WeakRef(result));
			const cursor = result.cursor;
			result = await readWindow(singlePath, directory, "bench", { cursor }, undefined, counters);
			references.push(new WeakRef(result));
			result = undefined;
			const signal = { get aborted() { return counters.bytesRead > READ_WINDOW_BYTES * 2; } } as AbortSignal;
			await assert.rejects(readWindow(largePath, directory, "bench", { offset: rows / 2 }, signal, counters), /aborted/);
			await assert.rejects(readWindow(largePath, directory, "bench", { offset: rows + 2 }, undefined, counters), /beyond end/);
			peakHeap = process.memoryUsage().heapUsed;
		} finally {
			Buffer.allocUnsafe = originalAlloc;
			fsPromises.open = originalOpen;
			globalThis.TextDecoder = OriginalDecoder;
			syncBuiltinESMExports();
		}
		await immediate();
		for (let i = 0; i < 6; i++) { global.gc(); await immediate(); }
		const retained = references.filter((ref) => ref.deref() !== undefined).length;
		console.log(JSON.stringify({ mode, initialHeap, peakHeap, finalHeap: process.memoryUsage().heapUsed, weakRefs: references.length, retained, counters }));
		assert.equal(counters.fileOpens, counters.fileCloses);
		assert.equal(retained, 0);
	} else throw new Error(`Unknown mode: ${mode}`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
