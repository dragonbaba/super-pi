import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDir } from '../packages/coding-agent/src/config.ts';

for (const mode of ['regular', 'fullscreen']) for (const kind of ['quit', 'ctrl-d', 'double-ctrl-c', 'extension', 'SIGTERM', 'SIGHUP', 'active-stream', 'active-tool', 'active-compaction', 'settings-absent', 'settings-malformed', 'startup-quit', 'stdout-close']) {
  test(`pipe-backed real CLI ${mode}/${kind}`, { skip: process.platform === 'win32' && kind.startsWith('SIG') ? 'Windows kill signals terminate externally; native POSIX signal CI required' : false }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'g2s-cli-'));
    const agent = join(root, 'agent'); mkdirSync(agent);
    const config = getConfigDir(agent); mkdirSync(config);
    const capture = kind === 'quit' || kind.startsWith('settings-') || kind === 'startup-quit' ? join(root, 'startup-capture.jsonl') : '';
    if (kind !== 'settings-absent') writeFileSync(join(config, 'settings.json'), kind === 'settings-malformed' ? '{"quietStartup":' : JSON.stringify({ quietStartup: true, theme: 'dark', compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 } }));
    const child = spawn(process.execPath, ['--import', new URL('./fixtures/alpha-cli-preload.mjs', import.meta.url).href,
      '--import', new URL('../scripts/alpha-startup-capture.mjs', import.meta.url).href,
      fileURLToPath(new URL('../packages/coding-agent/dist/cli.js', import.meta.url)), '--no-session', '--no-extensions', kind === 'active-tool' ? '--no-builtin-tools' : '--no-tools', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--tui-mode', mode, '--extension', fileURLToPath(new URL(kind.startsWith('active-') ? './fixtures/alpha-cli-active-extension.mjs' : './fixtures/alpha-cli-extension.mjs', import.meta.url))], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: join(root, 'sessions'), SP_OFFLINE: '1', SP_TUI_WRITE_LOG: '', SP_ALPHA_STARTUP_CAPTURE: capture, ALPHA_EXIT_KIND: kind }, stdio: 'pipe' });
    let stdout = ''; let stderr = ''; let ready = false; let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', data => {
      stdout += data.toString(); assert.ok(stdout.length <= 1024 * 1024, 'bounded capture');
      if (!ready && stdout.includes('ALPHA_CLI_READY')) {
        ready = true;
        sendTimer = setTimeout(() => {
          if (kind === 'stdout-close') { child.stdout.destroy(); child.stdin.write('/quit\r'); }
          else if (kind.startsWith('active-')) child.stdin.write(kind === 'active-compaction' ? '/alpha-compact\r' : 'fixture\r');
          else if (kind.startsWith('SIG')) child.kill(kind as NodeJS.Signals);
          else if (kind !== 'extension') child.stdin.write(kind === 'quit' ? '/quit\r' : kind === 'ctrl-d' ? '\x04' : '\x03\x03');
        }, 100);
      }
    });
    let quitSent = false;
    child.stderr.on('data', data => {
      stderr += data.toString();
      if (kind.startsWith('active-') && !quitSent && stderr.includes('ALPHA_ACTIVE\n')) {
        quitSent = true; child.stdin.write('/quit\r');
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(ready, true, stderr.slice(-2000));
      t.diagnostic(JSON.stringify({ mode, kind, code, shutdownEmissions: stderr.split('ALPHA_SESSION_SHUTDOWN').length - 1, exitState: stderr.match(/ALPHA_EXIT:[^\n]+/)?.[0] }));
      assert.equal(code, kind === 'stdout-close' ? 129 : 0, stderr.slice(-2000));
      assert.doesNotMatch(stderr, /uncaughtException|disposed ProcessTerminal|UnhandledPromiseRejection/);
      assert.equal(stderr.split('ALPHA_SESSION_SHUTDOWN').length - 1, 1);
      assert.match(stderr, kind === 'stdout-close' ? /ALPHA_EXIT:129:RAW:false/ : /ALPHA_EXIT:0:RAW:false/);
      if (kind === 'settings-malformed') {
        assert.match(stdout + stderr, /Invalid settings file/);
        assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), '{"quietStartup":', 'fallback must not overwrite malformed user settings');
      }
      if (kind.startsWith('active-')) {
        assert.equal(quitSent, true);
        assert.ok(stderr.includes(`ALPHA_ACTIVE_CLEANED:true:REQUESTS:${kind === 'active-compaction' ? 0 : 1}:TOOLS:${kind === 'active-tool' ? 1 : 0}`));
        if (kind === 'active-compaction') assert.match(stderr, /ALPHA_COMPACTION_SETTLED:true/);
      }
      if (kind !== 'stdout-close') assert.ok(stdout.includes('\x1b[?2004l'));
      if (capture) {
        const records = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(records.length < 256);
        assert.equal(records.filter(record => record.phase === 'input-ready').length, kind === 'startup-quit' ? 0 : 1);
        if (kind === 'startup-quit') assert.equal(records.filter(record => record.phase === 'startup-cancelled').length, 1);
        assert.ok(records.some(record => record.phase === 'tui-start'));
        for (const record of records) {
          assert.deepEqual(Object.keys(record).sort(), ['duration', 'generation', 'phase']);
          assert.equal(typeof record.duration, 'number'); assert.equal(typeof record.generation, 'number');
          assert.match(record.phase, /^[a-z-]+$/);
        }
      }
      t.diagnostic(JSON.stringify({ mode, kind, code, rawRestored: true, terminalRestoreDelivered: kind !== 'stdout-close', nativePty: false }));
    } finally {
      clearTimeout(timeout); if (sendTimer) clearTimeout(sendTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
