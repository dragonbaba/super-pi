import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { encodedJsonPayload } from "../packages/codemode/src/bounded-json.ts";
import { CodemodeOutputs } from "../packages/coding-agent/src/core/codemode-output.ts";
import { OutputAccumulator } from "../packages/coding-agent/src/core/tools/output-accumulator.ts";
import { attachCapturedOutput, capturedOutput, readCapturedOutput } from "../packages/coding-agent/src/core/tools/captured-output.ts";
import { createMcpTypedSource } from "../packages/coding-agent/src/core/tool-result-source.ts";

function result(content: any[], complete: boolean | "unknown" = true): any {
	return { role: "toolResult", toolCallId: "producer", toolName: "bash", content, isError: false, timestamp: 1,
		details: { shellExecution: { version: 1, producer: "local-shell", started: true, cwd: null, executionStatus: "exited", sideEffects: "unknown", retryGuidance: "inspect_before_retry", exitCode: 0, signal: null, termination: "exit", output: { complete, tailTruncated: false, log: "not_needed", cleanup: "not_needed" } } } };
}
// Public bridge envelopes are tested through the production host in codemode-session.test.ts.
async function read(owner: CodemodeOutputs, ref: string, options?: unknown): Promise<any> {
	return JSON.parse(encodedJsonPayload(await owner.read(ref, options))!);
}

test("data reads use the complete capture rather than decorated display, and detect tampering", async () => {
	const owner = new CodemodeOutputs(), output = new OutputAccumulator({ captureData: true });
	const json = JSON.stringify({ status: "completed", results: Array.from({ length: 344 }, (_, index) => ({ id: index, status: index < 4 ? "Failed" : "Passed", text: "x".repeat(240) })) });
	output.append(Buffer.from(json)); output.finish(); await output.closeTempFile();
	try {
		const source = output.capture(); assert.equal(source.kind, "file");
		const content = attachCapturedOutput([{ type: "text", text: "tail [Showing lines / Full output]" }], source);
		const captured = await owner.capture(result(content), "test");
		assert.equal(captured.outputs[0].complete, true);
		const page = await read(owner, captured.outputs[0].ref, { format: "json", path: ["results"], offset: 2, limit: 4 });
		assert.deepEqual(page.data.map((item: any) => item.id), [2, 3, 4, 5]); assert.equal(page.nextOffset, 6);
		if (source.kind !== "file") return;
		writeFileSync(source.path, json.replace('"completed"', '"corrupted"'));
		await assert.rejects(owner.read(captured.outputs[0].ref, { format: "json" }), /OUTPUT_CHANGED/);
	} finally { owner.clear(); await output.discardTempFile(); }
});

test("MCP structured data remains separate from mixed display text, with bounded large-field selection", async t => {
	const owner = new CodemodeOutputs();
	const source = createMcpTypedSource("structured", { meta: { ok: true }, rows: Array.from({ length: 10000 }, (_, id) => ({ id, text: "中😀".repeat(30) })) });
	const captured = await owner.capture(result([{ type: "text", text: "not JSON" }, { type: "text", text: "preview", mcpSource: source }]), "mcp");
	const record = (owner as any).records.get(captured.outputs[0].ref);
	t.after(async () => {
		const { unlink } = await import("node:fs/promises");
		await unlink(record.source.path); await unlink(record.source.path + ".sp-owned"); owner.clear();
	});
	assert.equal(captured.outputs[0].format, "json");
	assert.deepEqual((await read(owner, captured.outputs[0].ref, { path: ["meta"] })).data, { ok: true });
	await assert.rejects(owner.read(captured.outputs[0].ref, {}), /OUTPUT_SELECTION_TOO_LARGE/);
	const page = await read(owner, captured.outputs[0].ref, { path: ["rows"], offset: 9999, limit: 2 });
	assert.equal(page.data[0].id, 9999); assert.equal(page.nextOffset, null);
	assert.ok((owner as any).chars <= 1024 * 1024); assert.equal((owner as any).chars, 0);
	owner.clear(); await assert.rejects(owner.read(captured.outputs[0].ref, {}), /OUTPUT_EXPIRED/);
});

test("unknown/incomplete output, invalid JSON, missing fields and malformed selection never trigger producers", async () => {
	const owner = new CodemodeOutputs();
	const unknown = await owner.capture(result(attachCapturedOutput([{ type: "text", text: "{}" }], { kind: "text", text: "{}" }), "unknown"), "unknown");
	await assert.rejects(owner.read(unknown.outputs[0].ref, { format: "json" }), /OUTPUT_INCOMPLETE/);
	const invalid = await owner.capture(result(attachCapturedOutput([{ type: "text", text: "display" }], { kind: "text", text: "warning\n{}" })), "invalid");
	await assert.rejects(owner.read(invalid.outputs[0].ref, { format: "json" }), /OUTPUT_INVALID_JSON/);
	const valid = await owner.capture(result(attachCapturedOutput([{ type: "text", text: "display" }], { kind: "text", text: '{"a":[1,2]}' })), "valid");
	const ref = valid.outputs[0].ref;
	await assert.rejects(owner.read(ref, { format: "json", path: ["toString"] }), /OUTPUT_PATH_MISSING/);
	for (const options of [null, [], { offset: -1 }, { path: [null] }, { format: "xml" }]) await assert.rejects(owner.read(ref, options));
	assert.deepEqual((await read(owner, ref, { format: "json", path: ["a"] })).data, [1, 2]);
	await assert.rejects(owner.read("foreign-output", {}), /OUTPUT_EXPIRED/); owner.clear();
});

test("capture marker expires when hooks redact/replace native presentation", () => {
	const source = { kind: "text" as const, text: "secret original" };
	const content = attachCapturedOutput([{ type: "text", text: "display" }], source);
	assert.equal(capturedOutput(content), source);
	content[0].text = "redacted"; assert.equal(capturedOutput(content), undefined);
	const replacement = attachCapturedOutput([{ type: "text", text: "display" }], source);
	replacement[0] = { type: "text", text: "display" }; assert.equal(capturedOutput(replacement), undefined);
});

test("capped output never masquerades as complete JSON; abort closes readers", async () => {
	const output = new OutputAccumulator({ maxBytes: 1, maxSpillBytes: 1024, captureData: true });
	output.append(Buffer.from("x".repeat(2000))); output.finish(); await output.closeTempFile();
	try { await assert.rejects(readCapturedOutput(output.capture()), /OUTPUT_INCOMPLETE/); }
	finally { await output.discardTempFile(); }
	await assert.rejects(readCapturedOutput({ kind: "text", text: "data" }, AbortSignal.abort()), /abort/i);
});

test("output owners evict bounded inline data and release every reference at clear/close", async () => {
	const owner = new CodemodeOutputs();
	let first = "";
	for (let index = 0; index < 300; index++) {
		const captured = await owner.capture(result(attachCapturedOutput([{ type: "text", text: "display" }], { kind: "text", text: "x".repeat(8000) })), String(index));
		if (!index) first = captured.outputs[0].ref;
	}
	assert.ok((owner as any).chars <= 1024 * 1024); assert.ok((owner as any).records.size <= 256);
	await assert.rejects(owner.read(first, {}), /OUTPUT_EXPIRED/);
	owner.clear(); assert.equal((owner as any).records.size, 0); assert.equal((owner as any).chars, 0);
	owner.close(); await assert.rejects(owner.capture(result([]), "late"), /OUTPUT_EXPIRED/);
	assert.equal((owner as any).reading, undefined);
});

test("branch invalidation rejects in-flight and queued data reads and releases the read owner", async () => {
	const owner = new CodemodeOutputs(), output = new OutputAccumulator({ captureData: true });
	output.append(Buffer.from(JSON.stringify({ rows: "x".repeat(90000) }))); output.finish(); await output.closeTempFile();
	try {
		const captured = await owner.capture(result(attachCapturedOutput([{ type: "text", text: "display" }], output.capture())), "generation");
		const ref = captured.outputs[0].ref;
		const first = owner.read(ref, { format: "json" }), queued = owner.read(ref, { format: "json" });
		owner.clear();
		const settled = await Promise.allSettled([first, queued]);
		for (const item of settled) { assert.equal(item.status, "rejected"); if (item.status === "rejected") assert.match(String(item.reason), /OUTPUT_EXPIRED/); }
		assert.equal((owner as any).reading, undefined); assert.equal((owner as any).records.size, 0);
	} finally { owner.close(); await output.discardTempFile(); }
});
