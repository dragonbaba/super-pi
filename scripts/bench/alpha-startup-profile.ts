import { Session } from 'node:inspector/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAgentSession } from '../../packages/coding-agent/src/core/sdk.ts';
import { SettingsManager } from '../../packages/coding-agent/src/core/settings-manager.ts';
import { SessionManager } from '../../packages/coding-agent/src/core/session-manager.ts';
import { DefaultResourceLoader } from '../../packages/coding-agent/src/core/resource-loader.ts';
import { alphaModelRuntime } from '../../tests/helpers/alpha-session.ts';

const root = mkdtempSync(join(tmpdir(), 'alpha-startup-profile-'));
const runtime = alphaModelRuntime();
runtime.getAvailableSnapshot = () => [];
const settings = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await loader.reload();
const inspector = new Session(); inspector.connect();
try {
  await inspector.post('Profiler.enable');
  await inspector.post('Profiler.setSamplingInterval', { interval: 100 });
  await inspector.post('Profiler.start');
  await inspector.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  let failures = 0; let successes = 0; let cause = '';
  for (let i = 0; i < 100; i++) {
    try {
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: settings, sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: 'all' });
      successes++; session.dispose();
    } catch (error) { failures++; cause = error instanceof Error ? error.message : String(error); }
  }
  const { profile } = await inspector.post('Profiler.stop');
  const heap = await inspector.post('HeapProfiler.stopSampling');
  const sites: { function: string; bytes: number }[] = [];
  const pending = [heap.profile.head];
  while (pending.length) { const node = pending.pop()!; sites.push({ function: node.callFrame.functionName, bytes: node.selfSize }); pending.push(...node.children); }
  console.log(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), attempts: 100, failures, successes, cause,
    cpu: profile.nodes.filter(node => node.callFrame.functionName.includes('rebuildSystemPrompt') || node.callFrame.functionName.includes('ModelCapabilities') || node.callFrame.functionName === 'AgentSession').map(node => ({ function: node.callFrame.functionName, hitCount: node.hitCount })),
    allocations: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 15) }));
} finally { inspector.disconnect(); rmSync(root, { recursive: true, force: true }); }
