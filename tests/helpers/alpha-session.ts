import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Model } from '../../packages/ai/src/types.ts';
import { AgentSessionRuntime } from '../../packages/coding-agent/src/core/agent-session-runtime.ts';
import { DefaultResourceLoader } from '../../packages/coding-agent/src/core/resource-loader.ts';
import { createAgentSession } from '../../packages/coding-agent/src/core/sdk.ts';
import { SettingsManager } from '../../packages/coding-agent/src/core/settings-manager.ts';
import { SessionManager } from '../../packages/coding-agent/src/core/session-manager.ts';
import type { ModelRuntime } from '../../packages/coding-agent/src/core/model-runtime.ts';
import { InteractiveMode, createInteractiveTui } from '../../packages/coding-agent/src/modes/interactive/interactive-mode.ts';
import { initTheme } from '../../packages/coding-agent/src/modes/interactive/theme/theme.ts';
import { ProcessTerminal } from '../../packages/tui/src/terminal.ts';

export const ALPHA_MODEL: Model<'openai-responses'> = { id: 'alpha-fixture', name: 'alpha-fixture', api: 'openai-responses', provider: 'fixture', baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
export function alphaModelRuntime(streamSimple?: ModelRuntime['streamSimple']): ModelRuntime {
  return { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: 'api_key' }), getAuth: async () => undefined,
    isUsingOAuth: () => false, isUsingSubscription: () => false, getAvailableSnapshot: () => [ALPHA_MODEL],
    getAvailable: async () => [ALPHA_MODEL], getError: () => undefined,
    registerProvider: () => {}, registerNativeProvider: () => {}, unregisterProvider: () => {}, getModel: () => ALPHA_MODEL,
    streamSimple: streamSimple ?? (() => { throw new Error('unexpected provider call'); }),
  } as unknown as ModelRuntime;
}

export class AlphaInput extends PassThrough {
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}

export class AlphaSink extends Writable {
  bytes = 0;
  writes = 0;
  physicalMarker?: (text: string) => void;
  readonly controls: string[] = [];
  delay = 0;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bytes += chunk.byteLength;
    this.writes++;
    const text = chunk.toString();
    this.physicalMarker?.(text);
    if (text.length < 200 && this.controls.length < 4096) this.controls.push(text);
    if (this.delay) setTimeout(callback, this.delay); else callback();
  }
}

export async function alphaHeadless(runtime: ModelRuntime, messages: any[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'g2s-headless-'));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(root);
  for (const message of messages) sessionManager.appendMessage(message);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, sessionManager, resourceLoader, model: ALPHA_MODEL, modelRuntime: runtime, noTools: 'all' });
  return { session, async release() { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

export async function alphaSession(options: {
  mode?: 'regular' | 'fullscreen'; sinkDelay?: number; columns?: number; rows?: number;
  runtime?: ModelRuntime; extensions?: any[]; messages?: any[]; customTools?: any[];
  g2?: boolean; budgetTokens?: number; settings?: Record<string, unknown>; allowReplacements?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'g2s-session-'));
  const agentDir = join(root, 'agent'); mkdirSync(agentDir);
  const settings = SettingsManager.inMemory({ quietStartup: true, theme: 'dark', ...options.settings });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noContextFiles: true,
    noExtensions: !options.extensions?.length, extensionFactories: options.extensions, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(root);
  for (const message of options.messages ?? []) sessionManager.appendMessage(message);
  const { session } = await createAgentSession({ cwd: root, agentDir, model: ALPHA_MODEL, modelRuntime: options.runtime ?? alphaModelRuntime(),
    settingsManager: settings, sessionManager, resourceLoader, noTools: options.customTools?.length ? 'builtin' : 'all',
    customTools: options.customTools, toolResultPresentation: { enabled: options.g2 ?? true, budgetTokens: options.budgetTokens ?? 1024 } });
  const runtime = new AgentSessionRuntime(session, { cwd: root, agentDir } as never, async target => {
    if (!options.allowReplacements) throw new Error('unexpected replacement');
    const loader = new DefaultResourceLoader({ cwd: target.cwd, agentDir: target.agentDir, settingsManager: settings, noContextFiles: true,
      noExtensions: !options.extensions?.length, extensionFactories: options.extensions, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const created = await createAgentSession({ cwd: target.cwd, agentDir: target.agentDir, sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent, model: ALPHA_MODEL, modelRuntime: options.runtime ?? alphaModelRuntime(),
      settingsManager: settings, resourceLoader: loader, noTools: options.customTools?.length ? 'builtin' : 'all',
      customTools: options.customTools, toolResultPresentation: { enabled: options.g2 ?? true, budgetTokens: options.budgetTokens ?? 1024 } });
    return { ...created, services: { cwd: target.cwd, agentDir: target.agentDir } as never, diagnostics: [] };
  });
  initTheme('dark');
  const mode = new InteractiveMode(runtime, { tuiMode: options.mode ?? 'regular' });
  const internal = mode as any;
  await internal.renderer.dispose({ preserveScreen: true });
  const input = new AlphaInput();
  const resizeSource = Object.assign(new EventEmitter(), { columns: options.columns ?? 120, rows: options.rows ?? 40 });
  const sink = new AlphaSink({ highWaterMark: 1024 }); sink.delay = options.sinkDelay ?? 0;
  const terminal = new ProcessTerminal(sink as unknown as NodeJS.WriteStream, { input: input as unknown as NodeJS.ReadStream, resizeSource: resizeSource as unknown as NodeJS.WriteStream });
  internal.renderer = createInteractiveTui({ tuiMode: options.mode ?? 'regular', terminal, showHardwareCursor: false, logDirectory: root });
  internal.renderer.setRenderInstrumentation(internal.renderInstrumentation);
  return { root, session, runtime, mode, internal, terminal, sink, input, resizeSource, sessionManager,
    async release() {
      await mode.stop(); await runtime.dispose();
      await new Promise<void>(resolve => setImmediate(resolve));
      input.destroy(); sink.destroy();
      rmSync(root, { recursive: true, force: true });
    } };
}
