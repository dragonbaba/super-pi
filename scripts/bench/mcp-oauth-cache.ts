import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTask } from "node:timers/promises";
// @ts-expect-error JavaScript extension package.
import { McpOAuth } from "../../packages/mcp-bridge/src/oauth.js";

const mode = process.argv[2] ?? "counts";
const issuer = "https://auth.fixture.invalid";
const sourceHash = createHash("sha256").update(readFileSync(new URL("../../packages/mcp-bridge/src/oauth.js", import.meta.url))).digest("hex");
let locks = 0, fetches = 0, parses = 0, urls = 0, promises = 0;
let stored = "{}";
const backend = { async withLockAsync(operation: (text: string) => Promise<{ result: unknown; next?: string }>) {
  locks++;
  const result = await operation(stored);
  if (result.next !== undefined) stored = result.next;
  return result.result;
} };
const owner = new McpOAuth({ id: "benchmark", source: "fixture", url: "https://mcp.fixture.invalid/mcp", oauth: {} }, backend,
  () => { fetches++; throw new Error("valid cache must not fetch"); });
stored = JSON.stringify({ [owner.key]: {
  client: { client_id: "fixture", issuer },
  tokens: { token_type: "Bearer", access_token: "fixture-access", refresh_token: "fixture-refresh", issuer },
  expiresAt: Date.now() + 3_600_000,
  discovery: { authorizationServerUrl: issuer, authorizationServerMetadata: { issuer }, issuerValidationVersion: 1 },
} });
await owner.token();

async function reads(count: number) {
  for (let index = 0; index < count; index++) assert.equal(await owner.token(), "fixture-access");
}

if (mode === "counts") {
  const originalParse = JSON.parse, OriginalURL = globalThis.URL;
  const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
  locks = 0;
  JSON.parse = function countedParse(text, reviver) { parses++; return originalParse(text, reviver); };
  globalThis.URL = class extends OriginalURL { constructor(input: string | URL, base?: string | URL) { urls++; super(input, base); } };
  try {
    hook.enable();
    await reads(10_000);
  } finally { hook.disable(); JSON.parse = originalParse; globalThis.URL = OriginalURL; }
  assert.equal(locks, 0);
  assert.equal(fetches, 0);
  assert.equal(parses, 0);
  assert.equal(urls, 0);
  // Two async methods and their await reactions already exist per token lookup;
  // plus the measured loop's Promise/await pair. This is a request-auth boundary,
  // not the zero-Promise SDK progress/frame lane.
  assert.equal(promises, 40_002);
  console.log(JSON.stringify({ mode, sourceHash, reads: 10_000, locks, fetches, parses, urls, promises }));
} else if (mode === "allocation") {
  const inspector = new Session(); inspector.connect();
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024 });
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;
  const samples: number[] = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now(); await reads(5000); samples.push(performance.now() - start);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling"); inspector.disconnect();
  const sites = new Map<string, number>();
  function visit(node: typeof profile.head) {
    const label = `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
    sites.set(label, (sites.get(label) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) visit(child);
  }
  visit(profile.head); samples.sort((left, right) => left - right);
  console.log(JSON.stringify({ mode, sourceHash, reads: 100_000, initialHeap, peakHeap, finalHeap: process.memoryUsage().heapUsed,
    batchP50Ms: samples[9], batchP95Ms: samples[18], sites: [...sites].sort((left, right) => right[1] - left[1]).slice(0, 10) }));
} else if (mode === "gc") {
  assert.ok(global.gc, "requires --expose-gc");
  function references(): WeakRef<object>[] {
    const entry = owner.cached;
    return [new WeakRef(entry), new WeakRef(entry.client), new WeakRef(entry.tokens), new WeakRef(entry.discovery)];
  }
  const refs = references();
  await owner.logout();
  assert.equal(owner.cached, undefined);
  assert.equal(await owner.token(), undefined);
  for (let index = 0; index < 8; index++) { await nextTask(); global.gc(); }
  const retained = refs.reduce((count, reference) => count + Number(reference.deref() !== undefined), 0);
  assert.equal(retained, 0);
  console.log(JSON.stringify({ mode, sourceHash, weakRefs: refs.length, retained, finalHeap: process.memoryUsage().heapUsed }));
} else throw new Error("unknown benchmark mode");
