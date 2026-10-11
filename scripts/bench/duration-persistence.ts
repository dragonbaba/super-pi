import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { currentCommit } from "./benchmark.ts";

function message(): AssistantMessage {
	return { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

async function sample() {
	const updates = 100_000, stream = new AssistantMessageEventStream(), result = message();
	const delta = { type: "text_delta" as const, contentIndex: 0, delta: "x", partial: result };
	const originalNow = performance.now.bind(performance);
	let clockReads = 0;
	Object.defineProperty(performance, "now", { configurable: true, value: () => { clockReads++; return originalNow(); } });
	const inspector = new Session(); inspector.connect();
	let profile;
	try {
		await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
		for (let index = 0; index < updates; index++) stream.push(delta);
		profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
	} finally { inspector.disconnect(); Object.defineProperty(performance, "now", { configurable: true, value: originalNow }); }
	const terminal = { type: "done" as const, reason: "stop" as const, message: result };
	stream.push(terminal);
	const final = await stream.result();
	let delivered = 0, completionEventCopies = 0;
	for await (const event of stream) {
		delivered++;
		if (event.type === "done") completionEventCopies += Number(event !== terminal);
		else assert.equal(event, delta, "delta identity must be preserved");
	}
	assert.equal(delivered, updates + 1); assert.equal(clockReads, 0);
	const state = stream as unknown as { queue: { length: number }; waiting: { length: number } };
	assert.equal(state.queue.length, 0); assert.equal(state.waiting.length, 0);
	const sites: Array<{ functionName: string; bytes: number }> = [];
	let sampledBytes = 0;
	function visit(node: NonNullable<typeof profile>["head"]): void {
		sampledBytes += node.selfSize;
		if (node.selfSize) sites.push({ functionName: node.callFrame.functionName, bytes: node.selfSize });
		for (const child of node.children ?? []) visit(child);
	}
	visit(profile!.head); sites.sort((a, b) => b.bytes - a.bytes);
	return { updates, delivered, clockReadsOnDeltas: clockReads, sampledBytes, bytesPerDelta: sampledBytes / updates,
		completionMessageCopies: Number(final !== result), completionEventCopies,
		queueAfterDrain: state.queue.length, waitersAfterDrain: state.waiting.length,
		topAllocationSites: sites.slice(0, 8), stream: new WeakRef(stream), message: new WeakRef(result), final: new WeakRef(final) };
}

async function closedReferences() {
	const refs: WeakRef<object>[] = [];
	for (const finish of ["done", "error", "aborted", "end", "end-empty", "abandoned"] as const) {
		const stream = new AssistantMessageEventStream(), result = message();
		refs.push(new WeakRef(stream), new WeakRef(result));
		if (finish === "abandoned") continue;
		if (finish === "end-empty") { stream.end(); continue; }
		if (finish === "end") stream.end(result);
		else if (finish === "done") stream.push({ type: "done", reason: "stop", message: result });
		else { result.stopReason = finish; stream.push({ type: "error", reason: finish, error: result }); }
		refs.push(new WeakRef(await stream.result()));
		for await (const _event of stream) { /* Drain owned queue references. */ }
	}
	return refs;
}

if (!globalThis.gc) throw new Error("Run with --expose-gc");
const measured = await sample(), refs = await closedReferences();
refs.push(measured.stream, measured.message, measured.final);
for (let cycle = 0; cycle < 4; cycle++) { await nextTask(); globalThis.gc(); }
const retained = refs.filter(ref => ref.deref() !== undefined).length;
assert.equal(retained, 0);
process.stdout.write(JSON.stringify({ benchmark: "duration-persistence", commit: currentCommit(), node: process.version,
	...measured, stream: undefined, message: undefined, final: undefined,
	lifecycle: { references: refs.length, retained, gcTaskBoundaries: 4 } }, null, 2) + "\n");
