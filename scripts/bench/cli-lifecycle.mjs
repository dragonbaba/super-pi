import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A diagnostic, not a default CI test. The caller owns TMP/TEMP/TMPDIR under
// .task-tmp and retains the scalar report before removing its exact task root.
const repository = fileURLToPath(new URL('../../', import.meta.url));
function integerOption(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = Number(process.argv[index + 1]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + ' must be a positive integer');
    return value;
}
const samples = integerOption('--samples', 30);
const warmup = integerOption('--warmup', 2);
const taskRoot = fs.realpathSync(tmpdir());
const taskParent = fs.realpathSync(path.join(repository, '.task-tmp'));
const taskRelative = path.relative(taskParent, taskRoot);
assert.ok(taskRelative && !taskRelative.startsWith('..') && !path.isAbsolute(taskRelative), 'Use a task-owned TMP/TEMP/TMPDIR under .task-tmp');
for (const name of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(fs.realpathSync(process.env[name]), taskRoot);
const root = fs.mkdtempSync(path.join(taskRoot, 'cli-lifecycle-'));
const resultPath = path.join(root, 'results.json');
const ownersPath = path.join(root, 'processes.json');
const rows = [], owners = [];
function persistOwners() { fs.writeFileSync(ownersPath, JSON.stringify(owners, null, 2)); }
function summarize(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return { samples: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
        p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], minMs: sorted[0], maxMs: sorted.at(-1),
        meanMs: mean, coefficientOfVariation: Math.sqrt(variance) / mean };
}
async function runOne(resources, mode, probe, round) {
    const label = `${resources}-${mode}-${probe ? 'probe' : 'plain'}`;
    const home = path.join(root, label + '-' + round), agent = path.join(home, 'agent');
    fs.mkdirSync(path.join(agent, 'config'), { recursive: true });
    fs.writeFileSync(path.join(agent, 'config/settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark',
        terminal: { showTerminalProgress: false }, compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 } }));
    const args = ['--import', new URL('../../tests/fixtures/alpha-cli-preload.mjs', import.meta.url).href];
    if (probe) args.push('--import', new URL('./cli-lifecycle-probe.mjs', import.meta.url).href);
    args.push(path.join(repository, 'scripts/superpi.mjs'), '--offline', '--no-session');
    if (resources === 'minimal') args.push('--no-extensions', '--no-tools', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes');
    args.push('--tui-mode', mode, '--extension', fileURLToPath(new URL('./cli-lifecycle-extension.mjs', import.meta.url)));
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT, TMP: taskRoot, TEMP: taskRoot, TMPDIR: taskRoot,
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'), SP_OFFLINE: '1', SP_SKIP_VERSION_CHECK: '1', SP_TUI_WRITE_LOG: '' };
    const started = performance.now();
    const child = spawn(process.execPath, args, { cwd: home, env, windowsHide: true, stdio: 'pipe' });
    const owner = { pid: child.pid, label, round, started: new Date().toISOString(), settled: false };
    owners.push(owner); persistOwners();
    let stdout = '', stderr = '', pending = '', titleAt, ackAt, quitAt, quitTimer, timeoutHit = false, launchError, resourceCounts;
    const phases = [];
    const timeout = setTimeout(() => { timeoutHit = true; child.kill(); }, 20_000);
    child.stdout.on('data', data => {
        stdout += data.toString();
        if (stdout.length > 1024 * 1024) { launchError = new Error('Unbounded stdout capture'); child.kill(); return; }
        if (titleAt === undefined && stdout.includes('PF_SESSION_START')) {
            titleAt = performance.now();
            child.stdin.write('/pf-lifecycle-ready\r');
        }
    });
    child.stdin.on('error', error => { launchError ??= error; });
    child.stderr.on('data', data => {
        const text = data.toString(); stderr += text; pending += text;
        if (stderr.length > 256 * 1024) { launchError = new Error('Unbounded stderr capture'); child.kill(); return; }
        for (;;) {
            const end = pending.indexOf('\n'); if (end < 0) break;
            const line = pending.slice(0, end).trimEnd(); pending = pending.slice(end + 1);
            try {
                if (line.startsWith('PF_PHASE:')) phases.push(JSON.parse(line.slice(9)));
                if (line.startsWith('PF_INPUT_ACK:')) resourceCounts = JSON.parse(line.slice(13));
            } catch (error) { launchError = error; child.kill(); return; }
            if (line.startsWith('PF_INPUT_ACK:') && ackAt === undefined) {
                ackAt = performance.now();
                // Fixed settling time is excluded from both reported intervals.
                quitTimer = setTimeout(() => { quitAt = performance.now(); child.stdin.write('/quit\r'); }, 100);
            }
        }
    });
    const code = await new Promise(resolve => {
        child.once('error', error => { launchError = error; });
        child.once('close', resolve);
    });
    const closedAt = performance.now();
    clearTimeout(timeout); clearTimeout(quitTimer);
    owner.settled = true; owner.code = code; owner.finished = new Date().toISOString(); persistOwners();
    assert.ifError(launchError);
    assert.equal(timeoutHit, false, stderr.slice(-3000));
    assert.equal(code, 0, stderr.slice(-3000));
    assert.doesNotMatch(stdout + stderr, /Failed to load extension|Extension path does not exist|UnhandledPromiseRejection|uncaughtException/);
    assert.ok(titleAt !== undefined && ackAt !== undefined && quitAt !== undefined, stderr.slice(-3000));
    assert.equal(stderr.split('PF_INPUT_ACK').length - 1, 1);
    assert.equal(stderr.split('PF_SESSION_SHUTDOWN').length - 1, 1, stderr.slice(-3000));
    assert.ok(stderr.includes('ALPHA_EXIT:0:RAW:false'), stderr.slice(-3000));
    assert.ok(stdout.includes('\x1b[?2004l'), 'Bracketed paste restored');
    assert.ok(resourceCounts.commands > 0);
    if (resources === 'minimal') assert.equal(resourceCounts.activeTools, 0);
    else assert.ok(resourceCounts.activeTools > 0, 'Bundled arm must retain active tools');
    if (mode === 'fullscreen') assert.ok(stdout.includes('\x1b[?1049l'), 'Alternate screen restored');
    if (probe) {
        assert.equal(phases.filter(row => row.phase === 'init-complete').length, 1);
        assert.equal(phases.filter(row => row.phase === 'init-cancelled').length, 0);
    }
    return { resources, mode, probe, round, warmup: round < warmup, titleMs: titleAt - started,
        inputAckMs: ackAt - started, quitToCloseMs: closedAt - quitAt, phases, resourceCounts,
        rawRestored: true, bracketedPasteRestored: true, alternateRestored: mode === 'fullscreen', shutdownEmissions: 1 };
}
const cases = [];
for (const resources of ['minimal', 'bundled']) for (const mode of ['regular', 'fullscreen']) for (const probe of [false, true]) cases.push({ resources, mode, probe });
for (let round = 0; round < warmup + samples; round++) {
    // Reverse on alternate rounds to expose ordering drift without concurrency.
    const ordered = round % 2 === 0 ? cases : cases.slice().reverse();
    for (const item of ordered) rows.push(await runOne(item.resources, item.mode, item.probe, round));
    fs.writeFileSync(resultPath, JSON.stringify({ complete: false, rows }, null, 2));
    process.stderr.write(`Completed lifecycle round ${round + 1}/${warmup + samples}\n`);
}
const summary = cases.map(item => {
    const selected = rows.filter(row => !row.warmup && row.resources === item.resources && row.mode === item.mode && row.probe === item.probe);
    return { ...item, inputAck: summarize(selected.map(row => row.inputAckMs)), quitToClose: summarize(selected.map(row => row.quitToCloseMs)) };
});
fs.writeFileSync(resultPath, JSON.stringify({ complete: true, schemaVersion: 1, node: process.version, samplesPerCase: samples, warmupPerCase: warmup,
    scope: 'Fresh isolated HOME, shared task tmp transpiler cache, source launcher, pipe-backed terminal. Input ACK is an executed extension command, not merely session_start or fully completed startup. No live provider or sandbox work. Probe changes import order. Settling delay 100ms excluded.',
    summary, rows }, null, 2));
console.log(JSON.stringify({ resultPath, ownersPath, summary }, null, 2));
