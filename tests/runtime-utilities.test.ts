import assert from "node:assert/strict";
import test from "node:test";
import type { Tool, ToolCall } from "../packages/ai/src/types.ts";
import {
	headersToRecord,
	mergeProviderHeaders,
	providerHeadersToRecord,
} from "../packages/ai/src/utils/headers.ts";
import { validateToolArguments } from "../packages/ai/src/utils/validation.ts";
import { ObjectPool } from "../packages/coding-agent/src/utils/object-pool.ts";
import {
	AuthStorage,
	InMemoryAuthStorageBackend,
} from "../packages/coding-agent/src/core/auth-storage.ts";
import { renderHighlightedHtml } from "../packages/coding-agent/src/utils/syntax-highlight.ts";

function defineProtoProperty<T extends object, TValue>(record: T, value: TValue): T & { __proto__: TValue } {
	Object.defineProperty(record, "__proto__", {
		configurable: true,
		enumerable: true,
		writable: true,
		value,
	});
	return record as T & { __proto__: TValue };
}

test("provider header merging is case-insensitive and last override casing wins", () => {
	const base = { "X-Test": "base", "X-Delete": "base", Keep: "yes" };
	const override = { "x-test": "first", "X-TEST": "final", "x-delete": null };
	const merged = mergeProviderHeaders(base, override);

	assert.deepEqual(merged, { Keep: "yes", "X-TEST": "final", "x-delete": null });
	assert.deepEqual(base, { "X-Test": "base", "X-Delete": "base", Keep: "yes" });
	assert.deepEqual(override, { "x-test": "first", "X-TEST": "final", "x-delete": null });
});

test("header conversion preserves __proto__ as data without changing prototypes", () => {
	const providerHeaders = defineProtoProperty({ Normal: "value" }, "provider-safe");
	const converted = providerHeadersToRecord(providerHeaders);
	assert.equal(Object.getPrototypeOf(converted), Object.prototype);
	assert.equal(Object.hasOwn(converted!, "__proto__"), true);
	assert.equal(converted!.__proto__, "provider-safe");

	const merged = mergeProviderHeaders(undefined, providerHeaders);
	assert.equal(Object.getPrototypeOf(merged), Object.prototype);
	assert.equal(Object.hasOwn(merged!, "__proto__"), true);
	assert.equal(merged!.__proto__, "provider-safe");

	const fromHeaders = headersToRecord(new Headers([["__proto__", "headers-safe"]]));
	assert.equal(Object.getPrototypeOf(fromHeaders), Object.prototype);
	assert.equal(Object.hasOwn(fromHeaders, "__proto__"), true);
	assert.equal(fromHeaders.__proto__, "headers-safe");
});

test("optional null repair preserves an own __proto__ sibling as inert data", () => {
	const parameters = {
		type: "object",
		properties: {
			name: { type: "string" },
			note: { type: "string" },
		},
		required: ["name"],
		additionalProperties: true,
	} as unknown as Tool["parameters"];
	const tool: Tool = { name: "sample", description: "sample", parameters };
	const argumentsWithProto = defineProtoProperty({ name: "ok", note: null }, "argument-safe");
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call-1",
		name: "sample",
		arguments: argumentsWithProto,
	};

	const repaired = validateToolArguments(tool, toolCall) as Record<string, unknown>;
	assert.equal(Object.getPrototypeOf(repaired), Object.prototype);
	assert.equal(Object.hasOwn(repaired, "note"), false);
	assert.equal(Object.hasOwn(repaired, "__proto__"), true);
	assert.equal(repaired.__proto__, "argument-safe");
});

test("highlight rendering handles nested scopes, entities, and malformed tags", () => {
	const theme = {
		keyword: (text: string) => `<K>${text}</K>`,
		string: (text: string) => `<S>${text}</S>`,
	};
	assert.equal(
		renderHighlightedHtml(
			'<span class="hljs-keyword">const <span class="hljs-string">&quot;x&quot;</span></span> &amp;',
			theme,
		),
		"<K>const </K><S>\"x\"</S> &",
	);
	assert.equal(renderHighlightedHtml('<span class="hljs-keyword"'), '<span class="hljs-keyword"');
	assert.equal(renderHighlightedHtml("plain &unknown; text"), "plain &unknown; text");
});

test("object pool resets released values and rejects oversized retention", () => {
	let creations = 0;
	const pool = new ObjectPool(
		() => {
			creations++;
			return [] as number[];
		},
		(value) => {
			value.length = 0;
		},
		1,
		(value) => value.length <= 4,
	);
	const small = pool.acquire();
	small.push(1, 2);
	pool.release(small);
	assert.equal(pool.acquire(), small);
	pool.release(small);

	const large = pool.acquire();
	large.push(1, 2, 3, 4, 5);
	pool.release(large);
	assert.notEqual(pool.acquire(), large);
	assert.equal(creations, 2);
});

test("auth storage treats __proto__ provider ids as own data", async () => {
	const backend = new InMemoryAuthStorageBackend();
	const data = defineProtoProperty({}, { type: "api_key", key: "secret" });
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(data) }));
	const storage = AuthStorage.fromStorage(backend);

	assert.deepEqual(await storage.read("__proto__"), { type: "api_key", key: "secret" });
	await storage.delete("unrelated");
	assert.deepEqual(await storage.read("__proto__"), { type: "api_key", key: "secret" });
	assert.deepEqual(await storage.list(), [{ providerId: "__proto__", type: "api_key" }]);
});

test("auth storage rejects non-object JSON roots without replacing its last valid snapshot", async () => {
	const backend = new InMemoryAuthStorageBackend();
	const storage = AuthStorage.fromStorage(backend);
	await storage.modify("valid", async () => ({ type: "api_key", key: "ok" }));
	backend.withLock(() => ({ result: undefined, next: "null" }));

	assert.deepEqual(await storage.read("valid"), { type: "api_key", key: "ok" });
});
