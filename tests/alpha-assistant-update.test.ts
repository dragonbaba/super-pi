import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageComponent } from '../packages/coding-agent/src/modes/interactive/components/assistant-message.ts';
import { initTheme } from '../packages/coding-agent/src/modes/interactive/theme/theme.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';
import { stress } from './helpers/alpha-stress-workload.ts';

for (const mode of ['regular', 'fullscreen'] as const) test(`session-to-component boundaries and owner release: ${mode}`, async () => {
  assert.ok(global.gc, 'run through npm test (or node --expose-gc) to verify collection');
  // Two full render batches plus a partial final batch; full-size repeated heap
  // measurements belong to scripts/bench/alpha-stress-gc.ts.
  const result = await stress(mode, undefined, 8193);
  for (let round = 0; round < 5; round++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    global.gc();
  }
  assert.ok(result.weak.every(reference => reference.deref() === undefined), 'all session/component/frame owners released');
});

test('one visible streaming text slot does not rebuild unrelated child structure', (t) => {
  initTheme('dark');
  const component = new AssistantMessageComponent();
  component.updateContent(alphaMessage([{ type: 'text', text: 'warm' }]), true);
  const content = (component as any).contentContainer;
  let childrenAdded = 0;
  const add = content.addChild.bind(content);
  t.mock.method(content, 'addChild', (child: any) => { childrenAdded++; add(child); });
  for (const text of ['warm append', 'replacement', 'r', ' 中文 👩‍💻e\u0301 ', '\x1b[31mANSI\x1b[0m', '# Heading\n\n- list', '```ts\nconst x = 1;', '```ts\nconst x = 1;\n```', '[link](https://fixture.invalid)', '$x^2$']) {
    const message = alphaMessage([{ type: 'text', text }]);
    component.updateContent(message, true);
    const fresh = new AssistantMessageComponent(); fresh.updateContent(message, true);
    assert.deepEqual(component.render(120), fresh.render(120));
  }
  assert.equal(childrenAdded, 0, 'shape-preserving text updates reuse existing children');
  for (const content of [[], [{ type: 'text', text: '' }], [{ type: 'thinking', thinking: 'think' }, { type: 'text', text: 'answer' }], [{ type: 'toolCall', id: 'tool', name: 'fixture', arguments: {} }]]) {
    const message = alphaMessage(content as any); component.updateContent(message, true);
    const fresh = new AssistantMessageComponent(); fresh.updateContent(message, true);
    assert.deepEqual(component.render(120), fresh.render(120));
  }
});
