// Local transport allocation/lifecycle probe. No provider credentials or remote traffic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Session } from 'node:inspector/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { configureHttpDispatcher } from '../../packages/coding-agent/src/core/http-dispatcher.ts';

assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc');
process.env.NO_PROXY = '127.0.0.1';
const previousDispatcher = getGlobalDispatcher();
const previousFetch = globalThis.fetch;
const payload = Buffer.alloc(256 * 1024, 97);
const sockets = new Set();
let requests = 0, responses = 0, receivedBytes = 0, reads = 0;
let responseRef, readerRef, dispatcherRef;
const server = createServer((_request, response) => {
  requests++;
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
  response.end(payload);
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
const inspector = new Session();
let sampling = false, dispatcher;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  configureHttpDispatcher();
  dispatcher = getGlobalDispatcher();
  dispatcherRef = new WeakRef(dispatcher);
  async function consume() {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        receivedBytes += next.value.byteLength;
        reads++;
      }
    } finally { reader.releaseLock(); }
    responses++;
    responseRef = new WeakRef(response);
    readerRef = new WeakRef(reader);
  }
  for (let i = 0; i < 20; i++) await consume();
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  inspector.connect();
  await inspector.post('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  sampling = true;
  const timings = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await consume();
    timings.push(performance.now() - start);
  }
  const heapAfterWork = process.memoryUsage().heapUsed;
  const { profile } = await inspector.post('HeapProfiler.stopSampling');
  sampling = false;
  function sum(node) { return node.selfSize + node.children.reduce((total, child) => total + sum(child), 0); }
  const sampledBytes = sum(profile.head);
  await dispatcher.close();
  setGlobalDispatcher(previousDispatcher);
  dispatcher = undefined;
  globalThis.fetch = previousFetch;
  await new Promise(resolve => server.close(resolve));
  for (let i = 0; i < 12; i++) { await tick(); globalThis.gc(); }
  const retained = { sockets: sockets.size, response: !!responseRef.deref(), reader: !!readerRef.deref(), dispatcher: !!dispatcherRef.deref() };
  assert.deepEqual(retained, { sockets: 0, response: false, reader: false, dispatcher: false });
  assert.equal(requests, 120);
  assert.equal(responses, 120);
  assert.equal(receivedBytes, 120 * payload.length);
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ fixture: 'production-http-dispatcher:20-warmup:100x256KiB', node: process.version,
    undici: JSON.parse(readFileSync(new URL('../../node_modules/undici/package.json', import.meta.url))).version,
    requests, responses, receivedBytes, reads, sampledBytes, sampledBytesPerResponse: sampledBytes / 100,
    p50Ms: timings[49], p95Ms: timings[94], heapBefore, heapAfterWork, heapAfterGc: process.memoryUsage().heapUsed, retained,
    scope: 'Production configureHttpDispatcher and npm undici fetch/body consumption; includes fixture server and consumer allocations. SDK parser and TUI measured separately.' }, null, 2));
} finally {
  if (sampling) await inspector.post('HeapProfiler.stopSampling');
  inspector.disconnect();
  setGlobalDispatcher(previousDispatcher);
  globalThis.fetch = previousFetch;
  if (dispatcher) await dispatcher.destroy();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
