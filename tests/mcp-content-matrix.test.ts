import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";
import { serializeMcpStructured } from "../packages/coding-agent/src/core/tool-result-source.ts";
import { boundCodemodeResult } from "../packages/coding-agent/src/core/codemode-result.ts";
import { BoundedJson } from "../packages/codemode/src/bounded-json.ts";

test("no-budget image inside legacy image envelope remains inline", () => {
	const data = Buffer.concat([Buffer.from("\xff\xd8\xff", "latin1"), Buffer.alloc(64 * 1024)]).toString("base64");
	assert.deepEqual(convertMcpResult({ content: [{ type: "image", mimeType: "image/jpeg", data }] }, false), [{ type: "image", mimeType: "image/jpeg", data }]);
});

test("resource link requires actual protocol shape", () => {
	assert.throws(() => convertMcpResult({ content: [{ type: "resource_link", name: "missing uri" }] }), { code: "invalid-typed-content" });
});

test("internal structured toJSON accessor is rejected without execution", () => {
	let calls = 0;
	const value = Object.defineProperty({ safe: 1 }, "toJSON", { get() { calls++; return () => "unsafe"; } });
	assert.throws(() => serializeMcpStructured(value), { code: "invalid-structured-content" });
	for (const recovery of [true, false]) assert.throws(() => convertMcpResult({ content: [{ type: "text", text: '{}' }], structuredContent: value }, recovery), { code: "invalid-structured-content" });
	assert.equal(calls, 0);
});

test("structured prototype-like keys remain data and arrays retain order", () => {
	const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"rows":[3,1,2]}');
	const content = convertMcpResult({ content: [], structuredContent: value });
	assert.equal(({} as any).polluted, undefined);
	assert.deepEqual(content[0].mcpSource.value.rows, [3, 1, 2]);
	assert.equal(content[0].text, JSON.stringify(value, null, 2));
});

test("structured content that only repeats the one JSON text block is delivered once", async () => {
	const value = { status: "ok", result: { objects: ["Cube"] } };
	const text = JSON.stringify(value, null, 2);
	assert.deepEqual(convertMcpResult({ content: [{ type: "text", text }], structuredContent: value }), [{ type: "text", text }]);
	for (const recovery of [true, false]) {
		const nearLimit = { text: "x".repeat(30 * 1024) }, repeated = JSON.stringify(nearLimit);
		assert.equal(convertMcpResult({ content: [{ type: "text", text: repeated }], structuredContent: nearLimit }, recovery).length, 1);
		const original = { text: "before\u007fafter" };
		const normalized = convertMcpResult({ content: [{ type: "text", text: JSON.stringify(original) }], structuredContent: original }, recovery);
		assert.equal(normalized.length, 2, "sanitized text must not replace the intact structured source");
		assert.equal(JSON.parse(normalized[0].text).text, "beforeafter");
		assert.deepEqual(JSON.parse(normalized[1].text), original);
	}
	// Different data keeps both blocks, and Codemode writes a structured value once rather than preview plus source.
	const content = convertMcpResult({ content: [{ type: "text", text: "summary" }], structuredContent: value });
	assert.equal(content.length, 2);
	const bounded = await boundCodemodeResult({ role: "toolResult", toolCallId: "c", toolName: "mcp", timestamp: 0, isError: false, content } as any, new BoundedJson());
	const delivered = (bounded.content[0] as { text: string }).text;
	assert.equal(delivered.split('"objects"').length - 1, 1, delivered);
	assert.match(delivered, /^summary\n/);
});

for (const value of [ { invalid: NaN }, { invalid: undefined }, { invalid: 1n }, { invalid: () => 1 }, { invalid: Symbol("fixture") }, new Date(0)]) {
	test(`structured non-JSON value fails closed: ${typeof (value as any).invalid}`, () => {
		assert.throws(() => serializeMcpStructured(value), { code: "invalid-structured-content" });
		let text = "{}";
		try { text = JSON.stringify(value); } catch { /* BigInt is not serializable. */ }
		for (const recovery of [true, false]) assert.throws(() => convertMcpResult({ content: [{ type: "text", text }], structuredContent: value }, recovery), { code: "invalid-structured-content" });
	});
}

test("deduplication never serializes a large structured source to compare with small text", t => {
	const value = { text: "x".repeat(1024 * 1024) }, stringify = JSON.stringify;
	let fullSerializations = 0;
	t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
		if (args[0] === value) fullSerializations++;
		return stringify(...args);
	});
	const content = convertMcpResult({ content: [{ type: "text", text: "{}" }], structuredContent: value });
	assert.equal(content.length, 2);
	assert.equal(content[1].mcpSource.value, value);
	assert.equal(content[1].mcpSource.requiresRecovery, true);
	assert.equal(fullSerializations, 0);
});

test("many tiny structured fields cannot bypass the source ceiling", () => {
	const value: Record<string, string> = {};
	for (let index = 0; index < 150_000; index++) value[`field-${index}`] = "x".repeat(70);
	assert.throws(() => convertMcpResult({ content: [], structuredContent: value }), { code: "result-size-limit" });
});

for (const [mimeType, header] of [["image/gif", "GIF89a012345"], ["image/webp", "RIFF0000WEBP012345"]]) {
	test(`supported ${mimeType} stays typed`, () => {
		const data = Buffer.from(header!).toString("base64");
		assert.deepEqual(convertMcpResult({ content: [{ type: "image", mimeType, data }] }), [{ type: "image", mimeType, data }]);
	});
}
