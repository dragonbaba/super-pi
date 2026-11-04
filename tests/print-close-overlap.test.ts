import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

for (const kind of ["normal", "normal-overlap", "normal-error", "repeat", "repeat-error", "native-repeat", "native-hup", "native-normal"]) {
  test(`print overlap ${kind}: join real shutdown before exit`, {
    timeout: 25_000,
    skip: process.platform === "win32" && kind.startsWith("native") ? "Windows kill does not deliver POSIX signals" : false,
  }, async t => {
    const root = mkdtempSync(join(tmpdir(), "print-close-"));
    const agent = join(root, "agent"); mkdirSync(agent);
    const config = getConfigDir(agent); mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import",
      new URL("./fixtures/print-close-overlap-preload.mjs", import.meta.url).href,
      fileURLToPath(new URL("../packages/coding-agent/src/cli.ts", import.meta.url)),
      "--print", "--mode", "text", "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--extension", fileURLToPath(new URL("./fixtures/print-close-overlap-extension.mjs", import.meta.url)),
      "/fixture-wait"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "", PRINT_CLOSE_CASE: kind },
    });
    const output = child.stdout, errors = child.stderr;
    assert.ok(output && errors);
    writeFileSync(join(root, "resources.json"), JSON.stringify({ root, childPid: child.pid, startedAt: new Date().toISOString(), purpose: kind }));
    let stdout = "", stderr = "", ready = false, overlapped = false, armed = false, released = false, timedOut = false;
    let watchdog = setTimeout(killOwnedChild, 20_000);
    function killOwnedChild() { timedOut = true; child.kill("SIGKILL"); }
    function send(message: string) { if (child.connected) child.send(message, () => {}); }
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    output.on("data", data => { stdout += data.toString(); if (stdout.length > 1024 * 1024) killOwnedChild(); });
    errors.on("data", data => {
      stderr += data.toString();
      if (stderr.length > 1024 * 1024) killOwnedChild();
      if (!ready && stderr.includes("PRINT_READY\n")) {
        ready = true; clearTimeout(watchdog); watchdog = setTimeout(killOwnedChild, 5_000);
        if (kind.startsWith("native") && kind !== "native-normal") child.kill(kind === "native-hup" ? "SIGHUP" : "SIGTERM");
        else if (!kind.startsWith("normal") && kind !== "native-normal") send("first");
      }
      if (!overlapped && stderr.includes("PRINT_GATE\n")) {
        overlapped = true;
        if (kind === "normal" || kind === "normal-error") { released = true; send("release"); }
        else send(kind.startsWith("native") ? "arm" : "second");
      }
      if (!armed && stderr.includes("PRINT_ARMED\n")) { armed = true; child.kill("SIGTERM"); }
      if (overlapped && !released && stderr.includes("PRINT_OVERLAP\n")) { released = true; send("release"); }
    });
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      removeOwnedFixture(root);
    });
    const result = await closed;
    clearTimeout(watchdog);
    assert.ok(ready && overlapped, stderr);
    assert.equal(timedOut, false, stderr);
    const expectedCode = kind.endsWith("error") ? 1 : kind.startsWith("normal") || kind === "native-normal" ? 0 : kind === "native-hup" ? 129 : 143;
    assert.deepEqual(result, { code: expectedCode, signal: null }, stderr);
    const exitLine = stderr.split("\n").find(line => line.startsWith("PRINT_EXIT:"));
    assert.ok(exitLine, stderr);
    const exit = JSON.parse(exitLine.slice("PRINT_EXIT:".length));
    assert.deepEqual(exit, { code: expectedCode, runtimeCalls: 1, sessionCalls: 1, completed: true, networkCalls: 0, uncaught: 0,
      unhandledRejections: 0, tmpdir: tmpdir(), signalListeners: 0, ipcReleased: true, callbacksReleased: true, idleReleased: true });
    const gate = stderr.split("\n").filter(line => line.startsWith("PRINT_RELEASED:"));
    assert.equal(gate.length, 1, stderr);
    assert.deepEqual(JSON.parse(gate[0]!.slice("PRINT_RELEASED:".length)), { shutdowns: 1, gateReleased: true, ipcReleased: true });
    if (kind.endsWith("error")) assert.ok(stderr.includes("fixture print dispose failure"));
    t.diagnostic(JSON.stringify({ kind, childPid: child.pid, ownedRoot: root, ...exit }));
  });
}
