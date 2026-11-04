import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getConfigDir } from "../packages/coding-agent/src/config.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const mode of ["text", "json"]) for (const reason of ["stop", "length", "error", "aborted"]) {
  test(`print ${mode}/${reason}: preserve output and report final status`, { timeout: 25_000 }, async t => {
    const owned = createOwnedTaskFixture("h03-print-result-");
    const root = owned.root;
    const agent = join(root, "agent"); mkdirSync(agent);
    const config = getConfigDir(agent); mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import",
      new URL("./fixtures/print-result-preload.mjs", import.meta.url).href,
      fileURLToPath(new URL("../packages/coding-agent/src/cli.ts", import.meta.url)),
      "--print", "--mode", mode, "--no-session", "--no-extensions", "--no-tools", "--no-context-files", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--extension", fileURLToPath(new URL("./fixtures/print-result-extension.mjs", import.meta.url)),
      "fixture request"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, SP_CODING_AGENT_DIR: agent,
        SP_CODING_AGENT_SESSION_DIR: join(root, "sessions"), SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "", PRINT_RESULT_REASON: reason },
    });
    const output = child.stdout, errors = child.stderr;
    assert.ok(output && errors);
    const startedAt = new Date().toISOString();
    writeFileSync(join(root, "resources.json"), JSON.stringify({ root, createdSharedParent: owned.createdSharedParent,
      childPid: child.pid, startedAt, purpose: mode + "/" + reason }));
    let stdout = "", stderr = "", timedOut = false;
    function killOwnedChild() { timedOut = true; child.kill("SIGKILL"); }
    const watchdog = setTimeout(killOwnedChild, 20_000);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    output.on("data", data => { stdout += data.toString(); if (stdout.length > 1024 * 1024) killOwnedChild(); });
    errors.on("data", data => { stderr += data.toString(); if (stderr.length > 1024 * 1024) killOwnedChild(); });
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const result = await closed;
      writeFileSync(join(root, "resources.json"), JSON.stringify({ root, createdSharedParent: owned.createdSharedParent,
        childPid: child.pid, startedAt, result, purpose: mode + "/" + reason }));
      owned.cleanup();
    });
    const result = await closed;
    clearTimeout(watchdog);
    assert.equal(timedOut, false, stderr);
    const expectedCode = mode === "text" && reason !== "stop" ? 1 : 0;
    assert.deepEqual(result, { code: expectedCode, signal: null }, stderr);
    if (mode === "text") {
      assert.equal(stdout, reason === "stop" || reason === "length" ? "fixture first\nfixture second\n" : "");
      if (reason === "error") assert.ok(stderr.includes("fixture provider failure"));
      if (reason === "aborted") assert.ok(stderr.includes("Request aborted"));
    } else {
      const events = stdout.trim().split("\n").map(line => JSON.parse(line));
      const endings = events.filter(event => event.type === "message_end" && event.message.role === "assistant");
      assert.equal(endings.length, 1);
      assert.equal(endings[0].message.stopReason, reason);
      assert.deepEqual(endings[0].message.content, [{ type: "text", text: "fixture first" }, { type: "text", text: "fixture second" }]);
      assert.ok(events.some(event => event.type === "agent_end"));
    }
    assert.equal(stderr.includes("Response was truncated: the model reached its output token limit."), mode === "text" && reason === "length");
    const shutdown = stderr.split("\n").filter(line => line.startsWith("RESULT_SHUTDOWN:"));
    assert.equal(shutdown.length, 1, stderr);
    assert.deepEqual(JSON.parse(shutdown[0]!.slice("RESULT_SHUTDOWN:".length)), { requests: 1, shutdowns: 1 });
    const exitLine = stderr.split("\n").find(line => line.startsWith("RESULT_EXIT:"));
    assert.ok(exitLine, stderr);
    const exit = JSON.parse(exitLine.slice("RESULT_EXIT:".length));
    assert.deepEqual(exit, { code: expectedCode, runtimeCalls: 1, sessionCalls: 1, completed: true, networkCalls: 0, uncaught: 0,
      unhandledRejections: 0, tmpdir: root, signalListeners: 0, callbacksReleased: true, idleReleased: true });
    t.diagnostic(JSON.stringify({ mode, reason, childPid: child.pid, ownedRoot: root, ...exit }));
  });
}
