import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { decodeLiteralBase64, heredocConsumer, inspectBashResourceLifecycle, inspectHighRiskBashMutation, literalStoredScripts } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions, prepareShellAnalysis, shellAnalysisCounters } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
import { shellHookFixture, assertFinalAuthorization } from "./codemode-recovery/shell-hook-fixture.ts";
import { SessionPermissionController, workspace } from "./codemode-recovery/guard-fixture.ts";

test("subscript text checks share the substitution scan and retain no source", () => {
  const command = "printf '%s' 'a[0-9]' \"b[12]\" $'c[3]'";
  const beforeCalls = shellAnalysisCounters.substitutionCalls, beforeChars = shellAnalysisCounters.subscriptTextChars;
  assert.equal(extractCommandSubstitutions(command).unsupported, false);
  assert.equal(shellAnalysisCounters.substitutionCalls - beforeCalls, 1);
  assert.equal(shellAnalysisCounters.subscriptTextChars - beforeChars, command.length);
  const beforeComment = shellAnalysisCounters.subscriptTextChars;
  assert.equal(extractCommandSubstitutions("# a[$(sleep 100 &)]\nprintf ok").unsupported, false);
  assert.equal(shellAnalysisCounters.subscriptTextChars - beforeComment, "printf ok".length);
  const beforeData = shellAnalysisCounters.subscriptTextChars;
  extractCommandSubstitutions("literal a[$(printf ok)]", true);
  assert.equal(shellAnalysisCounters.subscriptTextChars, beforeData, "heredoc data uses its existing consumer boundary");
});

test("prompt checks inspect only discovered parameter heads and retain primitive counters", () => {
  const beforeCalls = shellAnalysisCounters.substitutionCalls, beforeHeads = shellAnalysisCounters.promptParameterCalls, beforeChars = shellAnalysisCounters.promptParameterChars;
  extractCommandSubstitutions("printf ok");
  assert.equal(shellAnalysisCounters.promptParameterCalls, beforeHeads);
  assert.equal(extractCommandSubstitutions('echo "${x@P}"').boundaryRefusal, 1);
  assert.equal(shellAnalysisCounters.substitutionCalls - beforeCalls, 2);
  assert.equal(shellAnalysisCounters.promptParameterCalls - beforeHeads, 1);
  assert.equal(shellAnalysisCounters.promptParameterChars - beforeChars, 1);
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review twenty-four ${mode}: nested Node and multipart Path targets stay unverifiable`, async t => {
    for (const command of [
      "node - <<'EOF'\nfs.rmSync(('/protected'), {recursive:true})\nEOF",
      "node - <<'EOF'\nfs.rm(path.join('.', '/protected'), {recursive:true}, done)\nEOF",
      "python - <<'EOF'\nPath('.', '/protected').unlink()\nEOF",
      "python - <<'EOF'\npathlib.Path('.', '/protected').unlink()\nEOF",
      "python - <<'EOF'\nPath('scratch', dynamic).unlink()\nEOF",
    ]) {
      const mutation = inspectHighRiskBashMutation({ command }, process.cwd());
      assert.equal(mutation?.mutationDetected, true, command); assert.equal(mutation?.unverifiableScope, true, command); assert.deepEqual(mutation?.targets, []);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["node - <<'EOF'\nfs.rmSync('scratch',{recursive:true})\nEOF", "python - <<'EOF'\nPath('scratch').unlink()\nEOF", "python - <<'EOF'\nPath('scratch',).unlink()\nEOF"]) {
      assert.ok(inspectHighRiskBashMutation({ command }, process.cwd())?.targets.includes(resolve(process.cwd(), "scratch")), command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
    for (const body of ["fs.rmSync('scratch',{recursive:false})", "fs.rmSync('scratch'); other({recursive:true})", "console.log('fs.rmSync(target,{recursive:true})')", "// fs.rmSync(target,{recursive:true})"]) {
      const command = `node - <<'EOF'\n${body}\nEOF`;
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
  });
  test(`review twenty-three ${mode}: positional, redirection and find-root targets retain expansion flags`, async t => {
    for (const command of ['touch `pwd`/../escaped', 'mkdir `pwd`/../escaped', 'cp source `pwd`/../escaped', 'mv source `pwd`/../escaped', 'tee `pwd`/../escaped', "sed -i 's/a/b/' `pwd`/../escaped", 'rm -r `pwd`/../escaped', 'printf x > `pwd`/../escaped', 'find `pwd`/../victim -delete', 'find -H -- `pwd`/../victim -delete']) {
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.unverifiableMutation, true, command);
      assert.ok(!scope?.targets.includes(resolve(process.cwd(), command.includes("victim") ? "victim" : "escaped")), command);
      if (command.startsWith("find") || command.startsWith("rm") || command.startsWith("printf")) assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["touch '`pwd`/../escaped'", "cp source '`pwd`/../escaped'", "printf x > '`pwd`/../escaped'", "find '`pwd`/../victim' -delete", 'touch \\`pwd\\`/../escaped']) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review twenty-three ${mode}: terminal sort options do not invent later writes`, async t => {
    for (const option of ["--help", "--he", "--version"]) {
      const command = `sort ${option} --output=.git/config --temporary-directory=../outside`;
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.kind, "read-only", command); assert.deepEqual(scope?.targets, []);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["sort --random-source --help --output=output", "sort --help >output"]) assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "known-mutation", command);
    assert.equal(inspectBashPermissionScope({ command: "sort -- --help --output=.git/config" }, process.cwd())?.kind, "read-only");
  });
  test(`review twenty-two ${mode}: parameter transforms preserve main's boundary`, async t => {
    for (const operator of ["P", "E", "A", "K", "k", "Q", "U", "u", "L", "a"]) {
      for (const payload of ["$(sleep 100 &)", "`sleep 100 &`", "hello"]) for (const quote of ['"', ""]) {
        const command = `x='${payload}'; echo ${quote}\${x@${operator}}${quote}`;
        if (operator !== "P") { assert.equal(inspectBashResourceLifecycle({ command }), undefined, command); continue; }
        assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
        const f = await shellHookFixture(t, mode), call = await f.authorize(command);
        assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
      }
    }
    for (const command of ['echo "${a[0]@P}"', 'echo "${1@P}"', 'echo "${x:-${y@P}}"', "bash <<'EOF'\necho \"${x@P}\"\nEOF", "node <<EOF\n${x@P}\nEOF"]) assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
    for (const command of ["echo '${x@P}'", 'echo "\\${x@P}"', 'echo "${x:-literal@P}"', "cat <<'EOF'\n${x@P}\nEOF"]) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
  });
  test(`review twenty-two ${mode}: PS4 delayed xtrace remains opaque`, async t => {
    for (const toggle of ["set -x", "set -o xtrace"]) for (const payload of ["$(sleep 100 &)", "`sleep 100 &`"]) {
      const command = `PS4='${payload}'; ${toggle}; :`;
      assert.equal(inspectBashResourceLifecycle({ command }), undefined);
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
      const f = await shellHookFixture(t, mode, "active");
      assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const payload of ["$(sleep 100 &)", "`sleep 100 &`"]) {
      const command = `export PS4='${payload}'; bash -xc :`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_WRAPPER\]/);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review twenty-one ${mode}: later descriptor copies cannot hide heredoc source`, async t => {
    for (const body of ["sleep 100 &", "echo hi"]) for (const tail of ["exec 4<&3; source /dev/fd/4", "exec 4>&3; . /dev/fd/4", "exec 4<&3-; source /dev/fd/4", "exec 4<&3; exec 5<&4; source /dev/fd/5", "exec 4<&3; exec 5<&3; source /dev/fd/4"]) {
      const command = `exec 3<<'EOF'\n${body}\nEOF\n${tail}`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["exec 3<<'EOF'\necho hi\nEOF\ntrue; source /dev/fd/3", "exec 3<<'EOF' 4<&3\necho hi\nEOF\nsource /dev/fd/4", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; cat <&4", "exec 3<file; exec 4<&3; source /dev/fd/4", "exec 9<<'EOF'\necho hi\nEOF\nexec 3<file; exec 4<&3; source /dev/fd/4"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
    assert.match(inspectBashResourceLifecycle({ command: "exec 4<&3; source /dev/fd/4" }) ?? "", /\[SHELL_HEREDOC\]/);
  });
  test(`review twenty ${mode}: stored executable subscript text refuses before arithmetic use`, async t => {
    const assignment = "x='a[$(sleep 100 &)]'";
    for (const use of ["(( x ))", "echo $(( x ))", "echo $(( $x ))", "for ((i=0;i<x;i++)); do :; done", "let 'y=x'", "[[ x -eq 0 ]]", "echo ${b[x]}", "declare -i z; z=x"]) {
      const command = `${assignment}; ${use}`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const word of ["'a[$(sleep 100 &)]'", '"a[$(sleep 100 &)]"', "$'a[$(sleep 100 &)]'", "a[$(sleep 100 &)]", "'a[`sleep 100 &`]'", "'a[<(sleep 100 &)]'", "'a[>(sleep 100 &)]'", "'a[b[$(sleep 100 &)]]'"]) {
      assert.match(inspectBashResourceLifecycle({ command: `printf '%s' ${word}` }) ?? "", /\[SHELL_UNINSPECTABLE\]/, word);
    }
    for (const marker of ["$(sleep 100 &)", "`sleep 100 &`", "<(sleep 100 &)", ">(sleep 100 &)", "<(printf ok)", ">(printf ok)", "<(printf ok # comment\n)", "<((printf ok); printf done)"]) {
      for (const quote of ["'", '"', "$'", ""]) {
        const word = `${quote}a[${marker}]${quote === "$'" ? "'" : quote}`;
        assert.match(inspectBashResourceLifecycle({ command: `printf '%s' ${word}` }) ?? "", /\[SHELL_UNINSPECTABLE\]/, word);
      }
    }
    for (const command of ["(( 1+1 ))", "(( x ))"]) assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/);
    for (const command of ["echo $(( 1+2 ))", "for ((i=0;i<3;i++)); do :; done", "grep 'a[0-9]' f", "printf '%s' 'a[0] $(sleep 100 &)'", "printf '%s' 'a[' '$(sleep 100 &)'", "printf '%s' 'a[$(sleep 100 &)'"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review twenty ${mode}: find continues after delete and treats fstype as data`, async t => {
    for (const action of ["-fprint", "-fprint0", "-fprintf", "-fls"]) {
      const command = `find scratch -delete ${action} .git/config${action === "-fprintf" ? " '%p'" : ""}`;
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.ok(scope?.targets.some(target => target.endsWith(".git/config") || target.endsWith(".git\\config")), command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const command of ["find . -fstype -fprint", "find . -fstype -delete", "find . -fstype -exec"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review twenty ${mode}: reported init-file and here-string payloads already refuse`, async t => {
    for (const command of ["bash --init-file /dev/fd/3 -i 3<<'EOF'\nsleep 100 &\nEOF", "bash --rcfile /dev/fd/3 -i 3<<'EOF'\nsleep 100 &\nEOF\necho done", "source /dev/stdin <<< 'sleep 100 >/dev/null 2>&1 &'; true"]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_(?:WRAPPER|HEREDOC)\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review twenty ${mode}: Bash dump and Node completion modes do not execute stdin`, async t => {
    for (const header of ["bash -D", "bash +D", "bash -nD", "bash -Di", "bash --dump-strings", "bash --dump-po-strings", "bash -D +n", "bash --dump-strings -i", "node --completion-bash", "node --completion-bash -i", "node -i --completion-bash"]) {
      const body = header.startsWith("bash") ? "sleep 100 &" : "fs.rmSync('/protected',{recursive:true})";
      const command = `${header} <<'EOF'\n${body}\nEOF`;
      assert.equal(heredocConsumer(header), undefined, header);
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const header of ["bash --rcfile --dump-strings", "bash --init-file -D", "node --title --completion-bash -"]) {
      assert.ok(heredocConsumer(header), header);
      const body = header.startsWith("bash") ? "sleep 100 &" : "fs.rmSync(target,{recursive:true})";
      const command = `${header} <<'EOF'\n${body}\nEOF`;
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review nineteen ${mode}: find output targets retain expansion flags`, async t => {
    for (const action of ["-fprint", "-fprint0", "-fprintf", "-fls"]) {
      const command = `find . -maxdepth 0 ${action} \u0060pwd\u0060/../outside${action === "-fprintf" ? " '%p'" : ""}`;
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, true, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["find . -fprint '`pwd`/../outside'", "find . -name -fprint", "find . -fprintf output '`pwd`/../outside'"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review nineteen ${mode}: unknown transforms cannot hide shell heredoc source`, async t => {
    for (const consumer of ["source /dev/stdin", ". /dev/stdin", "bash", "sh"]) {
      const command = `cat <<'EOF' | tr X '&' | ${consumer}\nsleep 100 X\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["cat <<'EOF' | tr X '&' | cat\nsleep 100 X\nEOF", "cat <<'EOF' | tr X '&' >output | source /dev/stdin\nsleep 100 X\nEOF"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review nineteen ${mode}: encoded and partial literal targets remain unverifiable`, async t => {
    for (const body of ['shutil.rmtree("\\x2egit")', 'shutil.rmtree("\\u002egit")', 'shutil.rmtree("\\056git")', 'shutil.rmtree(".gi" "t")']) {
      const command = `python3 <<'EOF'\n${body}\nEOF`;
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["node <<'EOF'\nfs.rmSync('\\x2egit',{recursive:true})\nEOF", "node <<'EOF'\nfs.rmSync('.gi'+'t',{recursive:true})\nEOF"]) {
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const body of ['shutil.rmtree("scratch")', 'shutil.rmtree("say\\\"hi")']) {
      const command = `python3 <<'EOF'\n${body}\nEOF`;
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review eighteen ${mode}: mapfile callbacks always retain lifecycle refusal`, async t => {
    for (const name of ["mapfile", "readarray"]) for (const command of [
      `${name} -C 'sleep 100 &' -c 1 a < f.txt; echo ok`, `${name} -C 'sleep 100 &' -c 1 a < f.txt`,
      `${name} -tC 'sleep 100 &' -c 1 a < f.txt`, `${name} -C"sleep 100 &" -c 1 a < f.txt`,
      `builtin ${name} -C 'sleep 100 &' -c 1 a < f.txt`, `if ${name} -tC 'sleep 100 &' a < f.txt; then :; fi`,
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["mapfile -t a < f.txt", "readarray -d C -n 1 -s 0 -c 1 -u 0 a < f.txt", "mapfile -dC a < f.txt", "mapfile -- a < f.txt", "echo 'mapfile -C sleep'"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), command.startsWith("echo") || mode === "full-access" ? 0 : 1);
    }
  });
  test(`review eighteen ${mode}: unsafe Bash test operands retain main refusal`, async t => {
    for (const command of [
      "[[ -v 'a[$(sleep 100 &)]' ]]", "[ -v 'a[$(sleep 100 &)]' ]", "test -v 'a[$(sleep 100 &)]'",
      "[[ 'a[$(sleep 100 &)]' -eq 0 ]]", "[[ x -eq y ]]", "[[ -v a[x] ]]", "[[ -v 'a[0]' ]]",
      "builtin test -v 'a[$(sleep 100 &)]'", "if test -v a[x]; then :; fi", "! [ -v a[x] ]",
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    assert.match(inspectBashResourceLifecycle({ command: "(( a[$(sleep 100 &)] ))" }) ?? "", /\[SHELL_UNINSPECTABLE\]/);
    for (const command of ["[[ -v HOME ]]", "[ -v HOME ]", "test -v HOME", "[[ 1 -eq 1 ]]", "printf '%s' '[[ -v a[x] ]]'"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review eighteen ${mode}: builtin name subscripts cannot conceal arithmetic execution`, async t => {
    const operand = "a[$(sleep 100 &)]";
    for (const command of [
      `printf -v '${operand}' '%s' value`, `printf -v'${operand}' '%s' value`, `read '${operand}' < f.txt`, `read -ra '${operand}' < f.txt`,
      `unset '${operand}'`, `declare '${operand}=1'`, `local '${operand}=1'`, `typeset '${operand}=1'`,
      `readonly '${operand}=1'`, `export '${operand}=1'`, `let '${operand}=1'`, `let 'x=${operand}'`,
      `let '-${operand}'`, `let '+${operand}'`, `printf -v first -v '${operand}' '%s' value`, `printf -vfirst -v'${operand}' '%s' value`,
      "printf -v a[x] '%s' value", "read a[x] < f.txt", "declare -i 'x=a[y]'",
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["printf -v 'a[0]' '%s' 'a[x]'", "printf -v first -v 'a[0]' '%s' 'a[x]'", "read -p 'a[x]' 'a[0]' < f.txt", "unset 'a[0]'", "declare 'a[123]=1'", "let 'a[0]=1'", "let '-a[0]'", "let '+a[0]'"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review seventeen ${mode}: sort targets retain executable expansion metadata`, async t => {
    for (const command of [
      'sort -o `pwd`/../outside input', 'sort -o"`pwd`/../outside" input', 'sort -ro`pwd`/../outside input',
      'sort --output=`pwd`/../outside input', 'sort --out `pwd`/../outside input', 'sort -T tmp --o=`pwd`/../outside input',
      'sort -T `pwd`/../outside input', 'sort -T`pwd`/../outside input', 'sort --te=`pwd`/../outside input',
      'sort --temporary-directory "`pwd`/../outside" input', 'sort > /dev/null -o `pwd`/../outside input',
    ]) {
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.unverifiableMutation, true, command); assert.equal(scope?.dynamicScope, true);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["sort -o '`pwd`/../outside' input", "sort --out='`pwd`/../outside' input", "sort -T'`pwd`/../outside' input", 'sort -o \\`pwd\\`/../outside input']) {
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.kind, "known-mutation", command); assert.equal(scope?.unverifiableMutation, false); assert.equal(scope?.dynamicScope, false);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), 0);
    }
    const command = 'sort -- --out=`pwd`/../outside';
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "read-only");
    const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), 0);
  });
  test(`review sixteen ${mode}: function substitutions retain main lifecycle boundaries`, async t => {
    const script = "sleep 100 &";
    for (const consumer of ["source /dev/stdin", "bash", "sh", ". /dev/stdin"]) {
      const substitution = `\u0024{ ${consumer} <<'EOF'\n${script}\nEOF\n; }`;
      for (const command of [`echo ${substitution}`, `echo "${substitution}"`, `VALUE=${substitution}`, `echo \u0024{ echo ${substitution}; }`, `echo $(echo ${substitution})`]) {
        assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
        const f = await shellHookFixture(t, mode), call = await f.authorize(command);
        assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
      }
    }
    for (const command of ['echo "${ sleep 100 & }"', 'echo "${| sleep 100 & REPLY=1; }"', 'echo ${ echo "${ printf hi; }"; }', 'echo ${ printf hi', 'echo ${ case x in x) printf hi;; esac; }']) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_UNINSPECTABLE\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["echo ${ sleep 100 & }", "echo ${| sleep 100 & REPLY=1; }", "echo ${ echo ${ sleep 100 & }; }", "echo $(echo ${ sleep 100 & })", "echo $(sleep 100 &)", "echo ${ bash -c 'sleep 100 &'; }"]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    }
    for (const command of ["echo ${ printf hi; }", "echo ${| REPLY=hi; }", "echo ${ echo ${ printf hi; }; }", "echo ${ echo $((1 << 3)); }", "echo '${ sleep 100 & }'", "echo ${x:-literal}", '# echo "${ sleep 100 & }"\nprintf hi']) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
    assert.match(inspectBashResourceLifecycle({ command: "echo ${ bash <\\\n<'EOF'\nsleep 100 &\nEOF\n; }" }) ?? "", /\[SHELL_HEREDOC\]/);
  });
  test(`review sixteen ${mode}: CR-dependent heredoc boundaries retain main refusal`, async t => {
    const commands = [
      "cat <<'EOF'\nbody\nEOF\r\nsleep 100 &\nEOF", "node <<'EOF'\nbody\nEOF\r\nsleep 100 &\nEOF",
      "cat <<'EOF'\nbody\nE\rOF\nsleep 100 &\nEOF", "cat <<'EO\rF'\nbody\nEO\rF",
      "cat <<EOF\nbody\\\r\nmore\nEOF", "echo text\\\r\nnext", "printf '%s' '\\\r'",
    ];
    for (const consumer of ["bash", "sh", "source /dev/stdin", ". /dev/stdin", "cat | source /dev/stdin"]) commands.push(`${consumer} <<'EOF'\nprintf h\ri\nEOF`);
    for (const command of commands) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["cat <<'EOF'\na\rb\nEOF", "cat <<EOF\na\rb\nEOF", "node <<'EOF'\n/*a\rb*/\nconsole.log('ok')\nEOF"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
  });
  test(`review sixteen ${mode}: syntax-only Bash and help-only Python do not execute stdin`, async t => {
    for (const header of ["bash -n", "bash -en", "bash -n -s", "bash -o noexec", "bash -n +n -n", "python3 --help-env", "python3 --help-xoptions", "python3 --help-all"]) {
      const body = header.startsWith("bash") ? "sleep 100 &" : "shutil.rmtree(target)";
      const command = `${header} <<'EOF'\n${body}\nEOF`;
      assert.equal(heredocConsumer(header), undefined, header);
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const header of ["bash -n +n", "bash -o noexec +o noexec", "bash -ni", "bash -in", "python3 -W --help-env", "python3 -X --help-all"]) assert.ok(heredocConsumer(header), header);
    for (const command of ["bash -n +n <<'EOF'\nsleep 100 &\nEOF", "bash -n <<EOF\n$(sleep 100 &)\nEOF", "bash -n -c +n 'source /dev/stdin' <<'EOF'\nsleep 100 &\nEOF"]) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review sixteen ${mode}: CR-bearing lines cannot close an LF heredoc early`, async t => {
    for (const delimiter of ["'EOF'", "EOF"]) {
      const body = "/*\nEOF\r\n*/\nfs.rmSync(target,{recursive:true})\n";
      const command = `node <<${delimiter}\n${body}EOF`;
      assert.equal(prepareShellAnalysis(command).unboundedHeredoc, true);
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review sixteen ${mode}: leading blank lines and comments do not change fixed heredoc targets`, async t => {
    for (const prefix of ["\n", " \t\n\n", "# comment\n", "\n  # comment\n\t\n", "\\\n\n"]) {
      const command = `${prefix}node <<'EOF'\nfs.rmSync('./scratch',{recursive:true})\nEOF`;
      assert.equal(prepareShellAnalysis(command).hereDocuments?.[0]?.priorSource, false);
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, false);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    const command = "cd elsewhere\nnode <<'EOF'\nfs.rmSync('./scratch',{recursive:true})\nEOF";
    assert.equal(prepareShellAnalysis(command).hereDocuments?.[0]?.priorSource, true);
    const f = await shellHookFixture(t, mode), call = await f.authorize(command);
    assert.equal(call.outcome?.block, true); assert.equal(f.dialogs(), 0);
  });
  test(`review fifteen ${mode}: later lookup state cannot invalidate earlier mutation targets`, async t => {
    for (const command of ["rm -r scratch; PATH=/tmp; echo ok", "touch scratch; PATH=/tmp; echo ok", "rm -r scratch; export PATH=/tmp; echo ok", "rm -r scratch; hash -p /tmp/echo echo; echo ok"]) {
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true, command);
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const command of ["PATH=/tmp; rm -r scratch", "rm -r first; PATH=/tmp; rm -r second", "for x in 1 2; do rm -r scratch; PATH=/tmp; done; echo ok", "echo ok; PATH=/tmp; echo $(rm -r scratch)", "rm -r first; PATH=/tmp; echo $(rm -r second)", "echo ok; PATH=/tmp; bash -c 'rm -r scratch'"]) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review fourteen ${mode}: newline function bodies retain executable stdin`, async t => {
    for (const definition of ["function f\n{ source /dev/stdin; }", "function f\n\n# trivia\n{ source /dev/stdin; }", "f()\n{ source /dev/stdin; }"]) {
      const command = `${definition}; f <<'EOF'\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command); assert.equal(call.outcome?.block, true); assert.equal(f.dialogs(), 0);
    }
    const command = "function f\n{ cat; }; f <<'EOF'\nsleep 100 &\nEOF";
    const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
  });
  test(`review fourteen ${mode}: operand-free Node flags preserve program file data`, async t => {
    for (const flag of ["--no-addons", "--no-experimental-repl-await", "--permission", "--experimental-strip-types", "--zero-fill-buffers"]) {
      const command = `node ${flag} script.js <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF`;
      assert.equal(heredocConsumer(`node ${flag} script.js`), undefined);
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
      const stdin = `node ${flag} <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF`;
      const deny = await shellHookFixture(t, mode), call = await deny.authorize(stdin); assert.equal(call.outcome?.block, true); assert.equal(deny.dialogs(), 0);
    }
  });
  test(`review fourteen ${mode}: wrapped lost descriptors refuse and known contents recurse`, async t => {
    for (const reader of ["bash -c 'source /dev/fd/3'", 'bash -c \'bash -c "source /dev/fd/3"\'']) {
      for (const body of ["sleep 100 &", "echo hi"]) {
        const command = `exec 3<<'EOF'\n${body}\nEOF\necho ok; ${reader}`;
        assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/);
        const f = await shellHookFixture(t, mode), call = await f.authorize(command); assert.equal(call.outcome?.block, true); assert.equal(f.dialogs(), 0);
      }
      const command = `exec 3<<'EOF'\necho hi\nEOF\ntrue; ${reader}`;
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
  });
  test(`review fourteen ${mode}: disconnected pipeline data does not become a script`, async t => {
    for (const pipeline of ["cat <<'EOF' >out | source /dev/stdin", "cat <<'EOF' | cat >out | source /dev/stdin", "cat <<'EOF' 1>&2 | source /dev/stdin", "cat <<'EOF' | source /dev/stdin </dev/null"]) {
      const command = `${pipeline}\nsleep 100 &\nEOF`;
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
    for (const redirection of ["2>errors", "3>&1 >out 1>&3", "2>&1 >out 1>&2", "3>&1 >out 1>&3-"]) {
      const command = `cat <<'EOF' ${redirection} | source /dev/stdin\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command); assert.equal(call.outcome?.block, true); assert.equal(f.dialogs(), 0);
    }
  });
  test(`D3 ${mode}: sourced setup heredocs cannot change later consumers through aliases`, async t => {
    for (const setup of ["shopt -s expand_aliases\nalias node='source /dev/stdin'", "BASH_ALIASES[node]='source /dev/stdin'", "source ./aliases.sh", "eval 'alias node=source'"]) {
      const command = `source /dev/stdin <<'SETUP'\n${setup}\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    const command = "source /dev/stdin <<'SETUP'\nprintf ok\nSETUP\nnode <<'EOF'\nconsole.log(1)\nEOF";
    assert.equal(inspectBashResourceLifecycle({ command }), undefined);
    const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
  });
  test(`D3 ${mode}: unbound inherited script descriptors retain lifecycle refusal`, async t => {
    for (const command of ["source /dev/fd/3", ". /proc/self/fd/63", "builtin -- source /dev/fd/7", "command . /dev/fd/63", "exec 3<<'EOF'\necho hi\nEOF\nsource /dev/fd/4", "source /dev/fd/3; exec 3<<'EOF'\necho hi\nEOF"]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["cat /dev/fd/63", "source /dev/fd/3 3<input", "exec 3<input; source /dev/fd/3", "source /dev/fd/3 3<<'EOF'\necho hi\nEOF"]) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
  });
  test(`D3 ${mode}: possible alias changes retain heredoc lifecycle refusal`, async t => {
    for (const prefix of [
      "shopt -s expand_aliases", 'shopt -s "$OPTION"', 'shopt "$FLAGS" expand_aliases',
      "alias node='source /dev/stdin'", "BASH_ALIASES[node]='source /dev/stdin'",
      "source ./aliases.sh", ". ./aliases.sh", 'eval "alias node=source"',
      "builtin alias node='source /dev/stdin'", "command shopt -s expand_aliases",
      "declare -A BASH_ALIASES=([node]='source /dev/stdin')",
      "function setup { source ./aliases.sh; }; setup", "setup() { alias node='source /dev/stdin'; }; setup",
    ]) {
      const command = `${prefix};\nnode <<'EOF'\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["node <<'EOF'\nconsole.log('hi')\nEOF", "shopt -s nullglob; node <<'EOF'\nconsole.log('hi')\nEOF", "alias node='echo hi'", "echo alias; node <<'EOF'\nconsole.log('hi')\nEOF"]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
    }
    assert.match(inspectBashResourceLifecycle({ command: "node() { source /dev/stdin; }; node <<'EOF'\nsleep 100 &\nEOF" }) ?? "", /Blocked an unmanaged long-lived process/);
  });
  test(`D3 ${mode}: sort unique prefixes retain targets and opaque options`, async t => {
    for (const option of ["--out=../outside", "--o=../outside", "--outp ../outside"]) {
      const command = `sort -T tmp ${option}`, scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.kind, "known-mutation"); assert.ok(scope?.targets.includes(resolve("../outside")), command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const [short, full] of [["--te=../outside", "--temporary-directory=../outside"], ["--te ../outside", "--temporary-directory ../outside"], ["--comp=gzip", "--compress-program=gzip"], ["--comp gzip", "--compress-program gzip"]]) {
      const command = `sort -T tmp ${short}`;
      assert.deepEqual(inspectBashPermissionScope({ command }, process.cwd()), inspectBashPermissionScope({ command: `sort -T tmp ${full}` }, process.cwd()));
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
    for (const command of ["sort --c", "sort -- --out=x"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "read-only");
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), 0);
    }
    for (const command of ["sort -T tmp --unknown-option", "sort --unknown-option -T tmp"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command)); assert.equal(f.dialogs(), mode === "workspace-write" ? 1 : 0);
    }
  });
}

test("review sixteen: heredoc delimiters and continuations preserve literal CR bytes", () => {
  for (const command of ["cat <<'EOF'\r\nx\r\nEOF\r\n", "cat <<EOF\r\nx\r\nEOF\r\n"]) {
    const view = prepareShellAnalysis(command);
    assert.equal(view.unboundedHeredoc, true);
  }
  const command = "cat <<EOF\na\\\r\nb\nEOF";
  assert.equal(prepareShellAnalysis(command).unboundedHeredoc, true);
  assert.equal(prepareShellAnalysis("cat <<'EOF'\nx\nEOF\r\n").unboundedHeredoc, true);
});

test("review sixteen: function and CR judgments reuse existing scans and primitive counters", () => {
  const command = "echo ${ printf hi; }";
  const calls = shellAnalysisCounters.functionBoundaryCalls, chars = shellAnalysisCounters.functionBoundaryChars;
  assert.deepEqual(extractCommandSubstitutions(command).scripts, [" printf hi; "]);
  assert.equal(shellAnalysisCounters.functionBoundaryCalls - calls, 1);
  assert.ok(shellAnalysisCounters.functionBoundaryChars - chars <= command.length);
  const source = "cat <<'EOF'\na\rb\nEOF", comparisons = shellAnalysisCounters.crComparisons;
  const view = prepareShellAnalysis(source);
  assert.equal(view.hereDocuments?.[0]?.hasCarriageReturn, true);
  assert.equal(view.hereDocuments?.[0]?.body, "a\rb\n");
  assert.equal(shellAnalysisCounters.crComparisons - comparisons, 6, "each non-newline body/delimiter character is compared once");
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`D3 ${mode}: lost heredoc descriptor source retains lifecycle refusal`, async t => {
    for (const reader of ["source /dev/fd/3", ". /proc/self/fd/3", "builtin -- source /dev/fd/3", "command . /dev/fd/3"]) {
      for (const body of ["sleep 100 &", "echo hi"]) {
        const command = `exec 3<<'EOF'\n${body}\nEOF\necho ok; ${reader}`;
        assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
        const f = await shellHookFixture(t, mode), call = await f.authorize(command);
        assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
      }
    }
  });
  test(`D3 ${mode}: descriptor binding data and known readonly source remain admitted`, async t => {
    for (const command of [
      "exec 3<<'EOF'\necho hi\nEOF\ntrue; source /dev/fd/3",
      "exec 3<<'EOF'\necho hi\nEOF\n:; . /dev/fd/3",
      "exec 3<<'A'\nsleep 100 &\nA\nexec 3<<'B'\necho hi\nB\nsource /dev/fd/3",
      "exec 3<<'EOF'\nsleep 100 &\nEOF\necho ok",
      "exec 3<<'EOF'\nsleep 100 &\nEOF\necho ok; cat /dev/fd/3",
      "exec 3<<'EOF'\nsleep 100 &\nEOF\necho ok; cat /dev/fd/4",
      "cat <<'EOF'\nsleep 100 &\nEOF\necho ok",
    ]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    const launch = "exec 3<<'EOF'\nsleep 100 &\nEOF\ntrue; source /dev/fd/3";
    assert.match(inspectBashResourceLifecycle({ command: launch }) ?? "", /Blocked an unmanaged long-lived process/);
  });
  test(`D3 ${mode}: find output target overflow cannot obtain authority`, async t => {
    const outputs = Array.from({ length: 16 }, (_, i) => `-fprint result-${i}`).join(" ");
    const command = `find . ${outputs} -fprint .git/config`;
    const scope = inspectBashPermissionScope({ command }, process.cwd());
    assert.equal(scope?.targets.length, 16); assert.equal(scope?.unverifiableMutation, true);
    const f = await shellHookFixture(t, mode), call = await f.authorize(command);
    assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    const within = inspectBashPermissionScope({ command: `find . ${outputs}` }, process.cwd());
    assert.equal(within?.unverifiableMutation, false); assert.equal(within?.targets.length, 16);
  });
}

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
    if (header === "source script.sh") {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, "file sourcing may change aliases");
      continue;
    }
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
  assert.match(inspectBashResourceLifecycle({ command: data }) ?? "", /\[SHELL_HEREDOC\]/, "file sourcing may change aliases");
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
      const standalone = await f.authorize(prefix);
      if (prefix.startsWith("[[") || prefix.startsWith("((")) {
        // The user restored main's test-operand and standalone arithmetic boundaries.
        assert.equal(standalone.outcome?.block, true); assert.equal(standalone.outcome?.finalAuthorization, undefined);
        assert.match(standalone.outcome?.reason ?? "", /\[SHELL_UNINSPECTABLE\]/);
      } else assertFinalAuthorization(standalone);
    }
  }
});

test("compound commands and literal wrappers propagate executable heredoc input", async t => {
  for (const header of ["{ source /dev/stdin; }", "{ { source /dev/stdin; }; }", "(source /dev/stdin)", "{ cat; source /dev/stdin; }", "{ ! source /dev/stdin; }", "{ time source /dev/stdin; }", "X=value source /dev/stdin", "bash -c 'source /dev/stdin'", "bash -c 'builtin source /dev/stdin'", "bash -c 'eval source /dev/stdin'"]) {
    const command = `${header} <<'EOF'\nsleep 100 &\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", header.includes("eval") ? /\[SHELL_HEREDOC\]/ : /Blocked an unmanaged long-lived process/, command);
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
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_HEREDOC\]/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  assert.match(inspectBashResourceLifecycle({ command: "bash -c 'eval >out cat' <<'EOF'\nsleep 100 &\nEOF" }) ?? "", /\[SHELL_HEREDOC\]/);
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
  assert.equal(inspectBashResourceLifecycle({ command: 'alias run="$SCRIPT"\nrun' }), undefined);
  assert.match(inspectBashResourceLifecycle({ command: "{ alias run='source /dev/stdin'; run; } <<'EOF'\nsleep 30 &\nEOF" }) ?? "", /\[SHELL_HEREDOC\]/);
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
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
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

test("supported transformed heredoc streams inspect the decoded executable input", async t => {
  for (const header of ["base64 -d <<'EOF' | source /dev/stdin", "cat <<'EOF' | base64 -d | source /dev/stdin"]) {
    const command = `${header}\nc2xlZXAgMTAwICYK\nEOF`;
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const [consumer, script] of [["node", "fs.rmSync(target,{recursive:true})"], ["python", "shutil.rmtree(target)"]]) {
    const command = `base64 -d <<'EOF' | ${consumer}\n${Buffer.from(script!).toString("base64")}\nEOF`;
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
  for (const command of ['ACTION=\'sleep 100 &\'; trap "$ACTION" EXIT; true', 'ACTION=\'sleep 100 &\'; trap -- "$ACTION" EXIT', 'ACTION=\'sleep 100 &\'; builtin trap "$ACTION" EXIT']) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
    for (const mode of ["full-access", "workspace-write"] as const) {
      const f = await shellHookFixture(t, mode), { outcome } = await f.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  }
  for (const command of ["trap 'printf ok' EXIT", "trap - EXIT", 'trap -p "$SIGNAL"']) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
});

const d3ReadOnlyCases = [
  ["Node value-free flag data", "node --no-warnings script.js <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF"],
  ["redefined function data", "f(){ source /dev/stdin; }; f(){ cat; }; f <<'EOF'\nsleep 100 &\nEOF"],
  ["superseded heredoc data", "source /dev/stdin <<'A' <<'B'\nsleep 100 &\nA\nprintf ok\nB"],
  ["superseded heredoc by input file", "source /dev/stdin <<'A' </dev/null\nsleep 100 &\nA"],
  ["unrelated function and read", "f(){ :; }; read x <<'EOF'\nhello\nEOF"],
  ["persistent descriptor readonly source", "exec 3<<'EOF'\nprintf ok\nEOF\nsource /dev/fd/3"],
  ["persistent descriptor data", "exec 3<<'EOF'\nsleep 100 &\nEOF\ncat /dev/fd/3"],
  ["literal process source readonly", "source <(echo 'printf ok')"],
  ["literal process source data", "cat <(echo 'sleep 100 &')"],
  ["python interactive readonly", "python3 -i -c 'pass' <<'EOF'\nprint(1)\nEOF"],
  ["expanded trap", 'ACTION=\'printf ok\'; trap "$ACTION" EXIT; true'],
  ["function data consumer", "f(){ cat; }; f <<'EOF'\nhello\nEOF"],
  ["unrelated function and wc", "f(){ printf ok; }; wc -c <<'EOF'\nhello\nEOF"],
  ["encoded read-only script", "base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9rCg==\nEOF"],
  ["expanded alias", 'ACTION=\'printf ok\'; alias run="$ACTION"\nrun'],
  ["unresolved alias", 'alias run="$UNKNOWN_ACTION"\nrun'],
  ["unrelated executable function", "f(){ source /dev/stdin; }; wc -c <<'EOF'\nsleep 100 &\nEOF"],
] as const;
const d3RejectedCases = [
  ["concatenated delimiter mutation", "bash", 'node <<";""EOF"\n;\nfs.rmSync(target,{recursive:true})\n;EOF'],
  ["final function executable body", "bash", "f(){ cat; }; f(){ source /dev/stdin; }; f <<'EOF'\nsleep 100 &\nEOF"],
  ["final heredoc executable body", "bash", "source /dev/stdin <<'A' <<'B'\nprintf ok\nA\nsleep 100 &\nB"],
  ["persistent descriptor launch", "bash", "exec 3<<'EOF'\nsleep 100 &\nEOF\nsource /dev/fd/3"],
  ["persistent descriptor mutation", "bash", "exec 3<<'EOF'\nrm -rf \"$X\"\nEOF\nsource /dev/fd/3"],
  ["python interactive mutation", "bash", "python3 -i -c 'pass' <<'EOF'\nimport shutil; shutil.rmtree('/protected')\nEOF"],
  ["literal process source launch", "bash", "source <(echo 'sleep 100 &')"],
  ["literal process source mutation", "bash", "source <(printf '%s' 'rm -rf \"$X\"')"],
  ["dynamic rm", "bash", 'rm -rf "$X"'],
  ["dynamic PowerShell remove", "powershell", "Remove-Item -Recurse $x"],
  ["function dynamic rm", "bash", 'f(){ rm -rf "$X"; }; f <<\'EOF\'\nhello\nEOF'],
  ["trap dynamic rm", "bash", 'ACTION=\'rm -rf "$X"\'; trap "$ACTION" EXIT; true'],
  ["encoded dynamic rm", "bash", `base64 -d <<'EOF' | source /dev/stdin\n${Buffer.from('rm -rf "$X"\n').toString("base64")}\nEOF`],
  ["function unmanaged launch", "bash", "f(){ source /dev/stdin; }; f <<'EOF'\nsleep 100 &\nEOF"],
  ["encoded unmanaged launch", "bash", "base64 -d <<'EOF' | source /dev/stdin\nc2xlZXAgMTAwICYK\nEOF"],
  ["expanded trap unmanaged launch", "bash", 'ACTION=\'sleep 100 &\'; trap "$ACTION" EXIT; true'],
  ["expanded alias unmanaged launch", "bash", 'ACTION=\'sleep 100 &\'; alias run="$ACTION"\nrun'],
  ["expanded alias dynamic rm", "bash", 'ACTION=\'rm -rf "$X"\'; alias run="$ACTION"\nrun'],
] as const;
for (const mode of ["full-access", "workspace-write"] as const) {
  for (const [name, command] of d3ReadOnlyCases) test(`D3 ${mode}: readonly ${name} follows permission mode`, async t => {
    const f = await shellHookFixture(t, mode, "active");
    assertFinalAuthorization(await f.authorize(command));
    assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
  });
  for (const [name, tool, command] of d3RejectedCases) test(`D3 ${mode}: recognized ${name} cannot receive authority`, async t => {
    const f = await shellHookFixture(t, mode, "active"), call = await f.authorize(command, tool);
    try { assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0); }
    finally { call.outcome?.finalAuthorization?.release(); }
  });
}

test("literal source resolution is bounded and does not reuse uncertain assignment state", () => {
  assert.equal(decodeLiteralBase64(Buffer.from("printf 日本語\n").toString("base64")), "printf 日本語\n");
  assert.equal(decodeLiteralBase64("a".repeat(128 * 1024 + 1)), undefined);
  assert.equal(decodeLiteralBase64("%%%"), undefined);
  assert.equal(decodeLiteralBase64("/w=="), undefined, "invalid UTF-8 remains opaque");
  assert.equal(literalStoredScripts('ACTION=\'sleep 100 &\'; unset ACTION; trap "$ACTION" EXIT'), undefined);
  assert.equal(literalStoredScripts('ACTION=\'sleep 100 &\'; ACTION="$OTHER"; trap "$ACTION" EXIT'), undefined);
  assert.deepEqual(literalStoredScripts('ACTION=\'printf ok\'; trap "$ACTION" EXIT'), ["printf ok"]);
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`D3 ${mode}: unresolved trap retains main lifecycle refusal`, async t => {
    // main 1581af873 rejects the first two via SHELL_UNINSPECTABLE; this PR
    // retains refusal with the specific SHELL_WRAPPER diagnostic, like eval.
    for (const command of [
      'ACTION=\'sleep 100 &\'; true; trap "$ACTION" EXIT',
      'trap "$ACTION" EXIT',
      'trap "$(printf ok)" EXIT',
      'builtin trap -- "$ACTION" EXIT',
      'ACTION=\'printf ok\'; trap "$ACTION" EXIT; trap "$OTHER" INT',
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /\[SHELL_WRAPPER\]/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
}

test("D3 Python f-string expressions remain opaque executable source", () => {
  const command = `python3 <<'EOF'\nimport shutil\nf"{shutil.rmtree('/protected')}"\nEOF`;
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
});

const d3UnanalyzedPrograms = [
  ["dynamic executable", 'CMD=setsid; $CMD -f sleep 100'],
  ["dynamic shell wrapper", 'X=bash; "$X" -c \'sleep 100 >/dev/null 2>&1 &\''],
  ["Perl heredoc", "perl <<'EOF'\nsystem(\"sleep 100 &\")\nEOF"],
  ["Ruby heredoc", "ruby <<'EOF'\nsystem(\"sleep 100 &\")\nEOF"],
  ["Perl -e", "perl -e 'system(\"sleep 100 &\")'"],
  ["Ruby -e", "ruby -e 'system(\"sleep 100 &\")'"],
  ["Node parameter body", 'PAYLOAD="require(\'node:fs\').rmSync(\'/protected\',{recursive:true})"; node <<EOF\n$PAYLOAD\nEOF'],
  ["Python parameter body", 'PAYLOAD="import shutil; shutil.rmtree(\'/protected\')"; python <<EOF\n$PAYLOAD\nEOF'],
  ["Node substitution body", "node <<EOF\n$(printf '%s' 'fs.rmSync(target,{recursive:true})')\nEOF"],
  ["Python substitution body", "python <<EOF\n$(printf '%s' 'shutil.rmtree(target)')\nEOF"],
] as const;
for (const mode of ["full-access", "workspace-write"] as const) {
  for (const [name, command] of d3UnanalyzedPrograms) test(`D3 ${mode}: unanalyzed ${name} follows permission mode`, async t => {
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
    const mutation = inspectHighRiskBashMutation({ command }, process.cwd());
    assert.notEqual(mutation?.mutationDetected, true);
    if (name.startsWith("Node") || name.startsWith("Python")) {
      assert.equal(prepareShellAnalysis(command).hereDocuments?.[0]?.expanded, true);
      assert.ok(mutation?.primitives.includes("heredoc_expanded_source"), "expanded executable text is recorded as unanalyzed, not safe");
    }
    const f = await shellHookFixture(t, mode, "active");
    assertFinalAuthorization(await f.authorize(command));
    assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
  });
  test(`D3 ${mode}: outer Perl launch and original eval refusal remain blocked`, async t => {
    for (const command of ["perl -e 'print 1' &", 'eval "$SCRIPT"']) {
      const refusal = inspectBashResourceLifecycle({ command });
      assert.match(refusal ?? "", command.startsWith("eval") ? /\[SHELL_WRAPPER\]/ : /Blocked an unmanaged long-lived process/);
      const f = await shellHookFixture(t, mode, "active"), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
}

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review nine ${mode}: later state cannot invalidate an earlier fixed mutation`, async t => {
    for (const command of ["touch target; printf -v X foo", 'touch target; printf "%s" "${X:=foo}"']) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    for (const command of ["printf -v X foo; touch target", "touch first; printf -v X foo; touch second", 'touch first; rm "$X"']) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review nine ${mode}: Node interactive eval and print preserve executable stdin`, async t => {
    for (const header of ["node --interactive --eval 'void 0'", "node -i -p '0'", "node --eval 'void 0' -i", "node --print=0 --interactive", "node --require helper.js -i -e 'void 0'"]) {
      assert.equal(heredocConsumer(header), "node", header);
      const command = `${header} <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF`;
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, header); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    for (const header of ["node -e 'void 0'", "node --eval 'void 0' --no-warnings", "node script.js -i", "node -e 'void 0' -- -i"]) assert.equal(heredocConsumer(header), undefined, header);
  });
  test(`review nine ${mode}: parenthesized function keyword preserves source consumption`, async t => {
    const command = "function f() { source /dev/stdin; }; f <<'EOF'\nsleep 100 &\nEOF";
    const f = await shellHookFixture(t, mode), call = await f.authorize(command);
    assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    const data = "function f() { source /dev/stdin; }; function f() { cat; }; f <<'EOF'\nsleep 100 &\nEOF";
    const read = await shellHookFixture(t, mode); assertFinalAuthorization(await read.authorize(data));
    assert.equal(read.dialogs(), mode === "full-access" ? 0 : 1);
  });
  test(`review nine ${mode}: every embedded mutation call contributes its target`, async t => {
    for (const [header, source] of [
      ["node --input-type=commonjs", "fs.rmSync('./scratch',{recursive:true}); fs.rmSync('/',{recursive:true})"],
      ["node", "fs.unlinkSync('./scratch'); fs.unlinkSync('/')"],
      ["python", "shutil.rmtree('./scratch'); shutil.rmtree('/')"],
      ["python", "Path('./scratch').unlink(); Path('/').unlink()"],
    ]) {
      const command = `${header} <<'EOF'\n${source}\nEOF`, scan = inspectHighRiskBashMutation({ command }, process.cwd());
      assert.deepEqual(scan?.targets, [resolve('./scratch'), resolve('/')], header);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assertFinalAuthorization(call);
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1, "fixed targets retain existing permission policy");
    }
    const command = "node <<'EOF'\nfs.rmSync('./scratch',{recursive:true}); fs.rmSync(target,{recursive:true})\nEOF";
    const f = await shellHookFixture(t, mode), call = await f.authorize(command);
    assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
  });
  test(`review nine ${mode}: find predicate operands are data`, async t => {
    for (const command of ["find . -name -fprint", "find . -iname -delete", "find . -path -fprint0", "find . -regex -fls", "find . -printf -fprintf"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), 0);
    }
    for (const command of ['find . -name -fprint -fprint "$X"', 'find . -path -delete -fprintf "$X" "%p"']) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
}

test("embedded mutation iteration stays bounded and resets between calls", () => {
  const command = `node <<'EOF'\n${"fs.unlinkSync('./scratch');".repeat(65)}\nEOF`;
  assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true);
  for (let iteration = 0; iteration < 2; iteration++) {
    const scan = inspectHighRiskBashMutation({ command: "python <<'EOF'\nshutil.rmtree('./a'); shutil.rmtree('./b')\nEOF" }, process.cwd());
    assert.deepEqual(scan?.targets, [resolve('./a'), resolve('./b')]);
    assert.equal(scan?.unverifiableScope, false);
  }
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review ten ${mode}: Node test mode leaves heredoc input as data`, async t => {
    for (const header of ["node --test script.js", "node --test", "node --test-only script.js", "node --test-update-snapshots script.js"]) {
      assert.equal(heredocConsumer(header), undefined, header);
      const command = `${header} <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF`;
      assert.notEqual(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
  });
  test(`review ten ${mode}: sort long operands do not become output options`, async t => {
    for (const command of ["sort --random-sort --random-source -o", "sort --field-separator -o", "sort --key -o", "sort --buffer-size -o", "sort --random-source=-o"]) {
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.unverifiableMutation, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    const f = await shellHookFixture(t, mode), call = await f.authorize('sort --random-source -o -o "$X"');
    assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
  });
  test(`review ten ${mode}: sort temporary directories are mutation targets`, async t => {
    for (const command of ["sort -S1K -T ../outside -o output input", "sort --temporary-directory=../outside -o output input", "sort --temporary-directory ../outside -Tother -o output input"]) {
      const scope = inspectBashPermissionScope({ command }, process.cwd());
      assert.equal(scope?.kind, "known-mutation"); assert.ok(scope?.targets.includes(resolve('../outside')), command);
      assert.ok(scope?.targets.includes(resolve('output')), command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    for (const command of ['sort -T "$X" -o output', 'sort --temporary-directory="$X"']) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review ten ${mode}: unquoted heredoc continuations precede delimiter matching`, async t => {
    const command = "node <<EOF\n// \\\nEOF\nfs.rmSync(target,{recursive:true})\nEOF";
    const view = prepareShellAnalysis(command);
    assert.equal(view.unboundedHeredoc, false);
    assert.equal(view.hereDocuments?.[0]?.body, "// EOF\nfs.rmSync(target,{recursive:true})\n");
    const f = await shellHookFixture(t, mode), call = await f.authorize(command);
    assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    const joined = "cat <<EOF\ndata\nE\\\nOF\nprintf ok";
    assert.equal(prepareShellAnalysis(joined).unboundedHeredoc, false);
    assert.equal(prepareShellAnalysis(joined).hereDocuments?.[0]?.body, "data\n");
    const read = await shellHookFixture(t, mode); assertFinalAuthorization(await read.authorize(joined));
    assert.equal(read.dialogs(), mode === "full-access" ? 0 : 1);
    const tabJoined = "cat <<-EOF\ndata\nE\\\n\tOF\nprintf ok";
    assert.equal(prepareShellAnalysis(tabJoined).unboundedHeredoc, true, "tabs inside a joined logical line are not leading tabs");
    const quoted = "cat <<'EOF'\nraw \\\nEOF\nprintf ok";
    assert.equal(prepareShellAnalysis(quoted).hereDocuments?.[0]?.body, "raw \\\n");
    const escaped = "cat <<EOF\nraw \\\\\nEOF\nprintf ok";
    assert.equal(prepareShellAnalysis(escaped).hereDocuments?.[0]?.body, "raw \\\\\n");
  });
}

test("review ten: workspace never-ask cannot authorize an outside sort temporary directory", async t => {
  const cwd = workspace(t), controller = new SessionPermissionController({ appendEntry() {} } as never);
  let dialogs = 0;
  const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => [], getSessionId: () => 'sort-temp-never-ask' },
    ui: { setStatus() {}, select: async () => { dialogs++; return '仅允许本次'; } } };
  await controller.restore(ctx as never);
  controller.state.setMode('workspace-write'); controller.state.setApprovalPolicy('never-ask');
  for (const command of ['sort -S1K -T ../outside -o output input', 'sort --temporary-directory=../outside -o output input']) {
    const result = await controller.authorizeToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'sort-temp', input: { command } } as never, ctx as never);
    assert.equal(result?.block, true, command);
  }
  assert.equal(dialogs, 0);
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review eleven ${mode}: supported launchers preserve executable heredoc consumers`, async t => {
    for (const prefix of ["env", "env --", "env LABEL=literal", "timeout 5", "sudo", "doas", "env timeout 5", "command env"]) {
      assert.equal(heredocConsumer(`${prefix} bash`), "bash", prefix);
      const shell = `${prefix} bash <<'EOF'\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command: shell }) ?? "", /Blocked an unmanaged long-lived process/, prefix);
      for (const [interpreter, body] of [["node", "fs.rmSync(target,{recursive:true})"], ["python", "shutil.rmtree(target)"]]) {
        const command = `${prefix} ${interpreter} <<'EOF'\n${body}\nEOF`;
        assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true, command);
        const f = await shellHookFixture(t, mode), call = await f.authorize(command);
        assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
      }
    }
  });
  test(`review eleven ${mode}: launcher data and readonly input keep D3 admission`, async t => {
    for (const header of ["env node script.js", "timeout 5 node --test test.js", "sudo python script.py", "env cat"]) {
      assert.equal(heredocConsumer(header), undefined, header);
      const command = `${header} <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF`;
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    for (const command of ["env node <<'EOF'\nconsole.log(1)\nEOF", "env python <<'EOF'\nprint(1)\nEOF"]) {
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
  });
}

test("heredoc descriptor bindings retain order within a fixed inspection bound", () => {
  const command = "source /dev/fd/4 <<'EOF' 3<&0 4<&3 </dev/null\nprintf ok\nEOF";
  const documents = prepareShellAnalysis(command).hereDocuments!;
  assert.deepEqual(documents.map(document => document.descriptor), [3, 4]);
  assert.equal(documents[0]!.body, documents[1]!.body);
  const overflow = `cat <<'EOF' ${Array.from({ length: 17 }, (_, index) => `${index + 3}<&0`).join(" ")}\ndata\nEOF`;
  assert.match(inspectBashResourceLifecycle({ command: overflow }) ?? "", /\[SHELL_HEREDOC\]/);
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review thirteen ${mode}: later state cannot invalidate an earlier high-risk target`, async t => {
    for (const command of ["rm -r scratch; printf -v X foo", 'rm -r scratch; printf "%s" "${X:=foo}"']) {
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, false, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
    for (const command of ["printf -v X foo; rm -r scratch", "rm -r first; printf -v X foo; rm -r second", 'rm -r first; rm -r "$X"', 'rm -r first; node -e "fs.rmSync(target,{recursive:true})"']) {
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true, command); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review thirteen ${mode}: heredoc pipeline consumers begin at the owning stage`, async t => {
    const data = "printf 'printf ok' | source /dev/stdin | cat <<'EOF' | cat\nsleep 100 &\nEOF";
    assert.equal(inspectBashResourceLifecycle({ command: data }), undefined);
    const read = await shellHookFixture(t, mode); assertFinalAuthorization(await read.authorize(data));
    assert.equal(read.dialogs(), mode === "full-access" ? 0 : 1);
    for (const command of [
      "printf ignored | cat <<'EOF' | source /dev/stdin\nsleep 100 &\nEOF",
      "printf ignored | base64 -d <<'EOF' | source /dev/stdin\nc2xlZXAgMTAwICYK\nEOF",
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review thirteen ${mode}: sort compressor spellings retain opaque permissions`, async t => {
    for (const option of ["--compress-program ./codec", "--compress-program=./codec"]) {
      const command = `sort -S16K ${option} -o output input`;
      assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script", option);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
  });
}

test("sort equals compressor cannot receive workspace never-ask authority", async t => {
  const cwd = workspace(t), controller = new SessionPermissionController({ appendEntry() {} } as never);
  const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => 'sort-compressor-never-ask' }, ui: { setStatus() {} } };
  await controller.restore(ctx as never);
  controller.state.setMode('workspace-write'); controller.state.setApprovalPolicy('never-ask');
  for (const option of ['--compress-program ./codec', '--compress-program=./codec']) {
    const result = await controller.authorizeToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'compressor', input: { command: `sort ${option} -o output input` } } as never, ctx as never);
    assert.equal(result?.block, true, option);
  }
});

for (const mode of ["full-access", "workspace-write"] as const) {
  test(`review twelve ${mode}: heredoc descriptor copies retain executable source`, async t => {
    for (const header of ["source /dev/fd/3 <<'EOF' 3<&0", "source /dev/fd/3 <<'EOF' 3>&0", "source /dev/fd/3 3<<'EOF' 3<&3-", "source /dev/fd/3 <<'EOF' 3<&\\0", "source /dev/fd/4 <<'EOF' 3<&0 4<&3", "source /dev/fd/3 <<'EOF' 3<&'0' 0<&-", "source /dev/fd/3 <<'EOF' 3<&0-", "source /dev/fd/3 <<'EOF' 3<&0 </dev/null"]) {
      const command = `${header}\nsleep 100 &\nEOF`;
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/, command);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
    const replaced = "source /dev/fd/3 <<'A' 3<&0 <<'B'\nsleep 100 &\nA\nprintf ok\nB";
    assert.match(inspectBashResourceLifecycle({ command: replaced }) ?? "", /Blocked an unmanaged long-lived process/);
    for (const [interpreter, body] of [["node", "fs.rmSync(target,{recursive:true})"], ["python", "shutil.rmtree(target)"]]) {
      const command = `${interpreter} 3<<'EOF' 0<&3 3<&-\n${body}\nEOF`;
      assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.mutationDetected, true);
      const f = await shellHookFixture(t, mode), call = await f.authorize(command);
      assert.equal(call.outcome?.block, true); assert.equal(call.outcome?.finalAuthorization, undefined); assert.equal(f.dialogs(), 0);
    }
  });
  test(`review twelve ${mode}: descriptor ordering and data keep D3 admission`, async t => {
    for (const command of [
      "source /dev/fd/3 <<'EOF' 3<&0\nprintf ok\nEOF",
      "source /dev/fd/3 3<&0 <<'EOF'\nsleep 100 &\nEOF",
      "source /dev/fd/3 <<'EOF' 3<&0 3</dev/null\nsleep 100 &\nEOF",
      "source /dev/stdin <<'EOF' 3<&0 </dev/null\nsleep 100 &\nEOF",
      "source /dev/fd/3 <<'A' 3<&0 3<<'B'\nsleep 100 &\nA\nprintf ok\nB",
      "cat <<'EOF' 3<&0\nsleep 100 &\nEOF",
    ]) {
      assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
      const f = await shellHookFixture(t, mode); assertFinalAuthorization(await f.authorize(command));
      assert.equal(f.dialogs(), mode === "full-access" ? 0 : 1);
    }
  });
}
