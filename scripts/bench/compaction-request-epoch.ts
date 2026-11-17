import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { estimateContextTokens } from "../../packages/ai/src/utils/estimate.ts";
import { convertToLlmWithUsageEpoch } from "../../packages/coding-agent/src/core/messages.ts";
import { compactionEpochFixture, epochAssistant } from "../../tests/helpers/compaction-epoch-fixture.ts";

const smoke = process.argv.includes("--smoke"), iterations = smoke ? 4 : 2048;
const outputIndex = process.argv.indexOf("--output"), output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
assert.ok(output, "--output requires an owned destination");
const baselineIndex = process.argv.indexOf("--baseline-estimator");
const converterIndex = process.argv.indexOf("--baseline-converter");
const baseline = baselineIndex >= 0;
const estimator = baseline ? (await import(pathToFileURL(process.argv[baselineIndex + 1]).href)).estimateContextTokens as typeof estimateContextTokens : estimateContextTokens;
const converter = converterIndex >= 0 ? (await import(pathToFileURL(process.argv[converterIndex + 1]).href)).convertToLlm : undefined;
let fixture: Awaited<ReturnType<typeof compactionEpochFixture>> | undefined = await compactionEpochFixture();
const ownerRef = new WeakRef(fixture.session), settingsRef = new WeakRef(fixture.session.settingsManager);
const originalStringify = JSON.stringify;
let serializations = 0, serializedChars = 0, metadataViews = 0, peakHeap = 0;
function countedStringify(value: unknown): string | undefined {
	const valueString = originalStringify(value); serializations++; serializedChars += valueString?.length ?? 0; return valueString;
}
const start = Date.now() + 1000;
for (let index = 0; index < 160; index++) {
	const message = epochAssistant(1000, start + index);
	message.stopReason = "toolUse";
	message.content = [{ type: "toolCall", id: `history-${index}`, name: "codemode", arguments: { code: "x".repeat(4096) } }];
	fixture.sessionManager.appendMessage(message);
	fixture.sessionManager.appendMessage({ role: "toolResult", toolCallId: `history-${index}`, toolName: "codemode", content: [{ type: "text", text: "y".repeat(4096) }], isError: false, timestamp: start + index });
}
fixture.sessionManager.appendMessage(epochAssistant(329509, start + 3600000));
fixture.session.agent.state.messages = fixture.sessionManager.buildSessionContext().messages;
function query(): void {
	const raw = fixture!.session.messages;
	const messages = baseline ? converter(raw) : convertToLlmWithUsageEpoch(raw, fixture!.session.getRequestUsageEpoch(raw));
	assert.equal(estimator({ systemPrompt: fixture!.session.agent.state.systemPrompt, messages }).tokens, 329509);
	for (let index = 0; index < messages.length; index++) if (messages[index].role === "assistant" && messages[index] !== raw[index]) metadataViews++;
}
function tick(resolve: () => void): void { setImmediate(resolve); }
async function gc(): Promise<void> { assert.ok(global.gc); for (let index = 0; index < 8; index++) { await new Promise<void>(tick); global.gc(); } }
for (let index = 0; index < 16; index++) query();
metadataViews = 0; await gc();
const before = process.memoryUsage(), inspector = new Session(); inspector.connect();
type Node = { selfSize: number; callFrame: { functionName: string }; children: Node[] };
try {
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const cpuStart = process.cpuUsage(); peakHeap = before.heapUsed;
	JSON.stringify = countedStringify as typeof JSON.stringify;
	try { for (let index = 0; index < iterations; index++) { query(); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); } }
	finally { JSON.stringify = originalStringify; }
	const cpu = process.cpuUsage(cpuStart), profile = (await inspector.post("HeapProfiler.stopSampling")).profile as { head: Node };
	let sampledBytes = 0; const pending = [profile.head], sites = new Map<string, number>();
	while (pending.length) { const node = pending.pop()!; sampledBytes += node.selfSize; if (node.selfSize) sites.set(node.callFrame.functionName, (sites.get(node.callFrame.functionName) ?? 0) + node.selfSize); for (const child of node.children) pending.push(child); }
	await fixture.release(); fixture = undefined; await gc();
	const retainedOwners = ownerRef.deref() === undefined ? 0 : 1, retainedSettings = settingsRef.deref() === undefined ? 0 : 1;
	assert.equal(retainedOwners, 0); assert.equal(retainedSettings, 0); assert.equal(serializations, 0);
	assert.equal(metadataViews, baseline ? 0 : iterations, "one metadata view per request, no per-history copy");
	writeFileSync(output, originalStringify({ baseline, iterations, expectedTokens: 329509, serializations, serializedChars, metadataViews, sampledBytes, peakHeap,
		before, afterRelease: process.memoryUsage(), cpuMicroseconds: cpu.user + cpu.system, retainedOwners, retainedSettings,
		topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8) }));
} finally { inspector.disconnect(); JSON.stringify = originalStringify; if (fixture) await fixture.release(); }
