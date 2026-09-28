import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const project = resolve(process.env.SP_INCIDENT_PROJECT ?? fileURLToPath(new URL('../', import.meta.url)));
const globalEntry = process.env.SP_INCIDENT_GLOBAL_ENTRY;
const commands = JSON.parse(fs.readFileSync(join(fixtures, 'shell-incident-commands.json'), 'utf8'));
const bridged = commands[1].replace('\nNODE', '\n// paired-backslash transport control: \\\\\nNODE');
const html = '<svg><g id="test"></g><use href="#test"/></svg><script>const x=1;</script>';
const sentinel = 'NONEMPTY_SENTINEL';
const { getShellConfig } = await import(pathToFileURL(join(project, 'packages/coding-agent/dist/utils/shell.js')).href);
const shell = process.env.SP_INCIDENT_BASH ?? getShellConfig().shell;
function snapshot(cwd) {
  return fs.readdirSync(cwd).sort().map(name => ({ name, bytes: fs.readFileSync(join(cwd, name)).toString('base64') }));
}

function runFixture(t, { name, command, preexisting, denied = false, shim, broken = false, refused = false, redirect = false }) {
  const root = fs.mkdtempSync(join(tmpdir(), 'sp-shell-incident-'));
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    if (process.env.SP_INCIDENT_KEEP === '1') t.diagnostic(`retained evidence: ${root}`);
    else fs.rmSync(root, { recursive: true });
  });
  const cwd = join(root, 'work'), agent = join(root, 'agent'), report = join(root, 'report.jsonl');
  fs.mkdirSync(cwd); fs.mkdirSync(join(agent, 'config'), { recursive: true });
  fs.writeFileSync(join(agent, 'config/settings.json'), JSON.stringify({ shellPath: shell, compaction: { enabled: false }, retry: { enabled: false } }));
  fs.writeFileSync(join(cwd, 'superman-ride.html'), html);
  if (preexisting) fs.writeFileSync(join(cwd, 'm[1])'), sentinel);
  const before = snapshot(cwd);
  const call = { type: 'toolCall', id: name, name: 'bash', arguments: { command, cwd, purpose: 'Synthetic shell side-effect regression' } };
  const callPath = join(root, 'call.json'); fs.writeFileSync(callPath, JSON.stringify(call));
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  if (!globalEntry) env[pathKey] = `${shim ?? dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
  Object.assign(env, { SP_CODING_AGENT_DIR: agent, SP_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'), SP_OFFLINE: '1',
    SP_INCIDENT_PROJECT: project, SP_INCIDENT_REPORT: report, SP_INCIDENT_CALL: callPath, SP_INCIDENT_DENY: denied ? '1' : '0',
    NODE_OPTIONS: `--require=${JSON.stringify(join(fixtures, 'shell-incident-consumer.cjs'))}` });
  const cliArgs = ['--offline', '--no-session', '--mode', 'json', '--provider', 'shell-incident-fixture',
    '--model', 'fixture', '--extension', join(fixtures, 'shell-incident-provider.mjs'), 'Run only this synthetic fixture once.'];
  let executable = process.execPath, args = ['--import', pathToFileURL(join(fixtures, 'shell-incident-preload.mjs')).href,
    join(project, 'scripts/superpi.mjs'), ...cliArgs];
  if (globalEntry) {
    assert.equal(process.platform, 'win32'); assert.equal(shim, undefined, 'global mode must use inherited PATH');
    const words = [globalEntry, ...cliArgs];
    for (const word of words) assert.doesNotMatch(word, /["%!?\r\n]/u, 'unsupported cmd launcher argument');
    executable = join(env.SystemRoot ?? env.WINDIR, 'System32', 'cmd.exe');
    args = ['/d', '/s', '/c', '"' + words.map(word => `"${word}"`).join(' ') + '"'];
    env.NODE_OPTIONS += ` --import=${pathToFileURL(join(fixtures, 'shell-incident-global-preload.mjs')).href}`;
  }
  // Verbatim cmd syntax is confined to invoking the global .cmd launcher in this
  // fixture. The actual Bash tool's unchanged spawn options are asserted below.
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    windowsVerbatimArguments: !!globalEntry, maxBuffer: 2 * 1024 * 1024 });
  const after = snapshot(cwd);
  fs.writeFileSync(join(root, 'inventory.json'), JSON.stringify({ before, after, globalEntry, inheritedPath: !!globalEntry }));
  fs.writeFileSync(join(root, 'stdout.log'), child.stdout ?? '');
  fs.writeFileSync(join(root, 'stderr.log'), child.stderr ?? '');
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const events = fs.readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse);
  const wire = child.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const resultEvent = wire.find(event => event.type === 'tool_execution_end' && event.toolCallId === name);
  assert.ok(resultEvent, child.stdout);
  const result = resultEvent.result, facts = result.details.shellExecution;
  const spawns = events.filter(event => event.phase === 'spawn');
  const approvals = events.filter(event => event.phase === 'approval');
  const release = events.find(event => event.phase === 'release');
  const exit = events.find(event => event.phase === 'exit');
  assert.equal(exit.network, 0); assert.equal(release.pending, 0); assert.equal(release.authorizations, 0);
  assert.equal(exit.launcher, join(project, 'scripts/superpi.mjs'));
  assert.equal(wire.filter(event => event.type === 'tool_execution_end').length, 1, 'no retry');
  if (denied || refused) {
    assert.equal(resultEvent.isError, true); assert.equal(spawns.length, 0);
    assert.equal(facts.started, false); assert.equal(facts.sideEffects, 'none'); assert.deepEqual(after, before);
    assert.equal(approvals.length, denied ? 1 : 0);
    return;
  }
  assert.equal(spawns.length, 1); assert.equal(facts.started, true);
  assert.equal(facts.sideEffects, 'unknown'); assert.equal(facts.retryGuidance, 'inspect_before_retry');
  assert.equal(spawns[0].shell, false); assert.equal(spawns[0].windowsVerbatimArguments, false);
  if (name === 'bridge' && process.platform === 'win32') assert.equal(typeof spawns[0].bridge, 'string');
  const transported = spawns[0].bridge ? Buffer.from(spawns[0].bridge, 'base64').toString() : spawns[0].args.at(-1);
  assert.equal(transported, command, 'approved original input reaches shell unchanged');
  if (!redirect) {
    assert.equal(approvals.length, 1);
    const approved = JSON.parse(approvals[0].details.split('完整请求:\n').at(-1));
    assert.deepEqual(approved, call.arguments);
  }
  assert.equal(fs.readFileSync(join(cwd, 'superman-ride.html'), 'utf8'), html);
  if (broken) {
    assert.equal(resultEvent.isError, true); assert.equal(facts.exitCode, 255);
    assert.equal(fs.statSync(join(cwd, 'm[1])')).size, 0);
    assert.deepEqual(after.map(entry => entry.name), ['m[1])', 'superman-ride.html']);
  } else if (redirect) {
    assert.equal(facts.exitCode, 0); assert.equal(fs.readFileSync(join(cwd, 'authorized.txt'), 'utf8'), 'authorized');
    assert.equal(fs.readFileSync(join(cwd, 'm[1])'), 'utf8'), sentinel);
    assert.deepEqual(after.map(entry => entry.name), ['authorized.txt', 'm[1])', 'superman-ride.html']);
  } else {
    assert.equal(resultEvent.isError, false); assert.equal(facts.exitCode, 0); assert.deepEqual(after, before);
    const consumer = events.find(event => event.phase === 'consumer'); assert.ok(consumer, 'real Node received input');
    const expected = command.startsWith('node -e ') ? command.slice(9, -1).replaceAll('\\"', '"')
      : command.slice(command.indexOf('\n') + 1, command.lastIndexOf('\n') + 1);
    assert.equal(Buffer.from(consumer.source, 'base64').toString(), expected, 'Node script bytes match approved input after Bash semantics');
  }
}

for (const preexisting of [false, true]) for (const index of [0, 1]) {
  test(`launcher ${globalEntry ? 'installed global' : 'native'} ${index === 0 ? 'node-e' : 'heredoc'} / sentinel=${preexisting}`, { timeout: 40000 }, t =>
    runFixture(t, { name: `native-${preexisting}-${index}`, command: commands[index], preexisting }));
}
test('launcher denied approval: no spawn or file change', { timeout: 40000 }, t =>
  runFixture(t, { name: 'denied', command: commands[0], preexisting: true, denied: true }));
test('launcher paired-backslash bridge preserves heredoc bytes and files', { timeout: 40000 }, t =>
  runFixture(t, { name: 'bridge', command: bridged, preexisting: true, shim: process.env.SP_INCIDENT_SHIM }));
test('launcher preflight refusal: no spawn, approval or file change', { timeout: 40000 }, t =>
  runFixture(t, { name: 'preflight', command: "node -n <<'NODE'\nconsole.log('unreachable')\nNODE", preexisting: true, refused: true }));
test('launcher authorized external redirection retains normal semantics', { timeout: 40000 }, t =>
  runFixture(t, { name: 'redirect', command: "printf authorized > authorized.txt", preexisting: true, redirect: true }));
if (process.env.SP_INCIDENT_SHIM) for (const preexisting of [false, true]) for (const index of [0, 1]) {
  test(`launcher explicit shim ${index} / sentinel=${preexisting}`, { timeout: 40000 }, t =>
    runFixture(t, { name: `shim-${preexisting}-${index}`, command: commands[index], preexisting,
      shim: process.env.SP_INCIDENT_SHIM, broken: index === 0 && process.env.SP_INCIDENT_EXPECT_BROKEN === '1' }));
}
