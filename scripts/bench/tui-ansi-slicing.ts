import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CombinedAutocompleteProvider } from "../../packages/tui/src/autocomplete.ts";
import { highlightTerminalColumns, sliceWithWidthInto } from "../../packages/tui/src/utils.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

const fixtures = [
	"\x1b[31mA\x1b[0mBC",
	"\x1b[31me\u0301\x1b[0mBC",
	"\x1b]8;;https://example.com\x07A\x1b]8;;\x07BC",
	"\x1b[31mA\x1b[0m中😀",
];
const scratch = { text: "", width: 0 };
const commands = [{ name: "help" }, { name: "settings" }, { name: "model" }];
const provider = new CombinedAutocompleteProvider(commands, process.cwd());
const options = { signal: new AbortController().signal };
const commandLines = ["/he"];
const batches = readIntegerOption("--batches", 100);
const iterations = readIntegerOption("--iterations", 1000);
let checksum = 0;

function sliceBatch(): void {
	for (let index = 0; index < iterations; index++) {
		const line = fixtures[index % fixtures.length]!;
		sliceWithWidthInto(line, 1, 2, true, scratch);
		checksum += scratch.text.charCodeAt(scratch.text.length - 1) + scratch.width;
		const highlighted = highlightTerminalColumns(line, 1, 2, 3);
		checksum += highlighted.charCodeAt(highlighted.length - 1);
	}
}

async function completionBatch(): Promise<void> {
	for (let index = 0; index < iterations; index++) {
		// Existing successful path gives a like-for-like baseline; indented behavior
		// is checked by regression tests, since the old implementation returns null.
		const result = await provider.getSuggestions(commandLines, 0, 3, options);
		assert.ok(result);
		checksum += result.items.length + result.prefix.length;
	}
}

function ascending(left: number, right: number): number { return left - right; }

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number };
	selfSize: number;
	children: SamplingNode[];
}

async function measure(name: string): Promise<unknown> {
	for (let batch = 0; batch < 20; batch++) {
		if (name === "slice-and-selection") sliceBatch();
		else await completionBatch();
	}
	assert.ok(globalThis.gc, "run with --expose-gc");
	globalThis.gc();
	const beforeHeap = process.memoryUsage().heapUsed;
	const profiler = new Session();
	profiler.connect();
	const durations: number[] = [];
	let profile: SamplingNode;
	try {
		await profiler.post("HeapProfiler.startSampling", {
			samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
		});
		for (let batch = 0; batch < batches; batch++) {
			const start = performance.now();
			if (name === "slice-and-selection") sliceBatch();
			else await completionBatch();
			durations.push(performance.now() - start);
		}
		profile = (await profiler.post("HeapProfiler.stopSampling")).profile.head as SamplingNode;
	} finally {
		profiler.disconnect();
		scratch.text = "";
		scratch.width = 0;
	}
	const pending = [profile];
	const sites: { function: string; bytes: number; url: string; line: number }[] = [];
	let sampledBytes = 0;
	while (pending.length) {
		const node = pending.pop()!;
		sampledBytes += node.selfSize;
		if (node.selfSize) sites.push({ function: node.callFrame.functionName, bytes: node.selfSize, url: node.callFrame.url, line: node.callFrame.lineNumber + 1 });
		for (const child of node.children) pending.push(child);
	}
	const gcHeaps: number[] = [];
	for (let cycle = 0; cycle < 5; cycle++) {
		await nextTurn();
		globalThis.gc();
		gcHeaps.push(process.memoryUsage().heapUsed);
	}
	durations.sort(ascending);
	sites.sort((left, right) => right.bytes - left.bytes);
	assert.deepEqual(scratch, { text: "", width: 0 });
	return {
		name, iterations: batches * iterations,
		cpuP50MsPerBatch: durations[Math.floor(batches * 0.5)],
		cpuP95MsPerBatch: durations[Math.floor(batches * 0.95)],
		sampledBytes, sampledBytesPerIteration: sampledBytes / (batches * iterations),
		beforeHeap, gcHeaps, scratchCodeUnitsAfterRelease: scratch.text.length,
		topAllocationSites: sites.slice(0, 12),
	};
}

const rows = [await measure("slice-and-selection"), await measure("slash-completion")];
const sourceHashes: Record<string, string> = {};
for (const path of ["packages/tui/src/utils.ts", "packages/tui/src/autocomplete.ts"]) {
	sourceHashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
}
process.stdout.write(`${JSON.stringify({ head: currentCommit(), node: process.version, platform: process.platform, sourceHashes, batches, iterations, rows, checksum }, null, 2)}\n`);
