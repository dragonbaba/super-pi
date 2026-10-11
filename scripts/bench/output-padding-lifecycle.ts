import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { Box, Text, releaseComponentRenderCaches, type TUI } from "@super-pi/tui";
import { BashExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { ReadToolGroupComponent, ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

// Isolate command rendering from terminal I/O; tool event/frame profiling has its own fixture.
assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
initTheme("dark");
const ui = { requestRender() {} } as TUI;
const updates = 2000;
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
const command = new BashExecutionComponent("fixture", ui, false, 0);
command.setComplete(0, false); // Profile rendering without animation scheduling noise.
for (let i = 0; i < 100; i++) { command.appendOutput("line\n"); command.render(100); }
globalThis.gc!();
await inspector.post("HeapProfiler.startSampling", { samplingInterval: 4096,
	includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let i = 0; i < updates; i++) { command.appendOutput("line\n"); command.render(100); }
const profile = await inspector.post("HeapProfiler.stopSampling");
await inspector.post("HeapProfiler.disable");
inspector.disconnect();
releaseComponentRenderCaches(command);
type Sample = { selfSize: number; callFrame: { functionName: string; url: string }; children: Sample[] };
let sampledBytes = 0;
const sites: Array<{ name: string; url: string; bytes: number }> = [];
function visit(node: Sample): void {
	sampledBytes += node.selfSize;
	if (node.selfSize) sites.push({ name: node.callFrame.functionName, url: node.callFrame.url, bytes: node.selfSize });
	for (const child of node.children) visit(child);
}
visit(profile.profile.head as Sample);

let releasedLoaderOwners = 0;
let noOpCacheHits = 0;
function lifecycle(index: number): WeakRef<object>[] {
	const command = new BashExecutionComponent("fixture", ui, index % 2 === 0, 0);
	const tool = new ToolExecutionComponent("edit", "fixture", {}, { outputPad: 0 }, undefined, ui, process.cwd());
	tool.updateResult({ content: [{ type: "text", text: "error" }], isError: true });
	const group = new ReadToolGroupComponent(false, 60, undefined, 0);
	group.updateArgs("read", { path: "fixture" });
	group.updateResult("read", { content: [{ type: "text", text: "result" }] });
	const text = new Text("cached text", 0, 0), box = new Box(0, 0);
	box.addChild(new Text("cached box", 0, 0));
	const refs: WeakRef<object>[] = [];
	for (const component of [text, box]) {
		const cache = component.render(20);
		refs.push(new WeakRef(cache));
		component.setPaddingX(0); assert.equal(component.render(20), cache); noOpCacheHits++;
		component.setPaddingX(1); component.render(20);
	}
	for (const row of [command, tool, group]) {
		row.setExpanded(index % 2 === 0);
		row.render(60); row.setOutputPad(1); row.render(60); row.setOutputPad(0);
		refs.push(new WeakRef(row));
	}
	command.appendOutput("result\n".repeat(25));
	// Completion, failure, cancellation and direct disposal all release the loader.
	if (index % 4 !== 3) command.setComplete(index % 4 === 1 ? 1 : 0, index % 4 === 2);
	const state = command as unknown as { loader: { intervalId: unknown; ui: unknown }; previewComponent: unknown; contentContainer: { children: unknown[] } };
	for (const row of [command, tool, group, text, box]) releaseComponentRenderCaches(row);
	assert.equal(state.loader.intervalId, null); assert.equal(state.loader.ui, null);
	assert.equal(state.previewComponent, undefined); assert.equal(state.contentContainer.children.length, 0);
	releasedLoaderOwners++;
	return refs;
}
async function collect(): Promise<void> {
	for (let i = 0; i < 3; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
}
for (let i = 0; i < 5; i++) lifecycle(i);
await collect();
const beforeHeapBytes = process.memoryUsage().heapUsed;
releasedLoaderOwners = 0; noOpCacheHits = 0;
const references: WeakRef<object>[] = [];
for (let i = 0; i < 20; i++) references.push(...lifecycle(i));
await collect();
const afterHeapBytes = process.memoryUsage().heapUsed;
const liveReferences = references.filter(ref => ref.deref() !== undefined).length;
assert.equal(liveReferences, 0);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
	commandProfile: { updates, sampledBytesPerUpdate: sampledBytes / updates,
		topSites: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 10) },
	lifecycle: { measuredCycles: 20, releasedLoaderOwners, noOpCacheHits, weakReferences: references.length,
		liveReferences, beforeHeapBytes, afterHeapBytes, heapDeltaBytes: afterHeapBytes - beforeHeapBytes },
	paddingState: "primitive number per owner; no new event closures, promises, controllers, wrappers or arrays",
}, null, 2));
