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

test('footer extension status callbacks have stable identities across renders', async (t) => {
  const f = await alphaSession();
  const comparisons = new Set<unknown>(); const transforms = new Set<unknown>();
  const sort = Array.prototype.sort; const map = Array.prototype.map; const from = Array.from;
  function isStatusList(value: any[]) { return Array.isArray(value[0]) && typeof value[0][0] === 'string' && value[0][0].startsWith('g2s-status-'); }
  try {
    f.internal.footerDataProvider.setExtensionStatus('g2s-status-z', ' second\nline ');
    f.internal.footerDataProvider.setExtensionStatus('g2s-status-a', ' first\tline ');
    const expected = f.internal.footer.render(120);
    assert.ok(expected[2].includes('first line second line'));
    t.mock.method(Array as any, 'from', function (this: any, ...args: any[]) {
      const result = Reflect.apply(from, this, args);
      if (isStatusList(result)) {
        // Instrument only the copied status array, never Array.prototype.
        Object.defineProperty(result, 'sort', { value: function (this: any[], compare: any) {
          comparisons.add(compare); return sort.call(this, compare);
        } });
        Object.defineProperty(result, 'map', { value: function (this: any[], transform: any, receiver: any) {
          transforms.add(transform); return map.call(this, transform, receiver);
        } });
      }
      return result;
    });
    for (let render = 0; render < 3; render++) assert.deepEqual(f.internal.footer.render(120), expected);
    assert.equal(comparisons.size, 1, 'one stable status comparator, not one closure per render');
    assert.equal(transforms.size, 1, 'one stable sanitizer callback, not one closure per render');
  } finally { t.mock.reset(); t.diagnostic(JSON.stringify({ renders: 3, comparators: comparisons.size, transforms: transforms.size })); await f.release(); }
});
