import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { heredocConsumer, inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { shellHookFixture, assertFinalAuthorization } from "./codemode-recovery/shell-hook-fixture.ts";

test("unbounded heredocs cannot conceal executable input or following launches", async t => {
  for (const command of ["source /dev/stdin <<E\\OF\nsleep 100 &\nEOF", "cat <<E\\OF\ndata\nEOF\nnohup node server.js", "source /dev/stdin <<'EOF'\nrm \"$X\""]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_HEREDOC/);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
});

test("builtin dispatch cannot hide executable stdin", async t => {
  for (const prefix of ["builtin source", "command source", "builtin -- source", "command builtin source", "builtin .", `${"builtin ".repeat(70)}source`]) {
    const command = `${prefix} /dev/stdin <<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
    const f = await shellHookFixture(t, "full-access"), { outcome } = await f.authorize(command);
    assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
  }
});

test("program operands and syntax-only modes leave heredoc input as data", async t => {
  assert.equal(heredocConsumer("bash -ec 'cat'"), undefined, "input stays data even when the lifecycle wrapper grammar separately refuses clustered -c");
  for (const header of ["bash -c 'cat'", "node -e 'process.stdin.resume()'", "node script.js", "node --check", "python -c 'print(1)'", "python -uc 'print(1)'", "python script.py", "source script.sh"]) {
    assert.equal(heredocConsumer(header), undefined, header);
    const body = header.startsWith("node") ? "fs.rmSync(target, {recursive: true})" : header.startsWith("python") ? "shutil.rmtree(target)" : "nohup is only data";
    const command = `${header} <<'EOF'\n${body}\nEOF`;
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
  }
  for (const header of ["source /dev/stdin", "builtin source /dev/fd/0", "bash -s arg", "bash -eu", "python -u -", "python -W ignore", "node --input-type module", "node --require helper.js -"]) {
    assert.ok(heredocConsumer(header), header);
  }
});

test("an operand equal to cwd retains expansion checks; synthesized cwd does not", () => {
  const cwd = resolve("review*cwd");
  const command = process.platform === "win32" ? `rmdir '${cwd}'` : `rmdir ${cwd}`;
  assert.equal(inspectBashPermissionScope({ command }, cwd)?.unverifiableMutation, true);
  assert.equal(inspectBashPermissionScope({ command: "python -c 'print(1)'" }, cwd)?.dynamicScope, false);
});

test("clustered sort output flags preserve unknown-target denial", async t => {
  for (const command of ['sort -ro"$X"', 'sort -uro "$X"', 'sort -k 1 -ro"$X"']) {
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  assert.equal(inspectBashPermissionScope({ command: "sort -tro" }, process.cwd())?.unverifiableMutation, false, "t consumes its operand, so its o is not an output flag");
});
