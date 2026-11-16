import assert from "node:assert/strict";
import test from "node:test";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";
import { MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "../packages/codemode/src/limits.ts";

function fullStore(): Record<string, unknown> {
	const values: Record<string, unknown> = Object.create(null);
	for (let index = 0; index < 4; index++) values[`blob${index}`] = "x".repeat(250000);
	return values;
}

test("store capacity failure exposes metadata-only cleanup without replaying completed tools", async () => {
	let completed = 0;
	const sandbox = new CodemodeSandbox({ reuseWorker: true, tools: [{ name: "touch", execute: () => ++completed }] });
	const store = fullStore();
	try {
		const failed = await sandbox.execute('await tools.touch({}); store("overflow", "y".repeat(100000));', { store });
		assert.equal(failed.ok, false);
		assert.equal(failed.calls[0]?.status, "ok");
		assert.equal(completed, 1);
		assert.equal("storeWrites" in failed, false, "a failed script never commits staged state");
		if (!failed.ok) assert.match(failed.error.message, /storeInfo\(\)/);
		const inspect = await sandbox.execute("return storeInfo()", { store });
		assert.ok(inspect.ok, JSON.stringify(inspect));
		if (!inspect.ok) return;
		const info = inspect.value as any;
		assert.equal(info.usedChars, 1000028);
		assert.equal(info.maxChars, MAX_STORE_TOTAL_CHARS);
		assert.equal(info.maxValueChars, MAX_STORE_VALUE_CHARS);
		assert.equal(info.keyCount, 4);
		assert.deepEqual(info.entries, [0, 1, 2, 3].map(index => ({ key: `blob${index}`, chars: 250007 })));
		assert.equal(info.nextOffset, null);
		assert.ok(JSON.stringify(info).length < 1000, "inspection never copies stored payloads");
		const cleaned = await sandbox.execute('store("blob0", undefined); store("cursor", "next"); return storeInfo()', { store });
		assert.ok(cleaned.ok, JSON.stringify(cleaned));
		if (cleaned.ok) {
			assert.deepEqual(cleaned.storeWrites.delete, ["blob0"]);
			assert.deepEqual({ ...cleaned.storeWrites.set }, { cursor: "next" });
			assert.equal((cleaned.value as any).usedChars, 750033);
		}
		assert.deepEqual(inspect.calls, []); assert.deepEqual(cleaned.calls, []);
		assert.equal(completed, 1, "inspect and cleanup never repeat the completed tool");
	} finally { await sandbox.close(); }
});

test("store metadata pages use current JSON sizes without leaking values or mutable state", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const store = JSON.parse('{"__proto__":{"private":"body"},"中":"😀","tail":1}');
		const result = await sandbox.execute(`
			const first = storeInfo({limit:1});
			const second = storeInfo({offset:first.nextOffset,limit:1});
			first.entries[0].key = "changed";
			store("tail",undefined); store("new",true);
			return { second, current:storeInfo(), beyond:storeInfo({offset:99,limit:1}) };
		`, { store });
		assert.ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		const value = result.value as any;
		assert.deepEqual(value.second.entries, [{ key: "中", chars: 5 }]);
		assert.equal(value.second.nextOffset, 2);
		assert.deepEqual(value.current.entries, [{ key: "__proto__", chars: 27 }, { key: "中", chars: 5 }, { key: "new", chars: 7 }]);
		assert.equal(value.current.usedChars, 39);
		assert.deepEqual(value.beyond.entries, []); assert.equal(value.beyond.nextOffset, null);
		assert.doesNotMatch(JSON.stringify(value), /private|body|😀/);
	} finally { await sandbox.close(); }
});

test("storeInfo validates page arguments and cannot be shadowed by host globals", async () => {
	assert.throws(() => new CodemodeSandbox({ globals: [{ name: "storeInfo", execute: () => 1 }] }), /reserved|built-in|helper/);
	const sandbox = new CodemodeSandbox({ reuseWorker: true });
	try {
		for (const argument of ["null", "[]", "1", "{offset:-1}", "{offset:NaN}", "{limit:0}", "{limit:Infinity}", "{limit:4097}"]) {
			const result = await sandbox.execute(`try { storeInfo(${argument}); return false; } catch (error) { return error.name; }`);
			assert.ok(result.ok, JSON.stringify(result));
			assert.match(String(result.ok && result.value), /^(TypeError|RangeError)$/);
		}
	} finally { await sandbox.close(); }
});

test("store inspection pages a full key catalog without retaining a cross-script inventory", async () => {
	const store: Record<string, unknown> = Object.create(null);
	for (let index = 0; index < 4096; index++) store[`id${index}`] = index;
	const sandbox = new CodemodeSandbox({ reuseWorker: true });
	try {
		const result = await sandbox.execute("return {first:storeInfo(),last:storeInfo({offset:4080})}", { store });
		assert.ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		const pages = result.value as any;
		assert.equal(pages.first.keyCount, 4096); assert.equal(pages.first.entries.length, 16); assert.equal(pages.first.nextOffset, 16);
		assert.equal(pages.last.entries.length, 16); assert.equal(pages.last.entries[0].key, "id4080"); assert.equal(pages.last.nextOffset, null);
		assert.deepEqual(result.calls, []);
		const empty = await sandbox.execute("return storeInfo()");
		assert.ok(empty.ok);
		if (empty.ok) { assert.equal((empty.value as any).keyCount, 0); assert.deepEqual((empty.value as any).entries, []); }
	} finally { await sandbox.close(); }
	assert.equal(sandbox.stats.activeExecutions, 0);
	assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
});

test("caught optional caching failure can free a known key and continue with the obtained result", async () => {
	let completed = 0;
	const sandbox = new CodemodeSandbox({ tools: [{ name: "touch", execute: () => ({ id: ++completed }) }] });
	try {
		const result = await sandbox.execute(`
			const obtained = await tools.touch({});
			const before = storeInfo();
			try { store("tooBig", "y".repeat(100000)); }
			catch (error) {
				if (storeInfo().usedChars !== before.usedChars) throw new Error("failed write changed state");
				store("blob0", undefined);
			}
			store("lastId", obtained.id);
			return {obtained,info:storeInfo()};
		`, { store: fullStore() });
		assert.ok(result.ok, JSON.stringify(result));
		if (!result.ok) return;
		assert.deepEqual((result.value as any).obtained, { id: 1 });
		assert.equal((result.value as any).info.usedChars, 750028);
		assert.deepEqual(result.storeWrites.delete, ["blob0"]);
		assert.deepEqual({ ...result.storeWrites.set }, { lastId: 1 });
		assert.equal(completed, 1);
	} finally { await sandbox.close(); }
});
