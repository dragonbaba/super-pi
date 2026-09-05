import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentSessionRuntime, type AgentSessionServices } from '../packages/coding-agent/src/core/agent-session-runtime.ts';
import { DefaultResourceLoader } from '../packages/coding-agent/src/core/resource-loader.ts';
import { createAgentSession } from '../packages/coding-agent/src/core/sdk.ts';
import { SessionManager } from '../packages/coding-agent/src/core/session-manager.ts';
import { SettingsManager } from '../packages/coding-agent/src/core/settings-manager.ts';
import type { ModelRuntime } from '../packages/coding-agent/src/core/model-runtime.ts';
import { InteractiveMode, createInteractiveTui } from '../packages/coding-agent/src/modes/interactive/interactive-mode.ts';
import { initTheme } from '../packages/coding-agent/src/modes/interactive/theme/theme.ts';
import { ProcessTerminal } from '../packages/tui/src/terminal.ts';

class StrictSink extends Writable {
  readonly writes: string[] = [];
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk.toString());
    callback();
  }
}

async function fixture(modeName: 'regular' | 'fullscreen') {
  const root = mkdtempSync(join(tmpdir(), 'g2s-lifecycle-'));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  initTheme('dark');
  const settingsManager = SettingsManager.inMemory({ quietStartup: true });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(root), noTools: 'all',
    model: { id: 'g2s', name: 'g2s', api: 'openai-responses', provider: 'fixture', baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 },
    modelRuntime: { hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false } as unknown as ModelRuntime });
  const runtime = new AgentSessionRuntime(session, { cwd: root, agentDir } as AgentSessionServices, async () => { throw new Error('unexpected replacement'); });
  const mode = new InteractiveMode(runtime, { tuiMode: modeName });
  const internals = mode as unknown as { renderer: ReturnType<typeof createInteractiveTui>; shutdown(): Promise<void> };
  await internals.renderer.dispose({ preserveScreen: true });
  const sink = new StrictSink();
  const terminal = new ProcessTerminal(sink as unknown as NodeJS.WriteStream);
  // Existing internal drain seam: keep node:test's IPC stdin out of terminal ownership.
  (terminal as unknown as { drainInputSource: EventEmitter }).drainInputSource = new EventEmitter();
  internals.renderer = createInteractiveTui({ tuiMode: modeName, showHardwareCursor: false, logDirectory: root, terminal });
  return { root, session, runtime, mode, internals, terminal, sink };
}

for (const modeName of ['regular', 'fullscreen'] as const) test(`real shutdown before init rejects no disposed write: ${modeName}`, async (t) => {
  const f = await fixture(modeName);
  const events: string[] = [];
  let illegal = 0;
  const disposeTerminal = f.terminal.dispose.bind(f.terminal);
  const setTitle = f.terminal.setTitle.bind(f.terminal);
  const disposeSession = f.session.dispose.bind(f.session);
  t.mock.method(f.terminal, 'dispose', () => { events.push('terminal.dispose'); disposeTerminal(); });
  t.mock.method(f.terminal, 'setTitle', (title: string) => {
    events.push('setTitle');
    try { setTitle(title); } catch (error) { illegal++; throw error; }
  });
  t.mock.method(f.session, 'dispose', () => { events.push('session.dispose'); disposeSession(); });
  // Observe the existing exit request; never terminate the test process or swallow teardown failures.
  t.mock.method(process, 'exit', (code?: number) => { events.push(`exit:${code}`); });
  try {
    await f.internals.shutdown();
    assert.equal(illegal, 0);
    assert.equal(events.filter(event => event === 'terminal.dispose').length, 1);
    assert.equal(events.filter(event => event === 'session.dispose').length, 1);
    assert.ok(events.includes('exit:0'));
    assert.throws(() => setTitle('contract remains strict'), /disposed ProcessTerminal/);
  } finally {
    t.diagnostic(JSON.stringify({ modeName, events, postDisposeWrites: illegal, sinkWrites: f.sink.writes.length }));
    await f.mode.stop();
    disposeSession();
    await new Promise<void>(resolve => setImmediate(resolve));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('real runtime concurrent dispose owns one session disposal', async (t) => {
  const f = await fixture('regular');
  const disposeSession = f.session.dispose.bind(f.session);
  let count = 0;
  t.mock.method(f.session, 'dispose', () => { count++; disposeSession(); });
  try {
    await Promise.all([f.runtime.dispose(), f.runtime.dispose(), f.runtime.dispose()]);
    assert.equal(count, 1);
  } finally {
    await f.mode.stop();
    disposeSession();
    await new Promise<void>(resolve => setImmediate(resolve));
    rmSync(f.root, { recursive: true, force: true });
  }
});
