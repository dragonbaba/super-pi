import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Cold benchmark setup only. Resolve imports against this checkout, never the
// temporary module or a .git directory (which may be a gitfile in a worktree).
export async function loadMoonshotBenchmarkAdapter(source, label) {
  assert.ok(label === 'baseline' || label === 'candidate');
  const sourceUrl = new URL('../../packages/ai/src/api/openai-completions.ts', import.meta.url);
  const exports = '\nexport { parseChunkUsage' + (source.includes('function getMoonshotCacheWrite1h(')
    ? ', getMoonshotCacheWrite1h' : '') + ' };';
  const compiled = ts.transpileModule(source + exports, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  } }).outputText.replace(/from "([^"]+)"/g, (_match, specifier) =>
    `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const directory = mkdtempSync(join(tmpdir(), 'pi-moonshot-bench-'));
  const modulePath = join(directory, `${label}.mjs`);
  try {
    writeFileSync(modulePath, compiled);
    return { api: await import(pathToFileURL(modulePath).href), modulePath };
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
}
