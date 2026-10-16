import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { heredocConsumer, inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { prepareShellAnalysis } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
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

test("heredoc header comments do not introduce delimiters", async t => {
  for (const header of ["cat <<'EOF' # <<'FAKE'", "cat <<'EOF' # <<E\\OF", "cat <<'EOF' # unfinished '"]) {
    const command = `${header}\ndata\nEOF`;
    const view = prepareShellAnalysis(command);
    assert.equal(view.unboundedHeredoc, false); assert.equal(view.hereDocuments?.length, 1);
    assert.equal(inspectBashResourceLifecycle({ command }), undefined);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  }
});

test("heredocs bind to the complete simple command, including later operands", async t => {
  for (const header of ["<<'EOF' source /dev/stdin", "source <<'EOF' /dev/stdin", "<<'EOF' builtin source /dev/stdin", "cat; <<'EOF' source /dev/stdin", "cat | <<'EOF' source /dev/stdin"]) {
    const command = `${header}\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  const data = "<<'EOF' cat | source script.sh\nsleep 100 &\nEOF";
  assert.equal(heredocConsumer(prepareShellAnalysis(data).hereDocuments![0]!.header), undefined);
  assert.equal(inspectBashResourceLifecycle({ command: data }), undefined);
  for (const header of ["<<'EOF' node -e 'process.stdin.resume()'", "node <<'EOF' script.js", "source <<'EOF' script.sh"]) {
    assert.equal(heredocConsumer(prepareShellAnalysis(`${header}\ndata\nEOF`).hereDocuments![0]!.header), undefined);
  }
  assert.equal(inspectHighRiskBashMutation({ command: "<<'EOF' node\nfs.rmSync(target, {recursive: true})\nEOF" }, process.cwd())?.mutationDetected, true);
});

test("literal eval and trap actions retain lifecycle inspection", async t => {
  for (const command of ["eval 'sleep 100 &'", "eval -- sleep '100 &'", "builtin eval 'sleep 100 &'", "trap 'sleep 100 &' DEBUG; true", "builtin -- trap -- 'sleep 100 &' EXIT", "trap > /dev/null 'sleep 100 &' EXIT"]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["eval 'printf ok'", "eval printf ok", "trap 'printf ok' EXIT", "trap -p EXIT", "trap - EXIT", "echo 'eval sleep 100 &'", "echo 'trap sleep 100 &'"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const f = await shellHookFixture(t, "full-access"); assertFinalAuthorization(await f.authorize(command));
  }
});
