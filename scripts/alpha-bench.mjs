import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const names = { stream: 'alpha-stream-latency.ts', startup: 'alpha-startup-profile.ts', ansi: 'alpha-ansi.ts' };
const name = names[process.argv[2]];
if (!name) throw new Error('expected stream, startup, or ansi');
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'g2s-bench-'));
try {
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', join(repository, 'scripts', 'bench', name), ...process.argv.slice(3)], {
    cwd: repository, env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: join(root, 'agent'), SP_CODING_AGENT_SESSION_DIR: join(root, 'sessions'), SP_OFFLINE: '1', SP_TUI_WRITE_LOG: '' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + '/') && !target.startsWith(resolve(tmpdir()) + '\\')) throw new Error('unexpected temporary root');
  rmSync(target, { recursive: true, force: true });
}
