import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { alphaSession } from "../../tests/helpers/alpha-session.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";

const UPDATES = 4096;
const WARMUP = 256;
const EXPANDED = process.argv.includes("--expanded");
function sites(node: any, entries: any[]): number {
	let bytes = node.selfSize;
	if (node.selfSize) entries.push({ bytes: node.selfSize, function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1 });
	for (const child of node.children ?? []) bytes += sites(child, entries);
	return bytes;
}
function descending(left: any, right: any): number { return right.bytes - left.bytes; }
function ascending(left: number, right: number): number { return left - right; }
async function sample(grouped: boolean) {
	let f: any = await alphaSession({ g2: false });
	await f.mode.init();
	const parent = "bench-parent", child = `${parent}:nested:1`;
	f.internal.handleEvent({ type: "tool_execution_start", toolName: "codemode", toolCallId: parent, args: { code: "await tools.bash({command:'fixture'})" } });
	f.internal.handleEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: child, parentToolCallId: grouped ? parent : undefined, args: { command: "fixture" } });
	if (EXPANDED) for (const component of f.internal.chatContainer.children) if (component instanceof ToolExecutionComponent) component.setExpanded(true);
	const events: any[] = [];
	for (let index = 0; index < 32; index++) events.push({ type: "tool_execution_update", toolName: "bash", toolCallId: child, parentToolCallId: grouped ? parent : undefined,
		partialResult: { content: [{ type: "text", text: `bounded preview ${index}\n` + "x".repeat(4096) }] } });
	let eventPromises = 0;
	function update(index: number): void {
		if (f.internal.handleEvent(events[index % events.length]) instanceof Promise) eventPromises++;
		f.internal.chatContainer.render(120);
	}
	for (let index = 0; index < WARMUP; index++) update(index);
	global.gc?.();
	const heapStart = process.memoryUsage().heapUsed;
	const inspector = new Session(); inspector.connect();
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const durations: number[] = [];
	let peakHeap = heapStart;
	for (let index = 0; index < UPDATES; index++) {
		const start = performance.now(); update(index); durations.push(performance.now() - start);
		if (index % 128 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const profile = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	const top: any[] = []; const sampledBytes = sites(profile.profile.head, top); top.sort(descending); durations.sort(ascending);
	let cards = f.internal.chatContainer.children.filter((value: unknown) => value instanceof ToolExecutionComponent);
	const cardCount = cards.length;
	let tree = cards[0].codemodeTree;
	const counters = tree.getLifecycleCounts();
	const refs = cards.map((card: object) => new WeakRef(card)); refs.push(new WeakRef(tree));
	const final = { content: [{ type: "text", text: "finished" }] };
	f.internal.handleEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: child, parentToolCallId: grouped ? parent : undefined, result: final, isError: false });
	f.internal.handleEvent({ type: "tool_execution_end", toolName: "codemode", toolCallId: parent, result: final, isError: false });
	const view = stripVTControlCharacters(cards[0].render(120).join("\n")); assert.match(view, /completed/);
	await f.release();
	const released = tree.getLifecycleCounts();
	assert.equal(released.timers, 0); assert.equal(released.rows, 0); assert.equal(released.resultReferences, 0); assert.equal(released.textChars, 0);
	cards = undefined; tree = undefined; f = undefined;
	assert.equal(eventPromises, 0);
	return { refs, metrics: { mode: grouped ? "grouped" : "ungrouped-control", expanded: EXPANDED, updates: UPDATES, warmup: WARMUP, cardCount,
		medianMs: durations[UPDATES / 2], p95Ms: durations[Math.floor(UPDATES * .95)], sampledBytesPerUpdate: sampledBytes / UPDATES,
		heapStart, peakHeap, eventPromises, counters, released, top: top.slice(0, 8) } };
}
async function measure(grouped: boolean) {
	// Audit after the async owner scope returns, so iterator/inspector locals cannot
	// conservatively retain the expanded transcript in an active benchmark frame.
	const sampleResult = await sample(grouped);
	for (let index = 0; index < 5; index++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc?.(); }
	let retained = 0; for (const ref of sampleResult.refs) if (ref.deref()) retained++;
	assert.equal(retained, 0);
	return { ...sampleResult.metrics, heapAfterGc: process.memoryUsage().heapUsed, retainedWeakRefs: retained, weakRefs: sampleResult.refs.length };
}

assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const ungrouped = await measure(false);
const grouped = await measure(true);
assert.equal(grouped.cardCount, 1); assert.equal(grouped.counters.rowCreations, 1); assert.equal(grouped.counters.progressUpdates, UPDATES + WARMUP);
console.log(JSON.stringify({ node: process.version, platform: process.platform, scope: "InteractiveMode event handler -> retained transcript -> real Text/Box render; separate event/frame benchmarks cover observer and terminal queue. Ungrouped control routes the same events without parent ID; it is not a historical checkout.", ungrouped, grouped }, null, 2));
