import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";
import { serializeMcpStructured } from "../packages/coding-agent/src/core/tool-result-source.ts";

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
	assert.equal(calls, 0);
});

test("structured prototype-like keys remain data and arrays retain order", () => {
	const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"rows":[3,1,2]}');
	const content = convertMcpResult({ content: [], structuredContent: value });
	assert.equal(({} as any).polluted, undefined);
	assert.deepEqual(content[0].mcpSource.value.rows, [3, 1, 2]);
	assert.equal(content[0].text, JSON.stringify(value, null, 2));
});

for (const value of [ { invalid: NaN }, { invalid: 1n }, { invalid: () => 1 }, { invalid: Symbol("fixture") }, new Date(0)]) {
	test(`structured non-JSON value fails closed: ${typeof (value as any).invalid}`, () => {
		assert.throws(() => serializeMcpStructured(value), { code: "invalid-structured-content" });
	});
}

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
