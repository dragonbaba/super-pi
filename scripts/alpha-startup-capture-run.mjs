import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'g2s-startup-capture-'));
const home = join(root, 'home');
const report = join(root, 'startup-phases.jsonl');
try {
  const child = spawnSync(process.execPath, ['--import', new URL('./alpha-startup-capture.mjs', import.meta.url).href,
    fileURLToPath(new URL('../packages/coding-agent/dist/cli.js', import.meta.url)), '--no-session', ...process.argv.slice(2)], {
    cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
      SP_CODING_AGENT_DIR: join(home, 'agent'), SP_CODING_AGENT_SESSION_DIR: join(home, 'sessions'),
      SP_OFFLINE: '1', SP_TUI_WRITE_LOG: '', SP_ALPHA_STARTUP_CAPTURE: report },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
  console.log(`Alpha startup phase report: ${report}`);
} finally {
  // Retain only the explicitly reported scalar capture, never temporary config.
  const target = resolve(home);
  if (target !== join(resolve(root), 'home')) throw new Error('unexpected capture home');
  rmSync(target, { recursive: true, force: true });
}
