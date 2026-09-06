import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantMessageComponent } from '../packages/coding-agent/src/modes/interactive/components/assistant-message.ts';
import { initTheme } from '../packages/coding-agent/src/modes/interactive/theme/theme.ts';
import { scheduledStream } from './helpers/alpha-stream.ts';
import { ALPHA_LATENCY_BODIES } from './helpers/alpha-latency-corpus.ts';

for (const [name, body] of Object.entries(ALPHA_LATENCY_BODIES)) test(`latency marker is observable with a fresh renderer: ${name}`, async () => {
  initTheme('dark');
  const fixture = scheduledStream(40, 0, body);
  try {
    for await (const _event of fixture.start()) { /* Drain the identical scheduled corpus. */ }
    const fresh = new AssistantMessageComponent();
    fresh.updateContent(fixture.message, false);
    assert.ok(fresh.render(120).join('\n').includes('M000039'), 'final marker must exist in a fresh canonical render before measuring physical latency');
  } finally { fixture.cancel(); }
});
