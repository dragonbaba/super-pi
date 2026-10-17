import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import test from "node:test";
import { shellHookFixture, assertFinalAuthorization } from "./codemode-recovery/shell-hook-fixture.ts";
import { mutationFixture } from "./helpers/mutation-fixture.ts";

test("PR1 representative allow / ask / deny acceptance", async t => {
  type Result = "allow" | "ask" | "once" | "deny";
  const rows: readonly (readonly [string, Result, Result, ("bash" | "powershell")?])[] = [
    ...["/", "~", "~/*", ".", "./*", "..", ".git", "sub/../.git", ".sp",
      JSON.stringify(realpathSync.native(homedir()).replaceAll("\\", "/")), JSON.stringify(dirname(realpathSync.native(homedir())).replaceAll("\\", "/"))]
      .map(target => [`rm -rf ${target}`, "deny", "deny"] as const),
    ...["~/.cache/foo", "/tmp/x", "./out/*", "node_modules", "dist build"]
      .map(target => [`rm -rf ${target}`, "allow", "ask"] as const),
    ...["$BUILD_DIR", '"$TMPDIR/foo"', '"$HOME"', "*/node_modules", "~other/cache", Array.from({ length: 17 }, (_, i) => `out${i}`).join(" ")]
      .map(target => [`rm -rf ${target}`, "once", "once"] as const),
    ["bash scripts/build.sh", "allow", "ask"], ["sh -x scripts/build.sh", "allow", "ask"], ["$CMD --version", "allow", "ask"],
    ["bash <<EOF\n$X\nEOF", "allow", "ask"], ["echo " + "x".repeat(128 * 1024), "allow", "ask"],
    ["git status && git diff", "allow", "allow"], ["ls -la", "allow", "allow"],
    ["npm run dev &", "deny", "deny"], ["docker compose up -d", "deny", "deny"],
    ["rm -rf . $BUILD_DIR", "deny", "deny"], ["echo > .git/config", "allow", "ask"],
    ["printf x > out; mv .git moved", "deny", "deny"],
    ["find . -exec echo {} +", "once", "once"],
    ["Remove-Item -Recurse .git", "deny", "deny", "powershell"],
    ["Remove-Item -Recurse ~", "deny", "deny", "powershell"],
    ["Remove-Item -Recurse $BUILD_DIR", "once", "once", "powershell"],
    ["Start-Process tool.exe -Wait:$flag", "allow", "ask", "powershell"],
    ["Start-Process tool.exe", "deny", "deny", "powershell"],
    ['pwsh -Command "Write-Output 1"', "deny", "deny"],
  ];
  for (const mode of ["full-access", "workspace-write"] as const) {
    const f = await shellHookFixture(t, mode);
    const ui = f.runner.getUIContext();
    let options: string[] = [], answer = "仅允许本次";
    f.runner.setUIContext({ ...ui, select: async (title, choices, context) => {
      options = choices; await ui.select(title, choices, context); return answer;
    } }, "tui");
    for (const [command, full, workspace, tool] of rows) {
      const expected = mode === "full-access" ? full : workspace, before = f.dialogs();
      const call = await f.authorize(command, tool);
      if (expected === "deny") {
        assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined);
      } else assertFinalAuthorization(call);
      assert.equal(f.dialogs() - before, expected === "ask" || expected === "once" ? 1 : 0, command.slice(0, 100));
      if (expected === "once") assert.deepEqual(options, ["仅允许本次", "拒绝并填写理由", "拒绝"]);
    }
    const command = "rm -rf $BUILD_DIR", before = f.dialogs();
    // Even a manually installed exact rule cannot approve an unknown target.
    await f.runner.getCommand("permissions")!.handler(`add-rule exact ${command}`, f.runner.createCommandContext());
    assertFinalAuthorization(await f.authorize(command));
    assertFinalAuthorization(await f.authorize(command));
    assert.equal(f.dialogs() - before, 2);
    answer = "拒绝";
    assert.match((await f.authorize(command)).outcome?.reason ?? "", /user_rejected/);
    assert.match((await f.authorize(command)).outcome?.reason ?? "", /unchanged_rejected_request/);
    assert.equal(f.dialogs() - before, 3);
  }
  const headless = await shellHookFixture(t, "workspace-write");
  headless.runner.setUIContext(undefined);
  assert.match((await headless.authorize("rm -rf $BUILD_DIR")).outcome?.reason ?? "", /confirmation_required/);
  for (const mode of ["full-access", "workspace-write"] as const) {
    const f = await mutationFixture(t);
    const permissions = f.runner.getCommand("permissions")!;
    await permissions.handler(mode, f.runner.createCommandContext());
    await permissions.handler(mode === "full-access" ? "never-ask" : "ask", f.runner.createCommandContext());
    // .git can be a worktree pointer file; ordinary parent-directory access is not deletion.
    writeFileSync(join(f.cwd, ".git"), "gitdir: fixture"); mkdirSync(join(f.cwd, ".sp"));
    const native = [
      ["delete", { path: ".git" }], ["move", { path: ".git", destination: "moved" }],
      ["file_batch", { operations: [{ operation: "delete", path: ".sp" }] }],
      ["file_batch", { operations: [{ operation: "move", path: ".git", destination: "moved" }] }],
    ] as const;
    for (const [tool, input] of native) {
      const result = await f.call(tool, input);
      assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /PROTECTED_PATH/);
      assert.equal(f.approvals(), 0); assert.ok(existsSync(join(f.cwd, ".git"))); assert.ok(existsSync(join(f.cwd, ".sp")));
    }
    writeFileSync(join(f.cwd, "ordinary"), "fixture");
    assert.equal((await f.call("delete", { path: "ordinary" })).isError, false);
    assert.equal(f.approvals(), mode === "full-access" ? 0 : 1);
  }
});
