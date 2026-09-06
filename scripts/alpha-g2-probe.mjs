import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'super-pi-g2s-'));
const agent = join(root, 'agent');
const sessions = join(root, 'sessions');
mkdirSync(agent);
mkdirSync(sessions);
try {
  const files = process.argv.slice(2);
  const streamingFiles = ['tests/alpha-stream-stress.test.ts', 'tests/alpha-stream-corpus.test.ts', 'tests/alpha-stream-endings.test.ts', 'tests/alpha-stream-markers.test.ts', 'tests/alpha-assistant-update.test.ts', 'tests/alpha-retained-active.test.ts', 'tests/alpha-cli.test.ts', 'tests/alpha-active-quit.test.ts', 'tests/alpha-compaction-quit.test.ts', 'tests/alpha-session-replacement.test.ts'];
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', '--test',
    ...((files.length ? files : [...streamingFiles, 'tests/alpha-g2-raw.test.ts', 'tests/alpha-ansi.test.ts', 'tests/alpha-raw-session.test.ts', 'tests/alpha-raw-parallel.test.ts', 'tests/alpha-image.test.ts', 'tests/alpha-upstream-truncation.test.ts', 'tests/alpha-footer-scans.test.ts', 'tests/alpha-lifecycle.test.ts', 'tests/alpha-runtime-dispose.test.ts', 'tests/alpha-startup-quit.test.ts', 'tests/alpha-crash-cleanup.test.ts', 'tests/alpha-startup-faults.test.ts']).map(file => resolve(repository, file)))], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
      SP_CODING_AGENT_DIR: agent, SP_CODING_AGENT_SESSION_DIR: sessions, SP_OFFLINE: '1', SP_TUI_WRITE_LOG: '' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // Only the exact directory created above is owned by this invocation.
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('temporary root escaped');
  rmSync(target, { recursive: true, force: true });
}
