import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

for (const kind of ["idle", "startup", "command", "command-error", "custom-flush", "preflight-error", "active", "settled", "eof"]) {
  test(`RPC shutdown ${kind}: real CLI, open stdin and owned cleanup`, { timeout: 25_000 }, async t => {
    const hasStream = kind === "active" || kind === "settled";
    const hasCommand = kind.startsWith("command") || kind === "custom-flush";
    const root = mkdtempSync(join(tmpdir(), "rpc-shutdown-"));
    const agent = join(root, "agent"); mkdirSync(agent);
    const config = getConfigDir(agent); mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import",
      new URL("./fixtures/rpc-shutdown-preload.mjs", import.meta.url).href,
      fileURLToPath(new URL("../packages/coding-agent/src/cli.ts", import.meta.url)),
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--extension", fileURLToPath(new URL("./fixtures/rpc-shutdown-extension.mjs", import.meta.url))], {
      cwd: root, stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "", RPC_SHUTDOWN_CASE: kind },
    });
    const input = child.stdin, output = child.stdout, errors = child.stderr;
    assert.ok(input && output && errors, "fixture owns all three pipes");
    writeFileSync(join(root, "resources.json"), JSON.stringify({ root, childPid: child.pid, startedAt: new Date().toISOString(), purpose: kind }));
    let stdout = "", stderr = "", ready = false, released = false, timedOut = false;
    // Failure containment only; this is not a product shutdown deadline.
    let watchdog = setTimeout(killOwnedChild, 20_000);
    function killOwnedChild() { timedOut = true; child.kill(); }
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    output.on("data", data => {
      stdout += data.toString();
      if (stdout.length > 1024 * 1024) killOwnedChild();
      if (!ready && stdout.includes("RPC_READY")) {
        ready = true;
        clearTimeout(watchdog); watchdog = setTimeout(killOwnedChild, 5_000);
        if (kind === "eof") input.end();
        else if (hasStream || kind === "preflight-error" || hasCommand) input.write(JSON.stringify({ id: "fixture-prompt", type: "prompt", message: hasCommand ? "/fixture-shutdown" : "fixture" }) + "\n");
      }
      releaseFlush();
    });
    errors.on("data", data => {
      stderr += data.toString();
      if (stderr.length > 1024 * 1024) killOwnedChild();
      if (hasStream && !released && stderr.includes("RPC_ACTIVE\n")) { released = true; child.send("finish"); }
      releaseFlush();
    });
    function releaseFlush() {
      if (kind === "custom-flush" && !released && stdout.includes('"fixture-prompt"') && stderr.includes("RPC_FLUSH_PENDING\n")) {
        released = true; child.send("flush");
      }
    }
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      removeOwnedFixture(root);
    });
    const code = await closed;
    clearTimeout(watchdog);
    assert.ok(ready, stderr);
    assert.equal(timedOut, false, `RPC stayed alive without further stdin; ${stderr}`);
    assert.equal(code, 0, stderr);
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    const exit = JSON.parse(stderr.split("\n").find(line => line.startsWith("RPC_EXIT:"))!.slice("RPC_EXIT:".length));
    const shutdown = stderr.split("\n").filter(line => line.startsWith("RPC_SHUTDOWN:"));
    assert.equal(shutdown.length, 1, stderr);
    const releasedState = JSON.parse(shutdown[0]!.slice("RPC_SHUTDOWN:".length));
    assert.deepEqual(releasedState, { shutdowns: 1, requests: hasStream ? 1 : 0, aborted: false,
      timerReleased: true, streamReleased: true, ipcReleased: true, flushReleased: true });
    assert.deepEqual(exit, { code: 0, runtimeCalls: 1, sessionCalls: 1, disposed: true, networkCalls: 0,
      idleWaitCalls: hasStream || kind === "custom-flush" ? 1 : 0,
      tmpdir: tmpdir(), dataListeners: 0, endListeners: 0, callbacksReleased: true, idleWaitReleased: true });
    if (hasCommand || hasStream) {
      assert.equal(events.filter(event => event.type === "response" && event.id === "fixture-prompt" && event.success).length, 1);
    }
    if (kind === "command-error") assert.ok(events.some(event => event.type === "extension_error" && event.error === "fixture command error"));
    if (kind === "preflight-error") assert.deepEqual(events.filter(event => event.type === "response" && event.id === "fixture-prompt"),
      [{ id: "fixture-prompt", type: "response", command: "prompt", success: false, error: "fixture preflight rejection" }]);
    if (hasStream) {
      assert.ok(released);
      assert.ok(events.some(event => event.type === "agent_end"));
      assert.ok(events.some(event => event.type === "agent_settled"), "publish idle after extension settlement completes");
    }
    if (kind === "settled") assert.ok(stderr.includes("RPC_SETTLED_HOOK_DONE\n"));
    if (kind === "custom-flush") {
      assert.ok(released);
      assert.ok(stderr.includes("RPC_FLUSH_DONE\n"));
      assert.ok(events.some(event => event.type === "message_end" && event.message.customType === "fixture-report"));
      assert.ok(!events.some(event => event.type === "agent_settled"), "idle reports do not publish agent_settled");
    }
    t.diagnostic(JSON.stringify({ kind, childPid: child.pid, ownedRoot: root, ...exit, ...releasedState }));
  });
}
