import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const names = { stream: 'alpha-stream-latency.ts', startup: 'alpha-startup-profile.ts', ansi: 'alpha-ansi.ts', stress: 'alpha-stress-gc.ts' };
const name = names[process.argv[2]];
if (!name) throw new Error('expected stream, startup, ansi, or stress');
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'g2s-bench-'));
try {
  const environment = name === 'alpha-stress-gc.ts' ? {} : { ...process.env };
  if (name === 'alpha-stress-gc.ts') {
    // A heap snapshot must never inherit credentials or unrelated NODE_OPTIONS.
    // Only platform/terminal configuration enters this offline fixture process.
    for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TERM_PROGRAM', 'WT_SESSION', 'NO_COLOR', 'FORCE_COLOR', 'COLORTERM']) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    environment.ALPHA_SANITIZED_HEAP_FIXTURE = '1';
  }
  const result = spawnSync(process.execPath, ['--expose-gc', '--experimental-strip-types', join(repository, 'scripts', 'bench', name), ...process.argv.slice(3)], {
    cwd: repository, env: { ...environment, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: join(root, 'agent'), SP_CODING_AGENT_SESSION_DIR: join(root, 'sessions'), SP_OFFLINE: '1', SP_TUI_WRITE_LOG: '' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + '/') && !target.startsWith(resolve(tmpdir()) + '\\')) throw new Error('unexpected temporary root');
  rmSync(target, { recursive: true, force: true });
}
