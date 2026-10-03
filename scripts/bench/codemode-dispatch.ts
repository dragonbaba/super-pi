import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { NestedToolDispatch } from "../../packages/agent/src/nested-tool-dispatch.ts";
import type { AgentTool, AgentToolCall } from "../../packages/agent/src/types.ts";
import type { ToolResultMessage } from "../../packages/ai/src/types.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
let calls = 0;
let maxActive = 0;
const references: WeakRef<object>[] = [];

async function invoke(call: AgentToolCall): Promise<ToolResultMessage> {
	calls++;
	await nextTask();
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [], isError: false, timestamp: 0 };
}
async function runCycle(index: number): Promise<void> {
	const tool: AgentTool<any> = { name: "read", label: "read", description: "fixture", parameters: { type: "object" },
		executionPath: { access: "read", cwd: ".", argument: "path" }, execute: async () => ({ content: [], details: {} }) };
	const catalog = [tool];
	const owner = new NestedToolDispatch(`benchmark-${index}`, () => catalog, invoke);
	const pending: Promise<ToolResultMessage>[] = [];
	for (let call = 0; call < 8; call++) {
		const args = { path: "fixture", payload: "x".repeat(4096) };
		references.push(new WeakRef(args));
		pending.push(owner.callTool("read", args));
	}
	await Promise.all(pending);
	await owner.close();
	maxActive = Math.max(maxActive, owner.maxActive);
	assert.equal(owner.completedCalls, 8);
	assert.equal(owner.hasErrors, false);
	assert.deepEqual(owner.getTools(), []);
	references.push(new WeakRef(owner), new WeakRef(tool), new WeakRef(catalog));
}

const inspector = new Session();
inspector.connect();
try {
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	for (let index = 0; index < 100; index++) await runCycle(index);
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
	let sampledBytes = 0;
	const nodes = [profile.head];
	while (nodes.length) {
		const node = nodes.pop()!;
		sampledBytes += node.selfSize;
		for (const child of node.children) nodes.push(child);
	}
	for (let index = 0; index < 5; index++) { await nextTask(); gc(); }
	let retained = 0;
	for (const reference of references) if (reference.deref()) retained++;
	assert.equal(calls, 800);
	assert.equal(maxActive, 4);
	assert.equal(retained, 0, "closed owners, catalogs and arguments must be collectible");
	process.stdout.write(JSON.stringify({ benchmark: "codemode-dispatch", cycles: 100, calls, maxActive,
		trackedReferences: references.length, retainedAfterGc: retained, sampledBytes, sampledBytesPerCall: sampledBytes / calls,
		node: process.version, platform: process.platform, coverage: "nested scheduler and invocation lifecycle; no VM or UI" }) + "\n");
} finally { inspector.disconnect(); }
