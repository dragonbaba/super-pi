import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { SessionManager } from '../packages/coding-agent/src/core/session-manager.ts';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage, finalStream } from './helpers/alpha-stream.ts';
import { g2_raw_result_probe } from './fixtures/g2-raw-result-probe.ts';
import { createJiti } from 'jiti';
const { default: planMode } = await createJiti(import.meta.url).import<typeof import('../packages/plan-mode/src/plan-mode.ts')>('../packages/plan-mode/src/plan-mode.ts');

for (const mode of ['regular', 'fullscreen'] as const) test(`real new/fork/resume preserves UI reset and source boundaries: ${mode}`, { timeout: 5000 }, async (t) => {
  let starts = 0; let shutdowns = 0; let resets = 0;
  const contexts: any[] = [];
  let initializedAtStart = false;
  const raw = g2_raw_result_probe('medium');
  const message = { role: 'toolResult' as const, toolCallId: raw.details.toolCallId, toolName: 'g2_raw_result_probe', content: raw.content, isError: false, timestamp: 1 };
  const f = await alphaSession({ mode, allowReplacements: true, messages: [message], extensions: [(pi: any) => {
    planMode({ ...pi, getFlag: (name: string) => name === 'plan' ? true : pi.getFlag(name) }, { readSettings: async () => ({ kind: 'missing' }) });
    pi.on('session_start', (event: any, ctx: any) => { starts++; contexts.push({ ctx, ui: ctx.ui }); ctx.ui.setTitle(`live-${starts}`); ctx.ui.setWidget('live', [`session ${starts}`]);
      if (event.reason === 'new') initializedAtStart = ctx.sessionManager.getBranch().some((entry: any) => entry.type === 'message' && entry.message.content === 'fork target');
    });
    pi.on('session_shutdown', () => { shutdowns++; });
  }] });
  const reset = f.internal.resetExtensionUI.bind(f.internal);
  t.mock.method(f.internal, 'resetExtensionUI', () => { resets++; return reset(); });
  let exit: number | undefined; t.mock.method(process, 'exit', (code: number) => { exit = code; });
  try {
    assert.equal(await f.mode.init(), true);
    const before = f.session.getToolResultPresentationForUi(f.session.messages[0] as any);
    assert.ok(before?.version === 2);
    assert.ok(before.artifact);
    const cursor = before.continuation.cursor; const artifact = before.artifact.id;
    const resetBaseline = resets;
    // Actual TUI ownership: a mode switch closes the old menu, and an export
    // submitted inside a custom input can switch without joining its own action.
    let screenReady!: (component: any) => void;
    const nextScreen = () => new Promise<any>(resolve => { screenReady = resolve; });
    const showCustom = f.internal.showExtensionCustom.bind(f.internal);
    t.mock.method(f.internal, 'showExtensionCustom', (factory: any, options: any) => showCustom((...args: any[]) => {
      const component = factory(...args); assert.equal(typeof component?.then, 'undefined');
      setImmediate(() => screenReady(component)); return component;
    }, options));
    const planCommand = f.session.extensionRunner.getCommand('plan')!;
    const runPlan = (args: string) => planCommand.handler(args, f.session.extensionRunner.createCommandContext());
    const opened = nextScreen(), menu = runPlan(''); await opened;
    await runPlan('exit'); await menu; assert.equal(f.internal.activeExtensionCustomCancel, undefined);
    await runPlan('start');
    f.session.agent.streamFunction = () => finalStream(alphaMessage([{ type: 'text', text: '<proposed_plan>\nInspect the source, apply the approved change, then verify its behavior.\n</proposed_plan>' }]));
    const ready = nextScreen(); await f.session.prompt('Prepare the plan'); const readyComponent = await ready;
    const input = nextScreen(); readyComponent.handleInput('\u001b[B'); readyComponent.handleInput('\u001b[B'); readyComponent.handleInput('\r');
    const inputComponent = await input;
    const ui = f.session.extensionRunner.getUIContext(), notify = ui.notify;
    let exported!: () => void; const exportDone = new Promise<void>(resolve => { exported = resolve; });
    t.mock.method(ui, 'notify', (text: string, type: any) => { notify(text, type); if (text.startsWith('Plan exported to')) exported(); });
    const exportPath = join(f.root, 'reviewed-plan.md'); inputComponent.handleInput(exportPath); inputComponent.handleInput('\r');
    await exportDone; assert.match(readFileSync(exportPath, 'utf8'), /apply the approved change/);
    assert.equal(f.internal.activeExtensionCustomCancel, undefined);
    await assert.rejects(f.runtime.newSession({ setup: async () => { throw new Error('controlled setup failure'); } }), /controlled setup failure/);
    assert.equal(shutdowns, 0, 'failed destination preparation retains the current session');
    const result = await f.runtime.newSession({ setup: async manager => {
      manager.appendCustomEntry('plan-mode-state', { enabled: false, awaitingAction: false,
        activeImplementation: { id: 'fresh-plan', plan: 'Apply the approved scoped change.', source: 'plan_mode_complete', startedAt: 1, retention: 'session' } });
      manager.appendMessage({ role: 'user', content: 'fork target', timestamp: 2 });
      manager.appendMessage(alphaMessage([{ type: 'text', text: 'new session' }]));
    } });
    assert.equal(result.cancelled, false);
    assert.equal(initializedAtStart, true, 'session_start sees setup before restoring tool/mode state');
    const planState = f.runtime.session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'plan-mode-state').at(-1) as { data: { enabled: boolean; activeImplementation?: { id: string } } };
    assert.equal(planState.data.enabled, false); assert.equal(planState.data.activeImplementation?.id, 'fresh-plan');
    assert.equal(f.runtime.session.getToolCatalog().selectionMode, 'default', 'new session does not inherit the previous Plan declaration');
    assert.equal(f.runtime.session.getActiveToolNames().includes('plan_mode_complete'), false, 'explicit fresh implementation stays outside Plan despite the inherited CLI flag');
    assert.equal(resets, resetBaseline + 1);
    assert.throws(() => f.runtime.session.readToolResultContinuation(cursor, 1024));
    assert.throws(() => f.runtime.session.readToolResultArtifact(artifact));
    const entry = f.runtime.session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user');
    assert.ok(entry);
    assert.equal((await f.runtime.fork(entry.id)).cancelled, false);
    assert.equal(resets, resetBaseline + 2);
    const resumed = SessionManager.create(f.root, join(f.root, 'resume-fixture'));
    resumed.appendMessage(alphaMessage([{ type: 'text', text: 'resume fixture' }]));
    const file = resumed.getSessionFile(); assert.ok(file);
    assert.equal((await f.runtime.switchSession(file)).cancelled, false);
    assert.equal(resets, resetBaseline + 3);
    assert.equal(starts, 4); assert.equal(shutdowns, 3);
    const beforeLate = f.sink.writes;
    assert.throws(() => contexts[0].ctx.ui, /stale/);
    contexts[0].ui.setTitle('stale replacement context');
    assert.equal(f.sink.writes, beforeLate);
    await f.internal.shutdown();
    assert.equal(exit, 0); assert.equal(shutdowns, 4);
    assert.equal(resets, resetBaseline + 3, 'final disposal does not repeat the replacement UI reset');
    assert.equal(f.input.isRaw, false);
    assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.resizeSource.listenerCount('resize'), 0);
  } finally { await f.release(); }
});
