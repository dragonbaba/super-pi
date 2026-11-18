import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

const python = process.env.SP_TEST_WINDOWS_PYTHON;
const repo = fileURLToPath(new URL("../", import.meta.url));

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function waitFor(predicate, description) {
  const deadline = performance.now() + 5_000;
  while (!predicate() && performance.now() < deadline) await delay(40);
  assert.ok(predicate(), description);
}

test("the last Windows Super Pi CLI stops its search job, including descendants and late startup", {
  skip: process.platform !== "win32" || !python,
  timeout: 30_000,
}, async t => {
  const owned = createOwnedTaskFixture("searxng-lifetime-");
  const appData = join(owned.root, "local");
  const install = join(appData, "SuperPi", "SearXNG");
  const runtime = join(install, "superpi-runtime");
  const venv = join(install, "venv");
  const interpreter = join(venv, "Scripts", "python.exe");
  const entry = join(install, "serve.py");
  const ready = join(install, "ready");
  const bootstrap = join(repo, "packages", "extensions", "web-search", "managed-service.py");
  const env = {
    ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root, LOCALAPPDATA: appData,
    HOME: owned.root, USERPROFILE: owned.root, XDG_CONFIG_HOME: owned.root, SP_OFFLINE: "1",
    SP_CODING_AGENT_DIR: join(owned.root, "agent"), SP_CODING_AGENT_SESSION_DIR: join(owned.root, "sessions"),
    SP_SEARXNG_URL: "http://127.0.0.1:8888", OPENAI_API_KEY: "offline-test-placeholder",
  };
  const children = [];
  function start(exe, args, cwd, childEnv = env) {
    const child = spawn(exe, args, { cwd, env: childEnv, windowsHide: true, stdio: "pipe" });
    const state = { child, stderr: "", closed: once(child, "exit") };
    child.stderr.setEncoding("utf8").on("data", part => { state.stderr += part; });
    children.push(state);
    return state;
  }
  async function exit(state) {
    state.child.stdin.end();
    const [code] = await state.closed;
    assert.equal(code, 0, state.stderr);
    assert.doesNotMatch(state.stderr, /Managed SearXNG shutdown/);
  }
  async function startCli(id, cwd, childEnv) {
    const state = start(process.execPath, [
      join(repo, "packages", "coding-agent", "dist", "cli.js"), "--mode", "rpc", "--no-session", "--no-mcp",
      "--no-extensions", "--extension", join(repo, "packages", "extensions", "web-search", "index.ts"),
    ], cwd, childEnv);
    const lines = createInterface({ input: state.child.stdout });
    let ready = false;
    lines.on("line", line => {
      try { const message = JSON.parse(line); ready ||= message.id === id && message.success === true; }
      catch { /* non-RPC startup output */ }
    });
    state.child.stdin.write(JSON.stringify({ id, type: "get_state" }) + "\n");
    await waitFor(() => ready || state.child.exitCode !== null, "CLI did not finish starting");
    assert.ok(ready, state.stderr);
    return state;
  }
  t.after(async () => {
    for (const { child } of children) if (!child.stdin.destroyed) child.stdin.end();
    if (existsSync(interpreter) && existsSync(runtime)) {
      spawnSync(interpreter, ["-X", "utf8", bootstrap, "stop", runtime], { cwd: install, env, windowsHide: true, timeout: 4000 });
    }
    for (const { child, closed } of children) {
      try {
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, "fixture process did not close");
      } catch {
        child.kill();
      }
      await closed;
    }
    owned.cleanup();
  });

  mkdirSync(join(install, "tmp"), { recursive: true });
  writeFileSync(join(install, "install.json"), "{}");
  const environment = spawnSync(python, ["-m", "venv", "--without-pip", venv], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(environment.status, 0, environment.error?.message ?? environment.stderr);
  writeFileSync(entry, `import os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(25)"])
Path("ready").write_text(f"{os.getpid()} {child.pid}", encoding="ascii")
time.sleep(25)
`);
  const otherProject = join(owned.root, "other-project");
  mkdirSync(otherProject);
  const [first, second] = await Promise.all([
    startCli("first", owned.root, env),
    startCli("second", otherProject, { ...env, SP_CODING_AGENT_DIR: join(owned.root, "other-agent"), SP_SEARXNG_URL: undefined }),
  ]);
  assert.equal(readdirSync(runtime).filter(name => name.endsWith(".json")).length, 2);
  assert.equal(readdirSync(runtime).filter(name => name.endsWith(".job")).length, 0);

  const marker = join(runtime, `searxng-${randomUUID()}.job`);
  const lateMarker = join(runtime, `searxng-${randomUUID()}.job`);
  for (const record of [marker, lateMarker]) writeFileSync(record, "", { flag: "wx" });
  const service = start(interpreter, ["-X", "utf8", bootstrap, "serve", entry, marker], install);
  await waitFor(() => existsSync(ready), "job did not start");
  const [worker, descendant] = readFileSync(ready, "ascii").split(" ").map(Number);
  assert.ok(processIsAlive(worker) && processIsAlive(descendant));
  await exit(first);
  assert.ok(processIsAlive(worker) && processIsAlive(descendant));
  assert.equal(readdirSync(runtime).filter(name => name.endsWith(".json")).length, 1);

  const before = performance.now();
  await exit(second);
  await service.closed;
  await waitFor(() => !processIsAlive(worker) && !processIsAlive(descendant), "job members remained alive");
  assert.deepEqual(readdirSync(runtime), []);
  t.diagnostic(`Last CLI exit and job stop took ${Math.round(performance.now() - before)} ms`);

  const lateEntry = join(install, "late.py");
  writeFileSync(lateEntry, 'from pathlib import Path\nPath("late-service").touch()\n');
  await exit(start(interpreter, ["-X", "utf8", bootstrap, "serve", lateEntry, lateMarker], install));
  assert.equal(existsSync(join(install, "late-service")), false);
});
