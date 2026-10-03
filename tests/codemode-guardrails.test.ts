import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import<any>("../packages/extensions/tool-loop-guardrails/index.ts");

function fixture() {
	const hooks = new Map<string, (...args: any[]) => any>();
	guard({ on: (name: string, hook: any) => hooks.set(name, hook), registerTool() {}, sendMessage() {} });
	const ctx = { cwd: process.cwd() };
	const input = { fixture: "same" };
	return { hooks, async call(id: string, parent?: string) {
		return hooks.get("tool_call")!({ toolCallId: id, toolName: "fixture_operation", parentToolCallId: parent, input }, ctx);
	}, async result(id: string, failed = false, parent?: string) {
		return hooks.get("tool_result")!({ toolCallId: id, toolName: "fixture_operation", parentToolCallId: parent, input, isError: failed,
			content: [{ type: "text", text: failed ? "fixture command failed" : "ok" }], details: {} }, ctx);
	}, end(id: string, parent?: string) {
		return hooks.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: id, toolName: "fixture_operation", parentToolCallId: parent, result: {}, isError: true });
	} };
}

test("nested duplicate admission is in-flight, parent-scoped and released only by its owner", async () => {
	const f = fixture();
	assert.equal(await f.call("first", "p"), undefined);
	assert.match((await f.call("duplicate", "p")).reason, /DUPLICATE_CALL/);
	await f.result("duplicate", true, "p");
	assert.match((await f.call("still-overlapping", "p")).reason, /DUPLICATE_CALL/);
	assert.equal(await f.call("other-parent", "q"), undefined);
	await f.result("other-parent", false, "q");
	await f.result("first", false, "p");
	assert.equal(await f.call("verify", "p"), undefined);
	await f.result("verify", false, "p");
	f.hooks.get("agent_end")!();
	assert.equal(await f.call("new-agent", "p"), undefined);
});

test("a nested child that never reaches tool_result releases its reservation at execution end", async () => {
	const f = fixture();
	// A later hook blocks, aborts or vetoes the admitted child: no tool_result is emitted.
	assert.equal(await f.call("blocked-later", "p"), undefined);
	const overlap = await f.call("overlap", "p");
	assert.match(overlap.reason, /still running/);
	f.end("overlap", "p");
	assert.match((await f.call("still-overlapping", "p")).reason, /DUPLICATE_CALL/);
	f.end("still-overlapping", "p");
	f.end("blocked-later", "p");
	assert.equal(await f.call("retry", "p"), undefined);
	await f.result("retry", false, "p");
	f.end("retry", "p");
	assert.equal(await f.call("verify", "p"), undefined);
	const native = fixture();
	assert.equal(await native.call("first"), undefined); await native.result("first"); native.end("first");
	assert.match((await native.call("duplicate")).reason, /current assistant tool batch/);
});

test("native duplicate batches and repeated nested failure guards remain enforced", async () => {
	const native = fixture();
	assert.equal(await native.call("first"), undefined); await native.result("first");
	assert.match((await native.call("duplicate")).reason, /DUPLICATE_CALL/);
	native.hooks.get("turn_start")!();
	assert.equal(await native.call("new-turn"), undefined);
	const nested = fixture();
	let blocked = false;
	for (let i = 0; i < 8; i++) {
		const admission = await nested.call(`failure-${i}`, "p");
		if (admission?.block) { assert.match(admission.reason, /REPEATED_CALL_BLOCKED/); blocked = true; break; }
		await nested.result(`failure-${i}`, true, "p");
	}
	assert.equal(blocked, true);
});
