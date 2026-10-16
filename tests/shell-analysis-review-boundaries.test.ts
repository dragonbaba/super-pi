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

test("heredoc declaration binding follows escaped logical lines", async t => {
  for (const header of ["source /dev/stdin \\\n<<'EOF'", "<<'EOF' \\\nsource /dev/stdin", "source \\\n<<'EOF' \\\n/dev/stdin"]) {
    const command = `${header}\nsleep 100 &\nEOF`;
    const document = prepareShellAnalysis(command).hereDocuments![0]!;
    assert.equal(document.body, "sleep 100 &\n");
    assert.equal(heredocConsumer(document.header, document.descriptor), "bash");
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  assert.equal(inspectBashResourceLifecycle({ command: "cat \\\n<<'EOF'\nsleep 100 &\nEOF" }), undefined);
});

test("heredoc source descriptors identify executable input without leaking fd words", async t => {
  for (const header of ["source /dev/fd/3 3<<'EOF'", "3<<'EOF' source /proc/self/fd/3", "builtin source /dev/fd/19 19<<'EOF'"]) {
    const command = `${header}\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const header of ["source /dev/fd/4 3<<'EOF'", "source /dev/stdin 3<<'EOF'", "node 3<<'EOF'"]) {
    const doc = prepareShellAnalysis(`${header}\nsleep 100 &\nEOF`).hereDocuments![0]!;
    assert.equal(doc.descriptor, 3); assert.equal(heredocConsumer(doc.header, doc.descriptor), undefined);
  }
  assert.equal(prepareShellAnalysis("cat 3<<'EOF'\ndata\nEOF").command.trim(), "cat");
});

test("Node option values cannot conceal stdin mutations", async t => {
  for (const options of ["--title worker", "--title=worker", "--stack-trace-limit 10", "--require helper.js", "--unknown-future-flag value", "--no-warnings --title worker", "--title --eval"]) {
    assert.equal(heredocConsumer(`node ${options}`), "node");
    assert.equal(heredocConsumer(`node ${options} script.js`), undefined);
    const command = `node ${options} <<'EOF'\nconst fs=require('node:fs'); fs.rmSync(target,{recursive:true})\nEOF`;
    assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
});

test("file-opening read/write and combined redirects retain mutation identity", async t => {
  for (const command of ["printf X 1<>target", "printf X <>target", "printf X >&target", "printf X {fd}>target"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
    assert.ok(inspectBashPermissionScope({ command }, process.cwd())?.primitives.includes("output_redirection"), command);
  }
  for (const command of ['printf X 1<>"$X"', 'printf X >&"$X"', 'printf X {fd}>"$X"']) {
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["printf X 1>&2", "printf X 2>&-", "printf X <input", "printf X <>/dev/null"]) {
    assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
  }
});

test("state-changing builtins and expansions taint later mutation context", async t => {
  for (const prefix of ["printf -v CDPATH ..", "((CDPATH=1))", "echo $((CDPATH=1))", "[[ -v 'a[CDPATH=1]' ]]"]) {
    const command = `${prefix}; cd sub && touch target`;
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
      assertFinalAuthorization(await f.authorize(prefix));
    }
  }
});

test("compound commands and literal wrappers propagate executable heredoc input", async t => {
  for (const header of ["{ source /dev/stdin; }", "{ { source /dev/stdin; }; }", "(source /dev/stdin)", "{ cat; source /dev/stdin; }", "{ ! source /dev/stdin; }", "{ time source /dev/stdin; }", "X=value source /dev/stdin", "bash -c 'source /dev/stdin'", "bash -c 'builtin source /dev/stdin'", "bash -c 'eval source /dev/stdin'"]) {
    const command = `${header} <<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const header of ["{ cat; }", "(cat)", "bash -c 'cat'"]) {
    assert.equal(heredocConsumer(`${header} <<'EOF'`), undefined);
    const command = `${header} <<'EOF'\nsleep 100 &\nEOF`;
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const f = await shellHookFixture(t, "full-access"); assertFinalAuthorization(await f.authorize(command));
  }
  for (const header of ["source /dev/stdin; { cat; }", "source /dev/stdin; (cat)"]) {
    assert.equal(heredocConsumer(`${header} <<'EOF'`), undefined, "an earlier list member does not inherit the later group's input");
  }
});

test("literal pipeline consumers receive heredoc analysis without borrowing earlier lists", async t => {
  for (const header of ["cat <<'EOF' | source /dev/stdin", "cat <<'EOF' | >out source /dev/stdin", "cat <<'EOF' | bash -c 'source /dev/stdin'"]) {
    const command = `${header}\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const header of ["cat <<'EOF' | cat", "source /dev/stdin; cat <<'EOF' | cat"]) {
    assert.equal(inspectBashResourceLifecycle({ command: `${header}\nsleep 100 &\nEOF` }), undefined);
  }
});

test("nested eval stdin consumers retain argv after redirection removal", async t => {
  for (const header of ["bash -c 'eval >out source /dev/stdin'", "{ eval >out source /dev/stdin; }", "bash -c 'eval 2>errors builtin source /dev/stdin'"]) {
    const command = `${header} <<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  assert.equal(inspectBashResourceLifecycle({ command: "bash -c 'eval >out cat' <<'EOF'\nsleep 100 &\nEOF" }), undefined);
});

test("nested stdin readers keep mutation context and all interpreter languages", async t => {
  assert.equal(inspectHighRiskBashMutation({ command: "{ node; python; } <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF" }, process.cwd())?.mutationDetected, true);
  for (const command of ["{ source /dev/stdin; } <<'EOF'\ntouch \"$X\"\nEOF", "bash -c 'cd sub; source /dev/stdin' <<'EOF'\ntouch target\nEOF"]) {
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
});

test("interpreter script paths matching heredoc descriptors receive body inspection", async t => {
  for (const interpreter of ["bash", "node", "python"]) {
    for (const [path, descriptor] of [["/dev/stdin", 0], ["/dev/fd/3", 3], ["/proc/self/fd/4", 4]] as const) {
      for (const boundary of ["", "-- "]) assert.equal(heredocConsumer(`${interpreter} ${boundary}${path} ${descriptor}<<'EOF'`, descriptor), interpreter);
      assert.equal(heredocConsumer(`${interpreter} ${path} <<'EOF'`, descriptor + 1), undefined);
    }
    assert.equal(heredocConsumer(`${interpreter} script-file <<'EOF'`), undefined);
  }
  for (const header of ["bash /dev/stdin", "bash -- /dev/stdin", "bash /dev/fd/3 3", "bash /proc/self/fd/4 4"]) {
    const command = `${header}<<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const interpreter of ["node", "python"]) {
    const body = interpreter === "node" ? "fs.rmSync(target,{recursive:true})" : "shutil.rmtree(target)";
    const command = `${interpreter} /dev/fd/3 3<<'EOF'\n${body}\nEOF`;
    assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
    const f = await shellHookFixture(t, "full-access"), { outcome } = await f.authorize(command);
    assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
  }
});

test("combined output redirects do not detach heredoc input from its consumer", async t => {
  for (const operator of ["&>", "&>>"]) {
    const command = `<<'EOF' ${operator}out source /dev/stdin\nsleep 100 &\nEOF`;
    assert.ok(prepareShellAnalysis(command).hereDocuments?.[0]?.header.includes("source /dev/stdin"));
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    assert.equal(inspectBashResourceLifecycle({ command: `<<'EOF' ${operator}out cat\nsleep 100 &\nEOF` }), undefined);
  }
});

test("literal alias definitions retain lifecycle and mutation inspection", async t => {
  for (const definition of ["alias run='sleep 30 >/dev/null 2>&1 &'", "builtin alias run='sleep 30 &'", "alias run='eval sleep 30 \\&'", "alias run='rm -rf \"$X\"'", "alias run='touch \"$X\"'"]) {
    const command = `shopt -s expand_aliases\n${definition}\nrun`;
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true, command); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["alias -p", "shopt -s expand_aliases\nalias run='printf ok'\nrun", "printf '%s' 'alias run=sleep'"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  }
  assert.match(inspectBashResourceLifecycle({ command: 'alias run="$SCRIPT"\nrun' }) ?? "", /SHELL_WRAPPER/);
  assert.match(inspectBashResourceLifecycle({ command: "{ alias run='source /dev/stdin'; run; } <<'EOF'\nsleep 30 &\nEOF" }) ?? "", /Blocked an unmanaged long-lived process/);
});

test("literal multiword eval and trap actions preserve mutation targets", async t => {
  for (const command of ["eval rm -rf '\"$X\"'", "eval -- rm -rf '\"$X\"'", "builtin eval rm -rf '\"$X\"'", "eval >out rm -rf '\"$X\"'"]) {
    assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true, command); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  const literal = inspectHighRiskBashMutation({ command: "eval rm -rf /protected" }, process.cwd());
  assert.equal(literal?.mutationDetected, true);
  assert.ok(literal?.targets.includes(resolve("/protected")), "literal eval deletion reaches the existing target assessment with its real target");
  for (const command of ["eval touch target", "builtin eval touch target"]) {
    const scope = inspectBashPermissionScope({ command }, process.cwd());
    assert.ok(scope?.primitives.includes("touch"), command);
    assert.ok(scope?.targets.includes(resolve("target")), command);
  }
  for (const command of ["eval 'touch' '\"$X\"'", "trap 'touch \"$X\"' EXIT", "builtin trap 'touch \"$X\"' EXIT"]) {
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true, command);
    const f = await shellHookFixture(t, "full-access"), { outcome } = await f.authorize(command);
    assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
  }
});

test("function-dependent heredoc consumers cannot hide executable input", async t => {
  for (const header of ["f(){ source /dev/stdin; }; f", "function f { source /dev/stdin; }; f", "f(){ source /dev/stdin; }\nf", "{ f(){ source /dev/stdin; }; }; f", "if true; then f(){ source /dev/stdin; }; fi; f", "cat(){ source /dev/stdin; }\ncat"]) {
    const command = `${header} <<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_HEREDOC/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["f(){ printf ok; }; f", "f(){ printf ok; }; cat <<'EOF'\nsleep 100 &\nEOF", "f(){ printf ok; }\ncat <<'EOF'\nsleep 100 &\nEOF"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const f = await shellHookFixture(t, "full-access"); assertFinalAuthorization(await f.authorize(command));
  }
});

test("transformed heredoc streams are not mistaken for literal executable input", async t => {
  for (const header of ["base64 -d <<'EOF' | source /dev/stdin", "cat <<'EOF' | base64 -d | source /dev/stdin", "sed 's/X/sleep/' <<'EOF' | bash -c 'source /dev/stdin'", "base64 -d <<'EOF' | node", "base64 -d <<'EOF' | python"]) {
    const command = `${header}\nc2xlZXAgMTAwICYK\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_HEREDOC/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["cat <<'EOF' | cat - | source /dev/stdin\nprintf ok\nEOF", "base64 -d <<'EOF' | cat\nc2xlZXAgMTAwICYK\nEOF"]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const f = await shellHookFixture(t, "full-access"); assertFinalAuthorization(await f.authorize(command));
  }
});

test("trap action expansion cannot defer inspection of executable source", async t => {
  for (const command of ['ACTION=\'sleep 100 &\'; trap "$ACTION" EXIT; true', 'trap -- "$ACTION" EXIT', 'builtin trap "$ACTION" EXIT']) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_WRAPPER/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["trap 'printf ok' EXIT", "trap - EXIT", 'trap -p "$SIGNAL"']) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
});
