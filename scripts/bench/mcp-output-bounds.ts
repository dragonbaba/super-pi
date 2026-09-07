import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTask } from "node:timers/promises";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult } from "../../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { sanitizeText } from "../../packages/mcp-bridge/src/security.js";
// @ts-expect-error JavaScript extension package.
import { McpCall } from "../../packages/mcp-bridge/src/call.js";
import { createToolResultPresentationOwner } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";

const mode = process.argv[2] ?? "timing";
const scenarios = ["small", "structured", "mixed"] as const;
type Scenario = typeof scenarios[number];
function fixture(name: Scenario): any {
	if (name === "small") return { content: [{ type: "text", text: "ordinary MCP text ".repeat(8) }] };
	if (name === "structured") return { content: [], structuredContent: { text: "x".repeat(1024 * 1024), rows: [3, 1, 2] } };
	return { content: [{ type: "text", text: "x".repeat(1024 * 1024) },
		{ type: "image", mimeType: "image/jpeg", data: Buffer.concat([Buffer.from("\xff\xd8\xff", "latin1"), Buffer.alloc(128 * 1024)]).toString("base64") },
		{ type: "resource", resource: { uri: "fixture://resource", mimeType: "application/octet-stream", blob: "YQ==".repeat(1) } }] };
}

// Test-only baseline small-text path from 946442c: sanitize, complete Buffer,
// append wrapper. This reference never enters production and measures only
// normalization, not network/server latency or token projection.
function baselineSmall(raw: any) {
	const content: any[] = [];
	let remaining = 50 * 1024;
	for (const item of raw.content) {
		const clean = sanitizeText(item.text, Number.MAX_SAFE_INTEGER);
		const encoded = Buffer.from(clean, "utf8");
		if (encoded.length > remaining) throw new Error("baseline small fixture exceeded its envelope");
		const used = Math.min(remaining, Buffer.byteLength(clean, "utf8"));
		if (clean) content.push({ type: "text", text: clean });
		remaining -= used;
	}
	return content;
}

function percentile(samples: number[], fraction: number) { samples.sort((a, b) => a - b); return samples[Math.floor((samples.length - 1) * fraction)]!; }
function run(raw: any, name: Scenario) {
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "benchmark-session")!;
	const call = name === "mixed" ? new McpCall(undefined, () => {}) : undefined;
	try {
		if (call) for (let progress = 0; progress < 100; progress++) call.notify({ progress });
		const content = convertMcpResult(raw);
		const presentation = owner.create(content, "benchmark-call");
		const model = presentation?.modelContent ?? content;
		const tokens = estimateToolOutputTokens(model).estimatedTokens;
		assert.ok(tokens <= 1024);
		if (presentation?.version === 2 && presentation.artifact) {
			const recovered = owner.readArtifact(presentation.artifact.id, [{ role: "toolResult", toolCallId: "benchmark-call", content }]);
			assert.equal(recovered.content, content);
		}
		return { tokens, artifacts: owner.counters.artifactDescriptorsCreated, continuations: owner.counters.continuationCursorStringsCreated,
			progress: call?.deliveries ?? 0, sourceEntries: owner.counters.projectionRecordEntries };
	} finally { call?.finish(); owner.dispose(); }
}

if (mode === "timing") {
	const rows = [];
	for (const name of scenarios) {
		const raw = fixture(name);
		const rawBytes = Buffer.byteLength(JSON.stringify(raw)); // fixture setup only
		for (let index = 0; index < 10; index++) run(raw, name);
		const iterations = name === "small" ? 5000 : 30;
		const samples: number[] = [];
		const normalization: number[] = [];
		const baseline: number[] = [];
		let counts;
		for (let index = 0; index < iterations; index++) {
			if (name === "small") { const start = performance.now(); baselineSmall(raw); baseline.push(performance.now() - start); }
			const start = performance.now(); convertMcpResult(raw); normalization.push(performance.now() - start);
			const fullStart = performance.now(); counts = run(raw, name); samples.push(performance.now() - fullStart);
		}
		const p50 = percentile(normalization, .5), p95 = percentile(normalization, .95);
		const before50 = baseline.length ? percentile(baseline, .5) : undefined;
		const before95 = baseline.length ? percentile(baseline, .95) : undefined;
		rows.push({ name, rawBytes, normalizationP50Ms: p50, normalizationP95Ms: p95,
			baselineP50Ms: before50, baselineP95Ms: before95, deltaP50Ms: before50 === undefined ? undefined : p50 - before50,
			deltaP95Ms: before95 === undefined ? undefined : p95 - before95,
			projectionRecoveryP50Ms: percentile(samples, .5), projectionRecoveryP95Ms: percentile(samples, .95), counts });
	}
	console.log(JSON.stringify({ mode, node: process.version, platform: process.platform, rows }));
} else if (mode === "allocation") {
	const raw = fixture("mixed");
	const inspector = new Session(); inspector.connect();
	const initialHeap = process.memoryUsage().heapUsed;
	let peakHeap = initialHeap;
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
	for (let index = 0; index < 12; index++) { run(raw, "mixed"); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }
	const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
	const sites = new Map<string, number>();
	function visit(node: typeof profile.head) {
		const label = `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
		sites.set(label, (sites.get(label) ?? 0) + node.selfSize);
		for (const child of node.children ?? []) visit(child);
	}
	visit(profile.head);
	console.log(JSON.stringify({ mode, initialHeap, peakHeap, finalHeap: process.memoryUsage().heapUsed, sites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 15) }));
} else if (mode === "gc") {
	assert.ok(global.gc, "requires --expose-gc");
	const refs: WeakRef<object>[] = [];
	const initialHeap = process.memoryUsage().heapUsed;
	let peakHeap = initialHeap;
	function lifecycle() {
		const raw = fixture("mixed");
		const content = convertMcpResult(raw);
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "gc-session")!;
		owner.create(content, "gc-call");
		refs.push(new WeakRef(raw), new WeakRef(raw.content), new WeakRef(content), new WeakRef(owner));
		for (const block of content) { refs.push(new WeakRef(block)); if (block.mcpSource) refs.push(new WeakRef(block.mcpSource), new WeakRef(block.mcpSource.value)); }
		peakHeap = process.memoryUsage().heapUsed;
		owner.clearProjectionRecords(); owner.dispose();
		assert.equal(owner.counters.projectionRecordEntries, 0);
	}
	lifecycle();
	for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
	const retained = refs.reduce((count, reference) => count + Number(reference.deref() !== undefined), 0);
	console.log(JSON.stringify({ mode, initialHeap, peakHeap, finalHeap: process.memoryUsage().heapUsed, weakRefs: refs.length, retained }));
	assert.equal(retained, 0);
} else throw new Error("unknown benchmark mode");
