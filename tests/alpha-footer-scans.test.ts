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
