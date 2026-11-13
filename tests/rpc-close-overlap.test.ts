import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const CLEANUP_ALLOWANCE_MS = 5_000;

for (const kind of ["eof", "eof-error", "sigterm", "sigterm-first"]) {
  test(`RPC overlap ${kind}: join real shutdown before exit`, {
    timeout: STARTUP_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS + CLEANUP_ALLOWANCE_MS,
    skip: process.platform === "win32" && kind.startsWith("sigterm") ? "Windows kill does not deliver POSIX SIGTERM" : false,
  }, async t => {
    const started = performance.now();
    const root = mkdtempSync(join(tmpdir(), "rpc-close-"));
    const agent = join(root, "agent"); mkdirSync(agent);
    const config = getConfigDir(agent); mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import",
      new URL("./fixtures/rpc-close-overlap-preload.mjs", import.meta.url).href,
      fileURLToPath(new URL("../packages/coding-agent/src/cli.ts", import.meta.url)),
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--extension", fileURLToPath(new URL("./fixtures/rpc-close-overlap-extension.mjs", import.meta.url))], {
      cwd: root, stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "", RPC_CLOSE_CASE: kind },
    });
    const input = child.stdin, output = child.stdout, errors = child.stderr;
    assert.ok(input && output && errors);
    writeFileSync(join(root, "resources.json"), JSON.stringify({ root, childPid: child.pid, startedAt: new Date().toISOString(), purpose: kind }));
    let stdout = "", stderr = "", ready = false, overlapped = false, released = false, timedOut = false;
    let readyMs: number | undefined, gateMs: number | undefined, releaseMs: number | undefined;
    let watchdog = setTimeout(killOwnedChild, STARTUP_TIMEOUT_MS);
    function killOwnedChild() { timedOut = true; child.kill("SIGKILL"); }
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    output.on("data", data => {
      stdout += data.toString();
      if (stdout.length > 1024 * 1024) killOwnedChild();
      if (!ready && stdout.includes("CLOSE_READY")) {
        ready = true; readyMs = performance.now() - started;
        clearTimeout(watchdog); watchdog = setTimeout(killOwnedChild, SHUTDOWN_TIMEOUT_MS);
        if (kind === "sigterm-first") child.kill("SIGTERM");
      }
    });
    errors.on("data", data => {
      stderr += data.toString();
      if (stderr.length > 1024 * 1024) killOwnedChild();
      if (!overlapped && stderr.includes("CLOSE_GATE\n")) {
        overlapped = true;
        gateMs = performance.now() - started;
        if (kind === "sigterm") child.kill("SIGTERM"); else input.end();
      }
      const receipt = kind === "sigterm" ? "CLOSE_SIGNAL\n" : "CLOSE_EOF\n";
      if (overlapped && !released && stderr.includes(receipt)) {
        released = true;
        releaseMs = performance.now() - started;
        if (child.connected) child.send("release", () => {}); // A failing baseline may already be exiting.
      }
    });
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      removeOwnedFixture(root);
    });
    const result = await closed;
    clearTimeout(watchdog);
    const elapsedMs = performance.now() - started;
    t.diagnostic(JSON.stringify({ kind, elapsedMs, readyMs, gateMs, releaseMs,
      shutdownMs: readyMs === undefined ? undefined : elapsedMs - readyMs,
      timedOut, actualCode: result.code, actualSignal: result.signal }));
    assert.ok(ready && overlapped, stderr);
    assert.equal(timedOut, false, stderr);
    const expectedCode = kind === "eof-error" ? 1 : kind === "sigterm-first" ? 143 : 0;
    assert.deepEqual(result, { code: expectedCode, signal: null }, stderr);
    const exitLine = stderr.split("\n").find(line => line.startsWith("CLOSE_EXIT:"));
    assert.ok(exitLine, stderr);
    const exit = JSON.parse(exitLine.slice("CLOSE_EXIT:".length));
    assert.deepEqual(exit, { code: expectedCode, runtimeCalls: 1, sessionCalls: 1, completed: true, networkCalls: 0, uncaught: 0, unhandledRejections: 0, signalObserverReleased: true,
      tmpdir: tmpdir(), signalListeners: 0, dataListeners: 0, endListeners: 0, callbacksReleased: true, idleReleased: true });
    const gate = stderr.split("\n").filter(line => line.startsWith("CLOSE_RELEASED:"));
    assert.equal(gate.length, 1, stderr);
    assert.deepEqual(JSON.parse(gate[0]!.slice("CLOSE_RELEASED:".length)), { shutdowns: 1, timerReleased: true, gateReleased: true, ipcReleased: true });
    if (kind === "eof-error") assert.ok(stderr.includes("fixture dispose failure"));
    t.diagnostic(JSON.stringify({ kind, childPid: child.pid, ownedRoot: root, ...exit }));
  });
}
