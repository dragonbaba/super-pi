import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { Markdown } from '@super-pi/tui';
import { AssistantMessageComponent } from '../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts';
import { alphaSession, alphaHeadless, alphaModelRuntime } from '../../tests/helpers/alpha-session.ts';
import { scheduledStream, alphaMessage } from '../../tests/helpers/alpha-stream.ts';
import { ALPHA_LATENCY_BODIES } from '../../tests/helpers/alpha-latency-corpus.ts';
import { createInteractiveTui } from '../../packages/coding-agent/src/modes/interactive/interactive-mode.ts';
import { FakeTerminal } from '../../tests/helpers/runtime-instrumentation.ts';

function option(name: string, fallback: string) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1]! : fallback; }
const layer = Number(option('layer', '3'));
const rate = Number(option('rate', '20'));
const count = Number(option('count', '40'));
const history = Number(option('history', '0'));
const delay = Number(option('delay', '0'));
const batch = Number(option('batch', '1'));
const mode = option('mode', 'regular') as 'regular' | 'fullscreen';
const columns = Number(option('columns', '120')); const rows = Number(option('rows', '40'));
const corpus = option('corpus', 'plain');
const profile = option('profile', 'off') === 'on';
const bodies = ALPHA_LATENCY_BODIES;
const fixture = scheduledStream(count, rate, bodies[corpus] ?? corpus, batch);
const eventTimes = new Float64Array(count); const visibleTimes = new Float64Array(count);
const handledTimes = new Float64Array(count); const renderedTimes = new Float64Array(count);
let highestHandled = -1; let nextRendered = 0;
const renderTimes = new Float64Array(Math.min(200000, count * 4 + 1000)); let renders = 0;
let events = 0; let footerInvalidations = 0; let markdownSetTexts = 0; let markdownRenders = 0;
const assistant = { updateContentCalls: 0, contentScans: 0, slotRecordObjects: 0, markdownInstances: 0, spacerInstances: 0, textInstances: 0, currentSpacers: 0, spacerHwm: 0 };
const markdown = { incrementalEligibleUpdates: 0, incrementalUpdates: 0, fullFallbacks: 0, sourceCharactersReparsed: 0, sourceCharactersRewrapped: 0, parserTokensReused: 0, parserTokensRebuilt: 0, renderedPrefixLinesReused: 0, tailLinesRebuilt: 0, cachedTokenCount: 0, cachedRenderedLines: 0, cachedSourceCharacters: 0, lastFallbackReason: 'none' };
const fallbackReasons: Record<string, number> = {};
const fallbackPhases: Record<string, number> = {};
let lastPhase = 'initial';
function mark(text: string, table: Float64Array) {
  const now = performance.now(); const expression = /M(\d{6})/g; let match: RegExpExecArray | null; let highest = -1;
  while ((match = expression.exec(text))) { const index = Number(match[1]); if (index < count) { if (table[index] === 0) table[index] = now; highest = Math.max(highest, index); } }
  return highest;
}
function stats(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b); const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { n: values.length, p50: values[Math.floor((values.length - 1) * .5)], p95: values[Math.floor((values.length - 1) * .95)], p99: values[Math.floor((values.length - 1) * .99)], max: values.at(-1), cv: mean ? Math.sqrt(variance) / mean : 0 };
}
function differences(table: Float64Array) { const values: number[] = []; let previous = 0; for (const time of table) if (time) { if (previous) values.push(time - previous); previous = time; } return values; }
const runtime = alphaModelRuntime(() => fixture.start());
let f: Awaited<ReturnType<typeof alphaSession>> | undefined;
let headless: Awaited<ReturnType<typeof alphaHeadless>> | undefined;
let memory: FakeTerminal | undefined;
const update = AssistantMessageComponent.prototype.updateContent;
const setText = Markdown.prototype.setText; const renderMarkdown = Markdown.prototype.render;
const inspector = new Session(); inspector.connect();
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  if (layer > 0) {
    const messages = Array.from({ length: history }, () => alphaMessage([{ type: 'text', text: 'completed fixture history' }]));
    if (layer === 1) headless = await alphaHeadless(runtime, messages);
    else f = await alphaSession({ mode, sinkDelay: delay, columns, rows, runtime, settings: { compaction: { enabled: false } }, messages });
    if (layer >= 2) {
      assert.ok(f);
      if (layer === 2) {
        await f.internal.renderer.dispose({ preserveScreen: true });
        memory = new FakeTerminal(columns, rows);
        memory.write = (text: string) => { mark(text, visibleTimes); };
        f.internal.renderer = createInteractiveTui({ tuiMode: mode, terminal: memory, showHardwareCursor: false, logDirectory: f.root });
        f.internal.renderer.setRenderInstrumentation(f.internal.renderInstrumentation);
      } else f.sink.physicalMarker = text => mark(text, visibleTimes);
      await f.mode.init();
      await f.internal.loadInitializationHighlightLanguages();
      await f.internal.renderer.flushTerminalFrames();
      const footer = f.internal.footer.invalidate.bind(f.internal.footer);
      f.internal.footer.invalidate = () => { footerInvalidations++; footer(); };
      const handle = f.internal.handleEvent.bind(f.internal); let handledOffset = 0;
      f.internal.handleEvent = (event: any) => {
        const result = handle(event);
        if (event.type === 'message_update' && event.message.role === 'assistant') for (const block of event.message.content) if (block.type === 'text') {
          highestHandled = Math.max(highestHandled, mark(block.text.substring(Math.max(0, handledOffset - 8)), handledTimes));
          handledOffset = block.text.length;
        }
        return result;
      };
      const render = f.internal.renderer.doRender.bind(f.internal.renderer);
      f.internal.renderer.doRender = () => {
        const before = f!.internal.renderInstrumentation.snapshot().fullHistoryFallbacks;
        const start = performance.now(); render(); assert.ok(renders < renderTimes.length); renderTimes[renders++] = performance.now() - start;
        while (nextRendered <= highestHandled) { if (handledTimes[nextRendered]) renderedTimes[nextRendered] = start; nextRendered++; }
        const change = f!.internal.renderInstrumentation.snapshot().fullHistoryFallbacks - before;
        if (change) fallbackPhases[lastPhase] = (fallbackPhases[lastPhase] ?? 0) + change;
      };
      AssistantMessageComponent.prototype.updateContent = function (message, streaming) { (this as any).allocationMetrics = assistant; return update.call(this, message, streaming); };
      Markdown.prototype.setText = function (text) { markdownSetTexts++; return setText.call(this, text); };
      Markdown.prototype.render = function (width) {
        (this as any).incrementalMetrics = markdown; markdownRenders++;
        const before = markdown.fullFallbacks;
        const result = renderMarkdown.call(this, width);
        if (markdown.fullFallbacks > before) fallbackReasons[markdown.lastFallbackReason] = (fallbackReasons[markdown.lastFallbackReason] ?? 0) + markdown.fullFallbacks - before;
        return result;
      };
      f.internal.renderInstrumentation.reset();
    }
    let eventOffset = 0;
    (headless?.session ?? f!.session).subscribe(event => { events++; lastPhase = event.type; if (event.type === 'message_update' && event.message.role === 'assistant') for (const block of event.message.content) if (block.type === 'text') { mark(block.text.substring(eventOffset), eventTimes); eventOffset = block.text.length; } });
  }
  loop.enable();
  if (profile) await inspector.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const start = performance.now();
  if (layer === 0) { for await (const _event of fixture.start()) { /* raw provider control */ } }
  else await (headless?.session ?? f!.session).prompt('deterministic stream fixture');
  if (layer >= 2) await f!.internal.renderer.flushTerminalFrames();
  const completionMs = performance.now() - start;
  const heap = profile ? await inspector.post('HeapProfiler.stopSampling') : undefined; loop.disable();
  const sites: { function: string; source: string; bytes: number }[] = []; const pending = heap ? [heap.profile.head] : [];
  while (pending.length) { const node = pending.pop()!; sites.push({ function: node.callFrame.functionName, source: node.callFrame.url.replace(/^.*\/(packages|scripts|tests)\//, '$1/'), bytes: node.selfSize }); pending.push(...node.children); }
  const latency: number[] = []; const eventLatency: number[] = []; const eventToRender: number[] = []; const renderToWrite: number[] = []; const scheduling: number[] = [];
  for (let i = 0; i < count; i++) {
    if (visibleTimes[i]) latency.push(visibleTimes[i]! - fixture.generated[i]!);
    if (eventTimes[i]) eventLatency.push(eventTimes[i]! - fixture.generated[i]!);
    if (renderedTimes[i] && handledTimes[i]) eventToRender.push(renderedTimes[i]! - handledTimes[i]!);
    if (visibleTimes[i] && renderedTimes[i]) renderToWrite.push(visibleTimes[i]! - renderedTimes[i]!);
    scheduling.push(fixture.generated[i]! - fixture.scheduled[i]!);
  }
  const metrics = layer >= 2 ? f!.internal.renderInstrumentation.snapshot() : undefined;
  if (layer >= 2) { assert.ok(visibleTimes[count - 1]! > 0, 'final marker physically written'); assert.ok(metrics.terminalFrameQueueHighWaterMark <= 2); assert.ok(metrics.pendingRenderRequestHighWaterMark <= 1); }
  console.log(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    layer, rate, count, batch, history, mode, columns, rows, delay, corpus, profile, completionMs, updatesPerSecond: count * 1000 / completionMs,
    providerToEvent: stats(eventLatency), visibleMarkers: latency.length, generatedChunks: count,
    providerInterArrival: stats(differences(fixture.generated)), visibleInterArrival: stats(differences(visibleTimes)), providerToPhysical: stats(latency), rootRenderMs: stats(Array.from(renderTimes.subarray(0, renders))),
    scheduledToGenerated: stats(scheduling), handledToRender: stats(eventToRender), renderStartToPhysical: stats(renderToWrite), maximumVisibleStall: stats(differences(visibleTimes))?.max ?? null,
    firstVisibleMs: layer >= 2 ? Math.min(...Array.from(visibleTimes).filter(Boolean)) - start : null,
    finalVisibleMs: visibleTimes[count - 1] ? visibleTimes[count - 1]! - start : null,
    eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    events, footerInvalidations, assistant, markdownSetTexts, markdownRenders, markdown, fallbackReasons, fallbackPhases, metrics,
    allocations: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 15) }));
} finally {
  fixture.cancel(); loop.disable(); inspector.disconnect();
  AssistantMessageComponent.prototype.updateContent = update; Markdown.prototype.setText = setText; Markdown.prototype.render = renderMarkdown;
  if (f) await f.release();
  if (headless) await headless.release();
}
