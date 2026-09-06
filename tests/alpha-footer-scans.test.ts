import assert from 'node:assert/strict';
import test from 'node:test';
import { alphaSession } from './helpers/alpha-session.ts';
import { alphaMessage } from './helpers/alpha-stream.ts';

test('footer reuses the existing entries traversal for latest session name', async (t) => {
  const message = alphaMessage([{ type: 'text', text: 'fixture' }]);
  message.usage.cost.total = 2;
  const f = await alphaSession({ messages: [message] });
  let entryCopies = 0;
  const getEntries = f.sessionManager.getEntries.bind(f.sessionManager);
  t.mock.method(f.sessionManager, 'getEntries', () => { entryCopies++; return getEntries(); });
  try {
    for (const name of ['first-name', ' latest-name ', '']) {
      f.sessionManager.appendSessionInfo(name);
      entryCopies = 0;
      const rendered = f.internal.footer.render(120).join('\n');
      assert.equal(entryCopies, 1, 'one existing usage traversal; no second full-history copy for name');
      assert.ok(rendered.includes('$2.000'));
      if (name.trim()) assert.ok(rendered.includes(name.trim()));
      else assert.ok(!rendered.includes('latest-name') && !rendered.includes('first-name'));
    }
  } finally { await f.release(); }
});

test('footer usage traversal does not request an iterator result per history entry', async (t) => {
  const messages = Array.from({ length: 5000 }, () => alphaMessage([{ type: 'text', text: 'completed usage fixture' }]));
  messages[0]!.usage.input = 2500; messages[0]!.usage.cost.total = 1.25;
  const f = await alphaSession({ messages });
  let iteratorResults = 0; let entryCopies = 0;
  try {
    f.sessionManager.appendSessionInfo('retained usage semantics');
    const expected = f.internal.footer.render(120);
    const getEntries = f.sessionManager.getEntries.bind(f.sessionManager);
    t.mock.method(f.sessionManager, 'getEntries', () => {
      const entries = getEntries(); entryCopies++;
      // Instrument only this returned copy; canonical session storage and the
      // native Array prototype remain unchanged. Indexed reads stay ordinary.
      Object.defineProperty(entries, Symbol.iterator, { value: function () {
        const iterator = Array.prototype[Symbol.iterator].call(this);
        return { next() { iteratorResults++; return iterator.next(); }, [Symbol.iterator]() { return this; } };
      } });
      return entries;
    });
    assert.deepEqual(f.internal.footer.render(120), expected);
    assert.equal(entryCopies, 1);
    assert.equal(iteratorResults, 0, 'avoid per-entry iterator protocol work in the measured footer loop');
  } finally { t.diagnostic(JSON.stringify({ history: messages.length, iteratorResults, entryCopies })); await f.release(); }
});
