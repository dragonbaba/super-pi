import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationOwner } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { assistant, body, longText, toolResult } from "./fixture.ts";
import { executionFixture as fixture } from "./execution-fixture.ts";
import { workspace, permission, inspectBashResourceLifecycle, inspectPowerShellResourceLifecycle, guard } from "./guard-fixture.ts";
import { shellHookFixture, assertFinalAuthorization } from "./shell-hook-fixture.ts";

// These passing controls are discovered by npm test. The explicit R0 entry also
// includes this file, so its baseline retains the safety and recovery controls.
test("control: a genuinely insufficient result budget is not silently bypassed", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1 }, "insufficient")!;
  try {
    assert.throws(() => owner.projectMessagesForModel([assistant(["one"]), toolResult("one", [{ type: "text", text: longText }])],
      undefined, undefined, undefined, 128000, 4096), (error: unknown) => (error as { code: string }).code === "budget-too-small");
  } finally { owner.dispose(); }
});

test("control: ordinary bounded text is recoverable exactly without replay", () => {
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "ordinary-text")!;
  try {
    const source = toolResult("source", [{ type: "text", text: longText }]);
    const p = owner.create(source.content, "source")!; owner.release();
    assert.equal(p.version, 2); if (p.version !== 2) return;
    let cursor: string | undefined = p.continuation.cursor, restored = "", count = 0;
    while (cursor) {
      assert.ok(++count < 100);
      const chunk = owner.readContinuation(cursor, [source], 1024);
      assert.ok(chunk.estimatedTokens <= 1024); assert.notEqual(chunk.nextCursor, cursor);
      restored += chunk.content.filter(b => b.type === "text").map(b => b.text).join(""); cursor = chunk.nextCursor;
    }
    const index = p.truncation.noticeBlockIndex;
    const text = (blocks: readonly { type: string; text?: string }[]) => blocks.filter(b => b.type === "text").map(b => b.text).join("");
    assert.equal(text(p.modelContent.slice(0, index)) + restored + text(p.modelContent.slice(index + 1)), longText);
  } finally { owner.dispose(); }
});

test("control: an unhandled child failure still fails the parent and does not commit store", async t => {
  const f = await fixture(t);
  const first = await f.run('store("uncommitted","no"); await tools.probe({kind:"failure"});');
  const second = await f.run('text({value:load("uncommitted") ?? null});');
  assert.equal(first.result.isError, true); assert.match(body(second.result.content), /"value":null/);
  assert.deepEqual(f.calls, ["failure"]);
});

test("control: catch without allowFailure keeps the failed parent and discards store", async t => {
  const f = await fixture(t);
  const first = await f.run(`try { await callTool("probe", {kind:"failure"}); }
    catch (error) { text("caught failure without allowFailure"); }
    await tools.probe({kind:"ok"}); store("caughtOnly",true); text("alternative completed");`);
  const second = await f.run('text({caughtOnly:load("caughtOnly") ?? null});');
  assert.match(body(first.result.content), /caught failure without allowFailure/);
  assert.match(body(first.result.content), /alternative completed/);
  assert.equal((first.result.details as any).codemode.scriptOk, true);
  assert.deepEqual((first.result.details as any).codemode.calls.map((c: any) => c.isError), [true, false]);
  assert.equal(first.result.isError, true);
  assert.match(body(second.result.content), /"caughtOnly":null/);
  assert.deepEqual(f.calls, ["failure", "ok"]);
});

test("control: one bounded child completes within the script deadline", async t => {
  const f = await fixture(t);
  const { result } = await f.run('// @options: {"timeout_ms":800}\nawait tools.probe({kind:"delay",delay:300});');
  assert.equal(result.isError, false); assert.deepEqual(f.aborted, []);
});

test("control: script computation remains bounded", async t => {
  const f = await fixture(t);
  const { result } = await f.run('// @options: {"timeout_ms":100}\nwhile(true) {}');
  assert.equal(result.isError, true); assert.match(body(result.content), /timeout|timed out/i); assert.deepEqual(f.calls, []);
});

test("control: user cancellation still reaches a waiting child", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pending = f.run('await tools.probe({kind:"delay",delay:10000});');
  await f.started;
  await f.session.abort();
  const { result } = await pending;
  assert.equal(result.isError, true); assert.deepEqual(f.calls, ["delay"]); assert.deepEqual(f.aborted, ["delay"]);
});
for (const command of ["npm run dev &", "nohup node server.js", "docker run -d alpine"]) {
  test(`control: unmanaged lifecycle remains blocked: ${command}`, async t => {
    assert.ok(inspectBashResourceLifecycle({ command }));
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode);
      const { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true);
      assert.equal(outcome?.finalAuthorization, undefined);
      assert.equal(f.dialogs(), 0);
    }
  });
}
test("control: PowerShell Start-Process without -Wait remains blocked", async t => {
  const command = 'Start-Process -FilePath "node" -ArgumentList "server.js"';
  assert.ok(inspectPowerShellResourceLifecycle({ command }));
  for (const mode of ["full-access", "workspace-write"] as const) {
    const f = await shellHookFixture(t, mode);
    const { outcome } = await f.authorize(command, "powershell");
    assert.equal(outcome?.block, true);
    assert.equal(outcome?.finalAuthorization, undefined);
    assert.equal(f.dialogs(), 0);
  }
});
for (const [toolName, command] of [["bash", 'rm -rf "$X"'], ["powershell", "Remove-Item -Recurse $x"]] as const) {
  test(`control: a recognized recursive deletion with unknown targets is still blocked (${toolName})`, async t => {
    const cwd = workspace(t), f = await permission(cwd, "full-access");
    const decision = await f.authorize(command!, toolName);
    assert.equal(decision?.block, true); assert.equal(f.dialogs(), 0);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const hook = await shellHookFixture(t, mode);
      const { outcome } = await hook.authorize(command, toolName);
      assert.equal(outcome?.block, true);
      assert.equal(outcome?.finalAuthorization, undefined);
      assert.equal(hook.dialogs(), 0);
    }
  });
}

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`control: a supported opaque command gets final authorization (${mode})`, async t => {
    const f = await shellHookFixture(t, mode);
    assertFinalAuthorization(await f.authorize('python -c "print(1)"'));
    assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
  });
}

for (const availability of ["active", "discoverable", "unavailable"] as const) {
  test(`control: launcher refusal uses the production native-tool availability callback (${availability})`, async t => {
    const f = await shellHookFixture(t, "full-access", availability);
    const { outcome } = await f.authorize('pwsh -NoProfile -Command "Write-Output 1"');
    assert.equal(outcome?.block, true);
    assert.equal(outcome?.finalAuthorization, undefined);
    assert.match(outcome?.reason ?? "", /LAUNCHER_UNSUPPORTED/);
    const expectedAdvice = process.platform !== "win32" || availability === "unavailable" ? /directly inspectable foreground command/
      : availability === "active" ? /enabled native PowerShell tool/ : /Use tool_search/;
    assert.match(outcome?.reason ?? "", expectedAdvice);
    assert.equal(f.catalogReads(), process.platform === "win32" && availability !== "unavailable" ? 1 : 0);
    assert.equal(f.dialogs(), 0);
  });
}

test("control: a third identical deterministic failure remains blocked", () => {
  const state = guard.createGuardState(), input = { path: "missing-fixture" };
  for (let i = 0; i < 2; i++) {
    assert.equal(guard.inspectBeforeCall(state, "read", input), undefined);
    guard.recordResult(state, "read", input, true, "ENOENT: no such file or directory");
  }
  assert.match(guard.inspectBeforeCall(state, "read", input)!, /REPEATED_CALL_BLOCKED/);
});
