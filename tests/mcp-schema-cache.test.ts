import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
// @ts-expect-error JavaScript extension package.
import { McpSchemaCache, configFingerprint, prepareSchemaCache } from "../packages/mcp-bridge/src/schema-cache.js";

const TOOLS = [{ name: "lookup", inputSchema: { type: "object" } }];
const CONFIG = { source: "global", transport: "http", url: "https://fixture.invalid/mcp", maxTools: 64,
	headers: { Authorization: "Bearer fixture-guessable-secret" }, env: { TOKEN: "fixture-env-secret" }, args: ["fixture-arg-secret"] };

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "sp-mcp-cache-key-"));
	t.diagnostic(`ownedFixture=${root}`);
	const previous = process.env.SP_CODING_AGENT_DIR;
	t.after(() => {
		try {
			if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR;
			else process.env.SP_CODING_AGENT_DIR = previous;
		} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	});
	process.env.SP_CODING_AGENT_DIR = root;
	const path = join(root, "cache", "mcp-schemas-v1.json");
	const keyPath = join(root, "mcp-activation.key");
	return { root, path, keyPath };
}

test("schema cache persists only domain-separated keyed identities and reopens with the same key", t => {
	const f = fixture(t);
	const key = Buffer.alloc(32, 7); writeFileSync(f.keyPath, key);
	const cache = new McpSchemaCache();
	assert.equal(cache.put(CONFIG, f.root, TOOLS, null), true);
	const text = readFileSync(f.path, "utf8"), data = JSON.parse(text);
	const unkeyed = configFingerprint(CONFIG, f.root);
	assert.equal(text.includes(unkeyed), false, "cache must not persist an offline verifier for configuration secrets");
	for (const secret of ["fixture-guessable-secret", "fixture-env-secret", "fixture-arg-secret"]) assert.equal(text.includes(secret), false);
	assert.equal(data.version, 3);
	assert.match(data.entries[0].fingerprint, /^[0-9a-f]{64}$/);
	assert.notEqual(data.entries[0].fingerprint, createHmac("sha256", key).update(unkeyed).digest("hex"), "cache and activation identities have different domains");
	assert.deepEqual(new McpSchemaCache().get(CONFIG, f.root).tools, cache.get(CONFIG, f.root).tools);
});

test("a different machine key cannot reuse an existing schema cache", t => {
	const f = fixture(t); writeFileSync(f.keyPath, Buffer.alloc(32, 1));
	const cache = new McpSchemaCache(); assert.equal(cache.put(CONFIG, f.root, TOOLS, null), true);
	const before = JSON.parse(readFileSync(f.path, "utf8")).entries[0].fingerprint;
	writeFileSync(f.keyPath, Buffer.alloc(32, 2));
	const rekeyed = new McpSchemaCache();
	assert.equal(rekeyed.get(CONFIG, f.root), null);
	assert.equal(rekeyed.put(CONFIG, f.root, TOOLS, null), true);
	assert.notEqual(rekeyed.get(CONFIG, f.root).fingerprint, before);
	assert.ok(new McpSchemaCache().get(CONFIG, f.root));
});

test("prepared schema cache is consumed without rereading and is bound to its file path", t => {
	const f = fixture(t), cache = new McpSchemaCache();
	assert.equal(cache.put(CONFIG, f.root, TOOLS, null), true);
	const snapshot = prepareSchemaCache();
	unlinkSync(f.path);
	const prepared = new McpSchemaCache(f.path, snapshot);
	assert.deepEqual(prepared.get(CONFIG, f.root).tools, cache.get(CONFIG, f.root).tools);
	assert.equal(new McpSchemaCache(join(f.root, "other.json"), snapshot).get(CONFIG, f.root), null);
});

for (const route of ["prepare", "construct"]) test(`readable malformed cache envelopes are scrubbed without reuse: ${route}`, t => {
	const f = fixture(t), fingerprint = configFingerprint(CONFIG, f.root);
	mkdirSync(join(f.root, "cache"));
	mkdirSync(f.keyPath);
	const legacy = JSON.stringify({ version: 1, entries: [{ fingerprint }] });
	for (const payload of [
		"", `{"version":1,"entries":[{"fingerprint":"${fingerprint}"`, `${legacy} trailing garbage`,
		"null", "[]", JSON.stringify({ entries: [{ fingerprint }] }),
		JSON.stringify({ version: "2", entries: [{ fingerprint }] }),
		JSON.stringify({ version: 2, fingerprint }),
		JSON.stringify({ version: 2, entries: { fingerprint } }),
		JSON.stringify({ version: 99, entries: [{ fingerprint }] }),
	]) {
		writeFileSync(f.path, payload);
		const cache = route === "prepare" ? new McpSchemaCache(f.path, prepareSchemaCache(f.path)) : new McpSchemaCache(f.path);
		assert.equal(cache.get(CONFIG, f.root), null);
		assert.equal(cache.entries.size, 0);
		assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { version: 3, entries: [] }, payload);
	}
});

for (const kind of ["missing", "directory", "symlink", "oversized"]) test(`cache scrubbing preserves file safety boundaries: ${kind}`, t => {
	const f = fixture(t), damaged = `{"version":1,"entries":[{"fingerprint":"${configFingerprint(CONFIG, f.root)}"`;
	mkdirSync(join(f.root, "cache"));
	const target = join(f.root, "symlink-target.json");
	if (kind === "directory") mkdirSync(f.path);
	else if (kind === "symlink") {
		writeFileSync(target, damaged);
		try { symlinkSync(target, f.path, "file"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("OS denies fixture file symlinks"); return; }
			throw error;
		}
	} else if (kind === "oversized") writeFileSync(f.path, damaged.padEnd(2 * 1024 * 1024 + 1, " "));
	const snapshot = prepareSchemaCache(f.path);
	assert.equal(snapshot.data, undefined);
	assert.equal(existsSync(f.keyPath), false);
	if (kind === "missing") assert.equal(existsSync(f.path), false);
	else if (kind === "directory") assert.equal(lstatSync(f.path).isDirectory(), true);
	else if (kind === "symlink") {
		assert.equal(lstatSync(f.path).isSymbolicLink(), true);
		assert.equal(readFileSync(target, "utf8"), damaged);
	} else assert.equal(readFileSync(f.path, "utf8"), damaged.padEnd(2 * 1024 * 1024 + 1, " "));
});

for (const unavailable of ["directory", "invalid-size"]) test(`schema cache never falls back to unkeyed identities with a ${unavailable} key`, t => {
	const f = fixture(t);
	if (unavailable === "directory") mkdirSync(f.keyPath);
	else writeFileSync(f.keyPath, Buffer.alloc(1));
	const cache = new McpSchemaCache();
	assert.equal(cache.put(CONFIG, f.root, TOOLS, null), false);
	assert.equal(cache.get(CONFIG, f.root), null);
	assert.equal(cache.entries.size, 0);
});

for (const usableKey of [true, false]) test(`legacy unkeyed schema caches are scrubbed without reuse, usable key: ${usableKey}`, t => {
	const f = fixture(t);
	if (!usableKey) mkdirSync(f.keyPath);
	mkdirSync(join(f.root, "cache"));
	const unkeyed = configFingerprint(CONFIG, f.root);
	writeFileSync(f.path, JSON.stringify({ version: 1, entries: [{ fingerprint: unkeyed, updatedAt: Date.now(), serverInfo: null, tools: TOOLS }] }));
	const cache = new McpSchemaCache();
	assert.equal(cache.get(CONFIG, f.root), null);
	assert.equal(cache.entries.size, 0);
	const text = readFileSync(f.path, "utf8");
	assert.equal(text.includes(unkeyed), false);
	assert.deepEqual(JSON.parse(text), { version: 3, entries: [] });
	assert.equal(cache.put(CONFIG, f.root, TOOLS, null), usableKey);
});

test("keyed schema cache still isolates workspace and secret-bearing configuration changes", t => {
	const f = fixture(t), cache = new McpSchemaCache();
	assert.equal(cache.put(CONFIG, f.root, TOOLS, null), true);
	for (const changed of [
		{ ...CONFIG, headers: { Authorization: "different" } },
		{ ...CONFIG, env: { TOKEN: "different" } },
		{ ...CONFIG, args: ["different"] },
		{ ...CONFIG, url: "https://different.invalid/mcp" },
	]) assert.equal(cache.get(changed, f.root), null);
	assert.equal(cache.get(CONFIG, join(f.root, "other")), null);
	assert.ok(cache.get({ ...CONFIG, headers: { ...CONFIG.headers }, env: { ...CONFIG.env } }, f.root));
});

test("an unwritable legacy cache is never reused when its cleanup fails", t => {
	const f = fixture(t);
	mkdirSync(join(f.root, "cache"));
	const legacy = JSON.stringify({ version: 1, entries: [{ fingerprint: configFingerprint(CONFIG, f.root), updatedAt: Date.now(), tools: TOOLS }] });
	writeFileSync(f.path, legacy);
	const save = t.mock.method(McpSchemaCache.prototype, "save", () => false);
	const cache = new McpSchemaCache();
	assert.equal(save.mock.callCount(), 1);
	assert.equal(cache.get(CONFIG, f.root), null);
	assert.equal(cache.entries.size, 0);
	assert.equal(readFileSync(f.path, "utf8"), legacy, "a denied write leaves the old file on disk, but unavailable to lookup");
});
