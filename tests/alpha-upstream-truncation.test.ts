import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, basename } from 'node:path';
import test from 'node:test';
import { createPowerShellTool } from '../packages/coding-agent/src/core/tools/powershell.ts';
import { createToolResultPresentationOwner } from '../packages/coding-agent/src/core/tool-result-presentation.ts';
import { g2_raw_result_probe } from './fixtures/g2-raw-result-probe.ts';

test('PowerShell upstream/tool-level truncation is distinct from G2 model-view truncation', async () => {
  const raw = g2_raw_result_probe('large');
  const block = raw.content[0]; assert.equal(block.type, 'text');
  if (block.type !== 'text') throw new Error('missing fixture text');
  let deliveredBytes = 0;
  // Only process execution is injected. The real PowerShell tool, accumulator,
  // spill-file close and tool truncation run before the G2 owner sees anything.
  const tool = createPowerShellTool(process.cwd(), { exposeSessionEnvironment: false, operations: {
    async exec(_command, _cwd, options) {
      const bytes = Buffer.from(block.text); deliveredBytes = bytes.length;
      options.onData(bytes); return { exitCode: 0 };
    },
  } });
  const result = await tool.execute('upstream-powershell', { command: 'fixture' });
  const path = result.details?.fullOutputPath;
  assert.ok(path);
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  assert.match(basename(path), /^sp-powershell-[a-f0-9]+\.log$/);
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, 'upstream-session')!;
  try {
    assert.equal(deliveredBytes, 262144);
    assert.equal(result.details?.truncation?.truncated, true);
    assert.equal(result.details?.truncation?.totalBytes, deliveredBytes);
    assert.ok(result.details!.truncation!.outputBytes <= 50 * 1024);
    assert.equal(readFileSync(path, 'utf8'), block.text);
    const text = result.content[0]; assert.equal(text.type, 'text');
    if (text.type !== 'text') throw new Error('missing tool text');
    assert.ok(!text.text.includes(raw.details.markers[0]!));
    const view = owner.create(result.content, 'upstream-powershell')!;
    owner.release();
    assert.deepEqual(view.uiContent, result.content);
    assert.equal(view.version, 2);
    if (view.version !== 2) throw new Error('expected model projection');
    assert.ok(view.artifact);
    assert.equal(view.truncation.originalTextCodeUnits, text.text.length);
    assert.ok(view.truncation.modelEstimatedTokens <= 1024);
    const message = { role: 'toolResult' as const, toolCallId: 'upstream-powershell', toolName: 'powershell', content: result.content, isError: false, timestamp: 1 };
    assert.deepEqual(owner.readArtifact(view.artifact.id, [message]).content, result.content);
    assert.notEqual(text.text, block.text, 'G2 canonical source is the already truncated tool result');
    assert.equal(readFileSync(path, 'utf8'), block.text, 'upstream artifact remains independently available');
  } finally {
    owner.dispose();
    unlinkSync(path);
    if (existsSync(path + '.sp-owned')) unlinkSync(path + '.sp-owned');
  }
});
