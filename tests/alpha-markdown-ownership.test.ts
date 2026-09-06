import assert from 'node:assert/strict';
import test from 'node:test';
import { Tokenizer } from 'marked';
import { Markdown } from '../packages/tui/src/components/markdown.ts';
import { getMarkdownTheme, initTheme } from '../packages/coding-agent/src/modes/interactive/theme/theme.ts';

function installProbe(t: any, kind: 'success' | 'throw' | 'reentrant' | 'reentrant-throw') {
  const state = { owner: undefined as Tokenizer | undefined, refs: [] as WeakRef<object>[], nested: false };
  const cause = new Error('lexer fixture failure');
  const original = Tokenizer.prototype.paragraph;
  t.mock.method(Tokenizer.prototype, 'paragraph', function (this: Tokenizer, ...args: Parameters<Tokenizer['paragraph']>) {
    state.owner = this;
    state.refs.push(new WeakRef(this.lexer), new WeakRef(this.lexer.tokens));
    if (kind === 'throw') throw cause;
    if (kind === 'reentrant-throw' && state.nested && args[0].startsWith('inner ')) throw cause;
    if (kind.startsWith('reentrant') && !state.nested) {
      state.nested = true;
      const outer = this.lexer;
      const inner = new Markdown('inner ~~nested~~ paragraph', 0, 0, getMarkdownTheme());
      if (kind === 'reentrant-throw') assert.throws(() => inner.render(120), error => error === cause);
      else inner.render(120);
      inner.invalidate();
      assert.ok(this.lexer === outer, 'nested parsing restores the outer lexer before it continues');
    }
    return original.apply(this, args);
  });
  return { state, cause };
}

function renderAndRelease(kind: string, incremental: boolean, cause: Error) {
  const component = new Markdown('start ~~strike~~ ' + 'x'.repeat(100000), 0, 0, getMarkdownTheme(), undefined, { incrementalRenderCache: incremental });
  const weak = new WeakRef(component);
  if (kind === 'throw') assert.throws(() => component.render(120), error => error === cause);
  else {
    const rendered = component.render(120);
    const fresh = new Markdown('start ~~strike~~ ' + 'x'.repeat(100000), 0, 0, getMarkdownTheme());
    assert.deepEqual(rendered, fresh.render(120));
    fresh.invalidate();
  }
  component.invalidate();
  return weak;
}

for (const incremental of [false, true]) for (const kind of ['success', 'throw', 'reentrant', 'reentrant-throw'] as const) {
  test(`shared Markdown tokenizer releases temporary lexer: ${kind}, incremental=${incremental}`, async (t) => {
    initTheme('dark');
    const { state, cause } = installProbe(t, kind);
    const component = renderAndRelease(kind, incremental, cause);
    assert.ok(state.owner);
    assert.ok(state.owner.lexer === undefined, 'the shared tokenizer must not retain the last session lexer');
    t.mock.reset(); // restoreAll alone retains mock call/stack records in the tracker.
    if (global.gc) {
      for (let pass = 0; pass < 5; pass++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
      assert.ok(component.deref() === undefined, 'released component must be collectible');
      assert.ok(state.refs.every(reference => reference.deref() === undefined), 'lexer/token arrays must be collectible after render/cache release');
    }
  });
}
