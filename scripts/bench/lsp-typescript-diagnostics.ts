/** Manual real-server benchmark, never discovered by npm test. Run in an owned
 * .task-tmp directory; see the evidence document for the frozen 88-file cohort. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRuntime } from '../../packages/lsp/src/adapters.ts';
import { LspClient } from '../../packages/lsp/src/lsp-client.ts';
import { LspClientPool } from '../../packages/lsp/src/client-pool.ts';
import { runDiagnostics } from '../../packages/lsp/src/runner.ts';
import { DIAGNOSTIC_BATCH_SIZE, MAX_COLLECTED_FILES } from '../../packages/lsp/src/limits.ts';
import type { DiagnosticEntry } from '../../packages/lsp/src/types.ts';

const { values } = parseArgs({ options: { root: { type: 'string' }, paths: { type: 'string' }, output: { type: 'string' }, mode: { type: 'string', default: 'both' }, concurrency: { type: 'string', default: '1,4,16' }, server: { type: 'string', default: 'typescript' }, timeout: { type: 'string', default: '45000' }, 'wait-ms': { type: 'string', default: '30000' } } });
if (!values.paths || !values.output) throw new Error('Provide --paths <JSON file> and --output <owned .task-tmp directory>.');
if (values.mode !== 'both' && values.mode !== 'publish' && values.mode !== 'sync-request') throw new Error('mode must be publish, sync-request or both.');
const root = path.resolve(values.root ?? process.cwd()), output = path.resolve(values.output);
const timeout = Number(values.timeout), waitMs = Number(values['wait-ms']);
if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(waitMs) || waitMs <= 0) throw new Error('timeout and wait-ms must be positive milliseconds.');
const paths: unknown = JSON.parse(readFileSync(values.paths, 'utf8'));
if (!Array.isArray(paths) || !paths.length || paths.length > MAX_COLLECTED_FILES || !paths.every(item => typeof item === 'string')) throw new Error('paths must contain the complete bounded file list.');
const files = paths as string[], concurrency: number[] = [];
for (const value of values.concurrency!.split(',')) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > DIAGNOSTIC_BATCH_SIZE) throw new Error(`concurrency must be within the existing ${DIAGNOSTIC_BATCH_SIZE}-document bound.`);
  concurrency.push(count);
}
mkdirSync(output, { recursive: true });
const monitor = fileURLToPath(new URL('./lsp-tsserver-memory.cjs', import.meta.url)).replaceAll('\\', '/');
const base = loadRuntime(root, { projectTrusted: true }).adapters.find(adapter => adapter.name === values.server);
if (!base?.synchronousDiagnostics) throw new Error('Select a configured TypeScript adapter declaring synchronous diagnostics.');

function contentManifest() {
  return files.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex') }));
}
const before = contentManifest(); writeFileSync(path.join(output, 'content-manifest.json'), JSON.stringify(before, null, 2));
const beforeHash = createHash('sha256').update(JSON.stringify(before)).digest('hex');
let opened = 0, closed = 0, active = 0, peak = 0;
const open = LspClient.prototype.didOpen, close = LspClient.prototype.didClose;
LspClient.prototype.didOpen = function(...args) { const result = open.apply(this, args); opened++; active++; peak = Math.max(peak, active); return result; };
LspClient.prototype.didClose = function(...args) { const result = close.apply(this, args); closed++; active--; return result; };
interface Measurement { label: string; mode: string; concurrency: number; warmth: string; elapsedMs: number; requestedFiles: number; summary: { files: number; diagnostics: number }; isError: boolean; peakOpenDocuments: number; opened: number; closed: number; active: number; details: unknown; entries: DiagnosticEntry[]; memory?: MemorySummary; }
interface MemoryRow { time: number; phase: string; pid: number; role: string; event: string; rss: number; heapUsed: number; }
interface MemorySummary { sampleIntervalMs: number; semanticPeakRssBytes: number; semanticPeakHeapBytes: number; allTsserversPeakRssBytes: number; processes: number; }
const measurements: Measurement[] = [];
function save() { writeFileSync(path.join(output, 'results.json'), JSON.stringify({ root, contentHash: beforeHash, measurements }, null, 2)); }

async function measure(mode: 'publish' | 'sync-request', count: number) {
  const pool = new LspClientPool();
  const adapter = { ...base!, synchronousDiagnostics: mode === 'sync-request' ? { ...base!.synchronousDiagnostics!, maxConcurrentFiles: count } : undefined,
    env: { ...base!.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(monitor)}`].filter(Boolean).join(' '), SP_LSP_DIAGNOSTICS_PROFILE_ROOT: output } };
  let lease;
  try {
    for (const warmth of ['cold', 'warm']) {
      const label = `${mode}-${count}-${warmth}`; writeFileSync(path.join(output, 'phase.txt'), label);
      opened = closed = active = peak = 0; const started = performance.now();
      lease ??= await pool.acquire(adapter, root, timeout);
      if (mode === 'sync-request' && !lease.client.supportsExecuteCommand(adapter.synchronousDiagnostics!.command)) throw new Error('The configured server does not advertise the requested bridge command.');
      const result = await runDiagnostics(pool, adapter, { root, paths: files, limit: MAX_COLLECTED_FILES, waitMs }, timeout, undefined, { ui: { setStatus() {} } }, 'manual-diagnostics-benchmark');
      const value: Measurement = { label, mode, concurrency: count, warmth, elapsedMs: performance.now() - started, requestedFiles: files.length, summary: result.details.summary,
        isError: result.isError, peakOpenDocuments: peak, opened, closed, active, details: result.details, entries: result.details.files as DiagnosticEntry[] };
      measurements.push(value); save();
      console.log(JSON.stringify({ label, elapsedMs: value.elapsedMs, summary: value.summary, isError: value.isError, opened, closed, active, peak }));
      if (!lease.client.running) { console.error(`${label}: server exited; a warm measurement is unavailable.`); break; }
    }
  } finally { if (lease) pool.release(lease); await pool.shutdownAll(); }
}

function memorySummaries() {
  const rows: MemoryRow[] = [];
  for (const name of readdirSync(output)) if (name.startsWith('tsserver-memory-') && name.endsWith('.jsonl')) {
    const contents = readFileSync(path.join(output, name), 'utf8');
    let start = 0;
    for (;;) {
      const end = contents.indexOf('\n', start); if (end < 0) break; // A killed sampler may leave an incomplete final row.
      if (end > start) rows.push(JSON.parse(contents.slice(start, end)));
      start = end + 1;
    }
  }
  rows.sort((a, b) => a.time - b.time);
  for (const measurement of measurements) {
    const live = new Map<number, number>(), seen = new Set<number>();
    const memory: MemorySummary = { sampleIntervalMs: 100, semanticPeakRssBytes: 0, semanticPeakHeapBytes: 0, allTsserversPeakRssBytes: 0, processes: 0 };
    let total = 0;
    for (const row of rows) if (row.phase === measurement.label) {
      seen.add(row.pid); total += row.rss - (live.get(row.pid) ?? 0); live.set(row.pid, row.rss);
      memory.allTsserversPeakRssBytes = Math.max(memory.allTsserversPeakRssBytes, total);
      if (row.role === 'semantic') { memory.semanticPeakRssBytes = Math.max(memory.semanticPeakRssBytes, row.rss); memory.semanticPeakHeapBytes = Math.max(memory.semanticPeakHeapBytes, row.heapUsed); }
      if (row.event === 'exit') { total -= row.rss; live.delete(row.pid); }
    }
    memory.processes = seen.size; measurement.memory = memory;
  }
}
function diagnostics(entries: DiagnosticEntry[]) {
  const rows: string[] = [];
  for (const entry of entries) for (const diagnostic of entry.diagnostics) rows.push(JSON.stringify([entry.path.replaceAll('\\', '/'), diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.range.end.line, diagnostic.range.end.character, String(diagnostic.code ?? ''), diagnostic.severity, diagnostic.message]));
  return rows.sort();
}
try {
  if (values.mode === 'both' || values.mode === 'publish') await measure('publish', DIAGNOSTIC_BATCH_SIZE);
  if (values.mode === 'both' || values.mode === 'sync-request') for (const count of concurrency) await measure('sync-request', count);
  if (JSON.stringify(before) !== JSON.stringify(contentManifest())) throw new Error('The benchmark source cohort changed.');
  const comparisons = [];
  for (const sync of measurements) if (sync.mode === 'sync-request') {
    const publish = measurements.find(item => item.mode === 'publish' && item.warmth === sync.warmth);
    if (publish) comparisons.push({ label: sync.label, equal: JSON.stringify(diagnostics(sync.entries)) === JSON.stringify(diagnostics(publish.entries)), complete: !sync.isError && !publish.isError && sync.summary.files === files.length && publish.summary.files === files.length });
  }
  writeFileSync(path.join(output, 'equivalence.json'), JSON.stringify(comparisons, null, 2));
  if (measurements.some(item => item.isError || item.summary.files !== files.length || item.active !== 0) || comparisons.some(item => !item.equal || !item.complete)) process.exitCode = 1;
} finally {
  LspClient.prototype.didOpen = open; LspClient.prototype.didClose = close;
  memorySummaries(); save();
}
