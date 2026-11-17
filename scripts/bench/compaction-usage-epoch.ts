import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { compactionEpochFixture, epochAssistant } from "../../tests/helpers/compaction-epoch-fixture.ts";

const smoke = process.argv.includes("--smoke"), iterations = smoke ? 4 : 256;
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
if (outputIndex >= 0) assert.ok(outputPath, "--output requires a destination file");
const originalStringify = JSON.stringify;
let serializations = 0, serializedChars = 0;
function countedStringify(value: unknown): string | undefined {
  const text = originalStringify(value); serializations++; serializedChars += text?.length ?? 0; return text;
}
function tick(resolve: () => void): void { setImmediate(resolve); }
async function gc(): Promise<void> {
  assert.ok(global.gc);
  for (let index = 0; index < 8; index++) { await new Promise<void>(tick); global.gc(); }
}
let fixture: Awaited<ReturnType<typeof compactionEpochFixture>> | undefined = await compactionEpochFixture();
const sessionRef = new WeakRef(fixture.session);
let current: ReturnType<typeof epochAssistant> | undefined = epochAssistant(0, 1000);
for (let index = 0; index < 160; index++) {
  const message = epochAssistant(0, index + 2), id = `history-${index}`;
  message.stopReason = "toolUse";
  message.content = [{ type: "toolCall", id, name: "codemode", arguments: { code: "x".repeat(4096) } }];
  fixture.sessionManager.appendMessage(message);
  fixture.sessionManager.appendMessage({ role: "toolResult", toolName: "codemode", toolCallId: id,
    content: [{ type: "text", text: "y".repeat(4096) }], isError: false, timestamp: index + 2 });
}
fixture.sessionManager.appendMessage(current);
fixture.session.agent.state.messages = fixture.sessionManager.buildSessionContext().messages;
const expected = fixture.session.getContextUsage()!.tokens;
current.usage.input = expected; current.usage.totalTokens = expected;
current = undefined;
await gc();
const before = process.memoryUsage();
for (let index = 0; index < 16; index++) assert.equal(fixture.session.getContextUsage()!.tokens, expected);
const inspector = new Session(); inspector.connect();
let profile: { head: ProfileNode };
type ProfileNode = { selfSize: number; callFrame: { functionName: string }; children: ProfileNode[] };
let peakHeap = before.heapUsed;
try {
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const cpuStart = process.cpuUsage();
  JSON.stringify = countedStringify as typeof JSON.stringify;
  try {
    for (let index = 0; index < iterations; index++) {
      assert.equal(fixture.session.getContextUsage()!.tokens, expected);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
  } finally { JSON.stringify = originalStringify; }
  const cpu = process.cpuUsage(cpuStart);
  profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
  const sites = new Map<string, number>(); let sampledBytes = 0;
  const stack = [profile.head];
  while (stack.length) {
    const node = stack.pop()!; sampledBytes += node.selfSize;
    if (node.selfSize) sites.set(node.callFrame.functionName, (sites.get(node.callFrame.functionName) ?? 0) + node.selfSize);
    for (const child of node.children) stack.push(child);
  }
  const source = fixture.session.getContextUsage()!.source;
  await fixture.release(); fixture = undefined;
  await gc();
  const retainedSessionOwners = sessionRef.deref() === undefined ? 0 : 1;
  assert.equal(retainedSessionOwners, 0);
  const output = originalStringify({ iterations, expectedTokens: expected, source, serializations, serializedChars,
    cpuMicroseconds: cpu.user + cpu.system, sampledBytes, peakHeap, before, afterRelease: process.memoryUsage(), retainedSessionOwners,
    topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 6) });
  if (outputPath) writeFileSync(outputPath, output);
  console.log(output);
} finally { inspector.disconnect(); JSON.stringify = originalStringify; if (fixture) await fixture.release(); }
