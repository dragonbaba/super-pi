import assert from "node:assert/strict";
import fsPromises, { mkdtemp, writeFile, rm, readFile, appendFile, truncate, rename, symlink, unlink, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { readWindow, readSmallFileIfStable, createReadWindowCounters, READ_CHUNK_BYTES, READ_WINDOW_BYTES, ReadCursorError } from "../packages/coding-agent/src/core/tools/read-window.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import type { ExtensionContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";

async function fixture(run: (path: string, directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "pi-read-window-"));
	try { await run(join(directory, "input.txt"), directory); }
	finally { await rm(directory, { recursive: true, force: true }); }
}

// Full-file readers belong exclusively to tests and benchmarks.
async function reference(path: string, offset: number, limit: number) {
	return (await readFile(path)).toString("utf8").split("\n").slice(offset - 1, offset - 1 + limit).join("\n");
}

for (const mib of [1, 10]) {
	test(`${mib} MiB LF/CRLF deterministic beginning/middle/end/random windows`, async () => fixture(async (path, directory) => {
		const row = "CJK 中文 👩‍💻 e\u0301";
		const rows: string[] = [];
		for (let i = 0, bytes = 0; bytes < mib * 1024 * 1024; i++) {
			const text = `${i}:${row}${i % 2 ? "\r" : ""}`;
			rows.push(text);
			bytes += Buffer.byteLength(text) + 1;
		}
		await writeFile(path, rows.join("\n"));
		let seed = 13;
		const offsets = [1, Math.floor(rows.length / 2), rows.length];
		for (let i = 0; i < 7; i++) { seed = (seed * 16807) % 2147483647; offsets.push(1 + seed % rows.length); }
		for (const offset of offsets) {
			const result = await readWindow(path, directory, "session", { offset, limit: 7 });
			assert.equal(result.text, await reference(path, offset, 7));
			assert.equal(result.startLine, offset);
		}
	}));
}

for (const suffix of ["😀", "中文", "e\u0301", "\r\n", "\xff\xfe", ""]) {
	test(`chunk and emergency boundary preserves ${JSON.stringify(suffix)}`, async () => fixture(async (path, directory) => {
		const source = Buffer.from("a".repeat(READ_CHUNK_BYTES - 1) + suffix + "z".repeat(READ_CHUNK_BYTES) + "\nlast");
		await writeFile(path, source);
		let cursor: string | undefined;
		let reconstructed = "";
		let nextByte = 0;
		do {
			const result = await readWindow(path, directory, "session", { cursor });
			assert.equal(result.startByte, nextByte);
			assert.equal(result.text, source.subarray(result.startByte, result.endByte).toString("utf8"));
			reconstructed += result.text + source.subarray(result.endByte, result.nextByte).toString("utf8");
			nextByte = result.nextByte;
			cursor = result.cursor;
		} while (cursor);
		assert.equal(reconstructed, source.toString("utf8"));
	}));
}

test("incremental decoder carries bytes when selected window starts inside a read chunk", async () => fixture(async (path, directory) => {
	await writeFile(path, "x".repeat(READ_CHUNK_BYTES - 1000) + "\n" + "a".repeat(998) + "😀\r\nz");
	const result = await readWindow(path, directory, "session", { offset: 2, limit: 1 });
	assert.equal(result.text, await reference(path, 2, 1));
}));

for (const source of [Buffer.alloc(0), Buffer.from("\n".repeat(10000)), Buffer.from("a\r\nb\r\n"), Buffer.from([0xff, 0xfe, 0xc2, 0x61, 0]), Buffer.alloc(40000, 0xff)]) {
	test(`empty/final-newline/invalid UTF-8 (${source.length} bytes)`, async () => fixture(async (path, directory) => {
		await writeFile(path, source);
		let cursor: string | undefined;
		let reconstructed = "";
		do {
			const result = await readWindow(path, directory, "session", { cursor });
			assert.ok(Buffer.byteLength(result.text) <= 50 * 1024);
			reconstructed += result.text + source.subarray(result.endByte, result.nextByte).toString("utf8");
			cursor = result.cursor;
		} while (cursor);
		assert.equal(reconstructed, source.toString("utf8"));
		await assert.rejects(readWindow(path, directory, "session", { offset: source.toString("utf8").split("\n").length + 1 }), /beyond end of file/);
	}));
}

for (const mutation of ["append", "truncate", "replace", "delete"] as const) {
	test(`${mutation} explicitly invalidates cursor`, async () => fixture(async (path, directory) => {
		await writeFile(path, "abcdef\n".repeat(10000));
		const first = await readWindow(path, directory, "session", { limit: 1 });
		if (mutation === "append") await appendFile(path, "new");
		if (mutation === "truncate") await truncate(path, 2);
		if (mutation === "replace") { await writeFile(path + ".new", "abcdef\n".repeat(10000)); await rename(path + ".new", path); }
		if (mutation === "delete") await unlink(path);
		await assert.rejects(readWindow(path, directory, "session", { cursor: first.cursor }), { code: "stale-cursor" });
	}));
}

test("foreign workspace/session, malformed cursor, and resume", async () => fixture(async (path, directory) => {
	await writeFile(path, "first\nsecond\nlast");
	const first = await readWindow(path, directory, "session", { limit: 1 });
	assert.ok(first.cursor);
	const pieces = first.cursor.split(".");
	const tampered = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
	tampered.byte++;
	await assert.rejects(readWindow(path, directory, "session", { cursor: pieces[0] + "." + Buffer.from(JSON.stringify(tampered)).toString("base64url") + "." + pieces[2] }), { code: "invalid-cursor" });
	await assert.rejects(readWindow(path, directory, "other", { cursor: first.cursor }), { code: "invalid-cursor" });
	await assert.rejects(readWindow(path, tmpdir(), "session", { cursor: first.cursor }), { code: "invalid-cursor" });
	await assert.rejects(readWindow(path, directory, "session", { cursor: "read-v1.bad" }), ReadCursorError);
	await assert.rejects(readWindow(path, directory, "session", { cursor: first.cursor, offset: 1 }), ReadCursorError);
	// No in-memory owner or cached file content is needed after serialization/resume.
	const resumed = await readWindow(path, directory, "session", { cursor: JSON.parse(JSON.stringify(first.cursor)), limit: 1 });
	assert.equal(resumed.text, "second");
}));

test("symlink target replacement invalidates cursor", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "a\nb");
	const link = join(directory, "link.txt");
	try { await symlink(path, link); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows runner lacks symlink privilege"); return; } throw error; }
	const first = await readWindow(link, directory, "session", { limit: 1 });
	await writeFile(path + ".new", "a\nc");
	await unlink(link);
	await symlink(path + ".new", link);
	await assert.rejects(readWindow(link, directory, "session", { cursor: first.cursor }), { code: "stale-cursor" });
}));

test("pre-abort and deterministic mid-scan abort close descriptors", async () => fixture(async (path, directory) => {
	await writeFile(path, "a\n".repeat(1024 * 1024));
	const before = createReadWindowCounters();
	await assert.rejects(readWindow(path, directory, "s", {}, AbortSignal.abort(), before), /Operation aborted/);
	assert.equal(before.fileOpens, 0);
	const counters = createReadWindowCounters();
	const signal = { get aborted() { return counters.bytesRead >= READ_CHUNK_BYTES; } } as AbortSignal;
	await assert.rejects(readWindow(path, directory, "s", { offset: 500000 }, signal, counters), /Operation aborted/);
	assert.equal(counters.fileOpens, 1);
	assert.equal(counters.fileCloses, 1);
}));

test("permission error is preserved and no descriptor escapes", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "x");
	const error = Object.assign(new Error("EACCES fixture"), { code: "EACCES" });
	const mocked = t.mock.method(fsPromises, "open", async () => { throw error; });
	syncBuiltinESMExports();
	const counters = createReadWindowCounters();
	try { await assert.rejects(readWindow(path, directory, "s", {}, undefined, counters), { code: "EACCES" }); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(counters.fileOpens, 0);
	assert.equal(counters.fileCloses, 0);
}));

test("small local output/details match legacy custom reader, including unusual numeric inputs", async () => fixture(async (path, directory) => {
	const local = createReadToolDefinition(directory);
	const legacy = createReadToolDefinition(directory, { operations: { readFile, access: async () => {} } });
	for (const text of ["", "a\r\n\r\nc\n", "中文😀e\u0301", "x".repeat(60000), "a\n".repeat(3000)]) {
		await writeFile(path, text);
		for (const params of [{}, { offset: 0 }, { offset: -2, limit: 1 }, { offset: 1.5, limit: 1.5 }, { limit: 0 }, { limit: -1 }, { offset: 2, limit: 2 }]) {
			const args = { path, ...params };
			const expected = await legacy.execute("test", args, undefined, undefined, {} as ExtensionContext).catch(String);
			const actual = await local.execute("test", args, undefined, undefined, {} as ExtensionContext).catch(String);
			assert.deepEqual(actual, expected);
		}
	}
}));

test("production minified JSON/JS, binary detection, resume and G2 budget", async () => fixture(async (path, directory) => {
	const ctx = { sessionManager: { getSessionId: () => "persistent-session" } } as ExtensionContext;
	for (const text of ['{"data":"' + "x".repeat(1024 * 1024) + '"}', 'const x="' + "x".repeat(1024 * 1024) + '";', "\0".repeat(1024 * 1024)]) {
		await writeFile(path, text);
		const tool = createReadToolDefinition(directory);
		const result = await tool.execute("read-large", { path }, undefined, undefined, ctx);
		assert.equal(result.details?.window?.partial, true);
		assert.equal(result.details?.window?.binary, text[0] === "\0");
		assert.match(result.content[0].type === "text" ? result.content[0].text : "", /partial/);
		const resumed = await createReadToolDefinition(directory).execute("resumed", { path, cursor: result.details?.window?.cursor }, undefined, undefined, ctx);
		assert.equal(resumed.details?.window?.startByte, result.details?.window?.nextByte);
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "persistent-session")!;
		const presentation = owner.create(result.content, "read-large")!;
		assert.ok(estimateToolOutputTokens(presentation.modelContent).estimatedTokens <= 256);
	}
}));

test("10 MiB single line returns a bounded partial line and sequential cursor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-read-window-"));
	try {
		const path = join(directory, "large.txt");
		await writeFile(path, "x".repeat(10 * 1024 * 1024));
		const counters = createReadWindowCounters();
		const first = await readWindow(path, directory, "session", {}, undefined, counters);
		assert.equal(first.partial, true);
		assert.ok(first.cursor);
		assert.ok(first.text.length <= 50 * 1024);
		assert.ok(counters.bytesRead < 100 * 1024);
		assert.equal(counters.lineArrayEntries, 0);
		const next = await readWindow(path, directory, "session", { cursor: first.cursor });
		assert.equal(next.startByte, first.nextByte);
		assert.equal(next.startLine, 1);
		let position = next.nextByte;
		let cursor = next.cursor;
		while (cursor) {
			const window = await readWindow(path, directory, "session", { cursor });
			assert.equal(window.startByte, position);
			assert.equal(window.text, "x".repeat(window.endByte - window.startByte));
			assert.ok(window.nextByte > position);
			position = window.nextByte;
			cursor = window.cursor;
		}
		assert.equal(position, 10 * 1024 * 1024);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("scanner AST: no inline callbacks, Promise tails, full-file materialization or caches", async () => {
	const path = new URL("../packages/coding-agent/src/core/tools/read-window.ts", import.meta.url);
	const source = await readFile(path, "utf8");
	const ast = ts.createSourceFile("read-window.ts", source, ts.ScriptTarget.Latest, true);
	let scanLoops = 0;
	function inspectLoop(node: ts.Node) {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, "no per-chunk inline closure");
		if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Map", "Set"].includes(node.expression.getText(ast)));
		if (ts.isCallExpression(node)) assert.ok(!/\.(then|catch|finally|split|map|filter|slice)$/.test(node.expression.getText(ast)));
		ts.forEachChild(node, inspectLoop);
	}
	function visit(node: ts.Node) {
		if (ts.isWhileStatement(node) && node.expression.getText(ast) === "position < size") { scanLoops++; inspectLoop(node); }
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.equal(scanLoops, 1);
	const code = ts.createPrinter({ removeComments: true }).printFile(ast);
	assert.doesNotMatch(code, /\breadFile\b|\.split\(|new (?:Map|Set)|Promise\.all|console\.|telemetry\./);
	assert.match(source, /finally\s*\{\s*await handle\.close\(\)/);
});

test("growth during a small descriptor read returns a bounded large window", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "old");
	const originalOpen = fsPromises.open;
	let opens = 0;
	let closes = 0;
	let maximumRead = 0;
	const mocked = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
		const handle = await originalOpen(...args);
		opens++;
		const isSmallDescriptor = opens === 2; // MIME sniff, then bounded small snapshot.
		const originalRead = handle.read;
		const originalClose = handle.close;
		let grew = false;
		t.mock.method(handle, "read", async (...readArgs: unknown[]) => {
			maximumRead = Math.max(maximumRead, Number(readArgs[2]));
			if (isSmallDescriptor && !grew) { grew = true; await appendFile(path, "x".repeat(1024 * 1024)); }
			return Reflect.apply(originalRead, handle, readArgs);
		});
		t.mock.method(handle, "close", async () => { closes++; return originalClose.call(handle); });
		return handle;
	});
	syncBuiltinESMExports();
	try {
		const result = await createReadToolDefinition(directory).execute("growing", { path }, undefined, undefined, {} as ExtensionContext);
		assert.equal(result.details?.window?.partial, true);
		assert.ok(result.details!.window!.endByte <= READ_WINDOW_BYTES);
		assert.ok(maximumRead <= READ_CHUNK_BYTES);
		assert.equal(opens, closes);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}));

test("final continuation suffix is visibly partial at LF and EOF", async () => fixture(async (path, directory) => {
	for (const ending of ["", "\nlast"]) {
		await writeFile(path, "x".repeat(READ_CHUNK_BYTES + 5) + ending);
		const tool = createReadToolDefinition(directory);
		let cursor: string | undefined;
		let suffixFound = false;
		do {
			const result = await tool.execute("partial", { path, cursor, limit: 1 }, undefined, undefined, {} as ExtensionContext);
			if (result.details?.window?.startsPartial && !result.details.window.partial) {
				assert.match(result.content[0].type === "text" ? result.content[0].text : "", /partial-line suffix/);
				suffixFound = true;
			}
			cursor = result.details?.window?.cursor;
		} while (cursor);
		assert.equal(suffixFound, true);
	}
}));

test("same spelling resumes through NFC-to-NFD filename fallback", async () => fixture(async (_path, directory) => {
	const actual = join(directory, "cafe\u0301.txt");
	const requested = join(directory, "caf\u00e9.txt");
	await writeFile(actual, "x".repeat(1024 * 1024));
	const tool = createReadToolDefinition(directory);
	const first = await tool.execute("fallback", { path: requested }, undefined, undefined, {} as ExtensionContext);
	const second = await tool.execute("fallback-next", { path: requested, cursor: first.details?.window?.cursor }, undefined, undefined, {} as ExtensionContext);
	assert.equal(second.details?.window?.startByte, first.details?.window?.nextByte);
}));

test("bounded small snapshots read zero-sized and overreported virtual files through EOF", async (t) => fixture(async (path) => {
	const text = "virtual content\n".repeat(500);
	await writeFile(path, text);
	let reportedSize = 0n;
	let opens = 0;
	let closes = 0;
	const originalOpen = fsPromises.open;
	const originalStat = fsPromises.stat;
	const mockedOpen = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
		const handle = await originalOpen(...args);
		opens++;
		const originalHandleStat = handle.stat;
		const originalClose = handle.close;
		t.mock.method(handle, "stat", async (...statArgs: unknown[]) => {
			const info = await Reflect.apply(originalHandleStat, handle, statArgs);
			info.size = reportedSize;
			return info;
		});
		t.mock.method(handle, "close", async () => { closes++; return originalClose.call(handle); });
		return handle;
	});
	const mockedStat = t.mock.method(fsPromises, "stat", async (...args: unknown[]) => {
		const info = await Reflect.apply(originalStat, fsPromises, args);
		info.size = reportedSize;
		return info;
	});
	syncBuiltinESMExports();
	try {
		assert.equal((await readSmallFileIfStable(path))?.toString("utf8"), text);
		reportedSize = 16000n;
		assert.equal((await readSmallFileIfStable(path))?.toString("utf8"), text);
		reportedSize = 0n;
		await writeFile(path, "x".repeat(READ_CHUNK_BYTES + 1));
		await assert.rejects(readSmallFileIfStable(path), { code: "unreliable-size" });
		assert.equal(opens, closes);
	} finally { mockedOpen.mock.restore(); mockedStat.mock.restore(); syncBuiltinESMExports(); }
}));

test("Linux procfs zero stat size preserves readable content", { skip: process.platform !== "linux" }, async () => {
	const expected = await readFile("/proc/version");
	assert.ok(expected.length > 0);
	assert.deepEqual(await readSmallFileIfStable("/proc/version"), expected);
});

// B0/B1 external-final-review seam: real descriptors, only read lengths/stat size
// are overridden. The repeated-position sentinel makes stalls finite and red.
async function reviewReadSeam(t: TestContext, options: {
	size?: bigint; lengths?: number[]; abortAfterFirst?: AbortController; growAtProbe?: string;
}, run: (state: { opens: number; closes: number; trace: number[][] }) => Promise<void>) {
	const originalOpen = fsPromises.open;
	const originalStat = fsPromises.stat;
	const state = { opens: 0, closes: 0, trace: [] as number[][] };
	const mockedOpen = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
		const handle = await originalOpen(...args);
		state.opens++;
		const originalRead = handle.read;
		const originalHandleStat = handle.stat;
		const originalClose = handle.close;
		let call = 0;
		let previousPosition = -1;
		t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
			if (options.lengths && position <= previousPosition) throw new Error("NON_PROGRESS_REPEATED_POSITION");
			previousPosition = position;
			const requested = Math.min(length, options.lengths?.[call] ?? length);
			if (options.growAtProbe && position === Number(options.size)) {
				await appendFile(options.growAtProbe, "changed");
				await utimes(options.growAtProbe, new Date(0), new Date("2030-01-01T00:00:00Z"));
			}
			const result = await Reflect.apply(originalRead, handle, [buffer, offset, requested, position]);
			state.trace.push([position, offset, length, result.bytesRead]);
			call++;
			if (call === 1) options.abortAfterFirst?.abort();
			return result;
		});
		t.mock.method(handle, "stat", async (...statArgs: unknown[]) => {
			const info = await Reflect.apply(originalHandleStat, handle, statArgs);
			if (options.size !== undefined) info.size = options.size;
			return info;
		});
		t.mock.method(handle, "close", async () => { state.closes++; return originalClose.call(handle); });
		return handle;
	});
	const mockedStat = t.mock.method(fsPromises, "stat", async (...args: unknown[]) => {
		const info = await Reflect.apply(originalStat, fsPromises, args);
		if (options.size !== undefined) info.size = options.size;
		return info;
	});
	syncBuiltinESMExports();
	try { await run(state); }
	finally {
		mockedOpen.mock.restore(); mockedStat.mock.restore(); syncBuiltinESMExports();
		assert.equal(state.opens, state.closes, "all descriptors close on success/error/abort");
	}
}

for (const sample of [
	{ name: "CRLF", prefix: "\r\n", lengths: [1] },
	{ name: "UTF8", prefix: "😀", lengths: [1] },
	{ name: "ASCII", prefix: "A", lengths: [1, 1, 1] },
	{ name: "consecutive", prefix: "😀\r\n", lengths: [1, 1, 1, 1, 1, 1] },
	{ name: "window boundary", prefix: "a".repeat(READ_WINDOW_BYTES - 2) + "😀\r\n", lengths: [READ_WINDOW_BYTES - 3, 1, 1, 1] },
]) {
	test(`B1 short-read fill ${sample.name} advances positional reads`, async (t) => fixture(async (path, directory) => {
		const source = Buffer.from(sample.prefix + "z".repeat(READ_CHUNK_BYTES + 16));
		await writeFile(path, source);
		await reviewReadSeam(t, { lengths: sample.lengths }, async (state) => {
			const counters = createReadWindowCounters();
			const result = await readWindow(path, directory, "short-read", {}, undefined, counters);
			assert.equal(result.text, source.subarray(result.startByte, result.endByte).toString("utf8"));
			assert.ok(result.done || result.nextByte > result.startByte);
			assert.ok(result.cursor);
			assert.equal(state.trace[1][0], sample.lengths[0]);
			assert.equal(state.trace[1][1], sample.lengths[0], "fill remaining buffer space");
			assert.equal(state.trace[1][2], READ_WINDOW_BYTES - sample.lengths[0]);
			assert.ok(counters.shortReadFillCalls > 0);
			assert.ok(counters.shortReadBytes > 0);
			assert.equal(counters.zeroProgressPrevented, 0);
			t.diagnostic(JSON.stringify({ firstFill: state.trace, counters }));
			const next = await readWindow(path, directory, "short-read", { cursor: result.cursor });
			assert.equal(next.startByte, result.nextByte);
			assert.equal(next.text, source.subarray(next.startByte, next.endByte).toString("utf8"));
		});
	}));
}

test("B1 abort between positive short fill reads closes descriptor", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "😀" + "z".repeat(READ_CHUNK_BYTES));
	const controller = new AbortController();
	await reviewReadSeam(t, { lengths: [1], abortAfterFirst: controller }, async (state) => {
		await assert.rejects(readWindow(path, directory, "abort-fill", {}, controller.signal), /Operation aborted/);
		assert.equal(state.trace.length, 1);
	});
}));

for (const size of [0n, 1n, 16000n]) {
	test(`B0 underreported-size small snapshot reported=${size} preserves complete content`, async (t) => fixture(async (path, directory) => {
		const text = "virtual content\n".repeat(500);
		await writeFile(path, text);
		await reviewReadSeam(t, { size }, async () => {
			const result = await createReadToolDefinition(directory).execute("virtual-small", { path }, undefined, undefined, {} as ExtensionContext);
			assert.deepEqual(result.content, [{ type: "text", text }]);
			assert.equal(result.details, undefined);
		});
	}));
}

for (const size of [0n, 1n]) {
	test(`B0 underreported-size production rejects oversized actual content reported=${size}`, async (t) => fixture(async (path, directory) => {
		await writeFile(path, "x".repeat(READ_CHUNK_BYTES + 100));
		await reviewReadSeam(t, { size }, async (state) => {
			const attempt = createReadToolDefinition(directory).execute("virtual-large", { path }, undefined, undefined, {} as ExtensionContext);
			await assert.rejects(attempt.then((result) => {
				t.diagnostic(JSON.stringify({ unexpectedSuccess: result.details?.window, returnedContent: result.content }));
				return result;
			}), { code: "unreliable-size" });
			assert.equal(state.opens, 2, "MIME + small snapshot, no automatic scanner retry");
		});
	}));
}

test("B0 underreported-size direct scanner verifies reported EOF", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "x".repeat(READ_CHUNK_BYTES + 100));
	await reviewReadSeam(t, { size: 1n }, async () => {
		const counters = createReadWindowCounters();
		await assert.rejects(readWindow(path, directory, "direct-eof", {}, undefined, counters), { code: "unreliable-size" });
		assert.equal(counters.eofProbes, 1);
		assert.equal(counters.eofProbeBytes, 1);
		assert.equal(counters.unreliableSizeDetections, 1);
		assert.equal(counters.decoderFlushes, 0);
		assert.equal(counters.continuationCount, 0);
		t.diagnostic(JSON.stringify({ underreportedEof: counters }));
});
}));

test("B0 reported EOF probe validates generation before unreliable-size", async (t) => fixture(async (path, directory) => {
	await writeFile(path, "xy");
	await reviewReadSeam(t, { size: 1n, growAtProbe: path }, async () => {
		await assert.rejects(readWindow(path, directory, "mutated-eof", {}), { code: "stale-cursor" });
	});
}));

test("B0 reliable EOF uses one zero-byte probe and the existing source Buffer", async () => fixture(async (path, directory) => {
	for (const text of ["", "abc", "\r\n", "😀"]) {
		await writeFile(path, text);
		const counters = createReadWindowCounters();
		const result = await readWindow(path, directory, "confirmed-eof", {}, undefined, counters);
		assert.equal(result.text, text);
		assert.equal(result.done, true);
		assert.equal(result.cursor, undefined);
		assert.equal(counters.eofProbes, 1);
		assert.equal(counters.eofProbeBytes, 0);
		assert.equal(counters.bufferAllocations, 1);
		assert.equal(counters.unreliableSizeDetections, 0);
		assert.equal(counters.bytesRead, Buffer.byteLength(text));
		assert.equal(counters.fileOpens, counters.fileCloses);
	}
}));
