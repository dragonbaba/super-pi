import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { aliasRiskCounters, decodeLiteralBase64, heredocConsumer, heredocConsumers, heredocConsumerCounters, inspectBashResourceLifecycle, inspectHighRiskBashMutation, literalProcessSources, literalStoredScripts, persistentDescriptorCounters } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions, prepareShellAnalysis, shellAnalysisCounters } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
import { codeMethodNameCounters } from "../packages/extensions/resource-lifecycle-guard/code-method-names.ts";
import { NODE_COMMAND_PATTERN, NODE_LITERAL_METHOD_KEY_PATTERN, NODE_RM_CALL_PATTERN, NODE_UNLINK_PATTERN, PYTHON_COMMAND_PATTERN, PYTHON_RMTREE_PATTERN, PYTHON_UNLINK_PATTERN } from "../packages/extensions/resource-lifecycle-guard/regex.ts";
import { assertFinalAuthorization, shellHookFixture } from "./codemode-recovery/shell-hook-fixture.ts";
import { SessionPermissionController, workspace } from "./codemode-recovery/guard-fixture.ts";
// Rows name behaviors, not review rounds. Only mode-dependent admission runs twice.
// Payloads are inspected through the real authorization hook; no shell is started.
const doc = (header: string, body = "sleep 100 &", descriptor = "") => `${header} ${descriptor}<<'EOF'\n${body}\nEOF`;
const program = (language: string, body: string) => doc(language, body);
const nodeDelete = "fs.unlinkSync(target)", pythonDelete = "shutil.rmtree(target)";
type Outcome = "blocked" | "opaque" | "read-only" | "allowed" | "ask" | "admitted";
type Rule = readonly [
  name: string,
  command: string,
  outcome: Outcome,
  diagnostic?: RegExp,
  tool?: "bash" | "powershell"
];
async function rules(t: TestContext, rows: readonly Rule[]) {
  for (const [name, command, outcome, diagnostic, tool = "bash"] of rows) {
    const lifecycle = tool === "bash" ? inspectBashResourceLifecycle({ command }) : undefined;
    const mutation = inspectHighRiskBashMutation({ command }, process.cwd(), tool);
    const scope = tool === "bash" ? inspectBashPermissionScope({ command }, process.cwd()) : undefined;
    if (diagnostic)
      assert.match(lifecycle ?? "", diagnostic, name);
    if (outcome === "blocked") {
      assert.ok(lifecycle || mutation?.mutationDetected || scope?.unverifiableMutation, name);
    }
    else {
      assert.equal(lifecycle, undefined, name);
      assert.notEqual(mutation?.unverifiableScope, true, name);
    }
    if (outcome === "opaque" || outcome === "read-only") {
      assert.equal(scope?.kind, outcome === "opaque" ? "opaque-script" : "read-only", name);
    }
    const modes = outcome === "opaque" || outcome === "ask"
      ? ["full-access", "workspace-write"] as const
      : [outcome === "blocked" || outcome === "admitted" ? "full-access" : "workspace-write"] as const;
    for (const mode of modes) {
      const fixture = await shellHookFixture(t, mode, "active"), call = await fixture.authorize(command, tool);
      try {
        if (outcome === "blocked") {
          assert.equal(call.outcome?.block, true, name);
          assert.equal(call.outcome?.finalAuthorization, undefined, name);
        }
        else {
          try {
            assertFinalAuthorization(call);
          }
          catch (error) {
            throw new Error(name, { cause: error });
          }
        }
        assert.equal(fixture.dialogs(), mode === "workspace-write" && (outcome === "opaque" || outcome === "ask") ? 1 : 0, name);
      }
      finally {
        call.outcome?.finalAuthorization?.release();
      }
    }
  }
}
test("main lifecycle regressions retain conservative refusal", async (t) => {
  await rules(t, [
    ["unresolved trap", 'ACTION=\'sleep 100 &\'; true; trap "$ACTION" EXIT', "blocked", /SHELL_WRAPPER/],
    ["unknown eval", 'eval "$SCRIPT"', "blocked", /SHELL_WRAPPER/],
    ["indirect indexed test", "[[ -v a[x] ]]", "blocked", /SHELL_UNINSPECTABLE/],
    ["standalone arithmetic", "(( 1+1 ))", "blocked", /SHELL_UNINSPECTABLE/],
    ["prompt transform", 'x=\'$(sleep 100 &)\'; echo "${x@P}"', "blocked", /SHELL_UNINSPECTABLE/],
    ["quoted function substitution", 'echo "${| sleep 100 & REPLY=1; }"', "blocked", /SHELL_UNINSPECTABLE/],
    ["heredoc in function substitution", "echo ${ bash <<'EOF'\nsleep 100 &\nEOF\n; }", "blocked", /SHELL_HEREDOC/],
    ["CR changes delimiter", "cat <<'EOF'\nbody\nE\rOF\nsleep 100 &\nEOF", "blocked", /SHELL_HEREDOC/],
    ["unparsed launcher", doc("env -u FOO node", nodeDelete), "blocked", /SHELL_HEREDOC/],
    ["lost descriptor body", doc("exec", "print(1)", "3") + "\necho ok; python3 /dev/fd/3", "blocked", /SHELL_HEREDOC/],
    ["unknown source producer", "source <(printf '%b' 'echo ok')", "blocked", /SHELL_UNINSPECTABLE/],
    ["aliased literal producer", "shopt -s expand_aliases\nalias echo='printf marker'\nsource <(echo ':')", "blocked", /SHELL_UNINSPECTABLE/],
    ["coproc subshell", "coproc ( sleep 100 )", "blocked", /SHELL_UNINSPECTABLE/],
  ]);
});
test("heredoc syntax binds data and executable input to the owning command", async (t) => {
  await rules(t, [
    ["expanded Python body stays opaque", "PAYLOAD=\"import shutil; shutil.rmtree('/protected')\"; python <<EOF\n$PAYLOAD\nEOF", "ask"],
    ["data consumer", doc("cat"), "opaque"],
    ["literal shell input", doc("source /dev/stdin", "printf ok"), "opaque"],
    ["leading redirection", "<<'EOF' builtin source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["header after continued line", "source \\\n<<'EOF' \\\n/dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["comment is not delimiter", "cat <<'EOF' # <<'FAKE'\nhello\nEOF", "opaque"],
    ["unsupported delimiter", "source /dev/stdin <<E\\OF\nsleep 100 &\nEOF", "blocked"],
    ["split redirection operator", "node <\\\n<'EOF'\nconsole.log(1)\nEOF", "blocked", /SHELL_HEREDOC/],
    ["unquoted continuation changes terminator", "cat <<EOF\nEO\\\nF\nsleep 100 &\nEOF", "blocked"],
    ["CR in delimiter", "cat <<'EO\rF'\nbody\nEO\rF", "blocked", /SHELL_HEREDOC/],
    ["backslash CR", "cat <<EOF\nbody\\\r\nmore\nEOF", "blocked", /SHELL_HEREDOC/],
    ["shell body CR", doc("bash", "printf h\ri"), "blocked", /SHELL_HEREDOC/],
    ["data body CR", doc("node", "/*a\rb*/\nconsole.log(1)"), "opaque"],
    ["expanded shell body", "PAYLOAD='echo ok'; source /dev/stdin <<EOF\n$PAYLOAD\nEOF", "blocked", /SHELL_HEREDOC/],
    ["expanded interpreter body", "node <<EOF\n$PAYLOAD\nEOF", "opaque"],
    ["last heredoc wins", "source /dev/stdin <<'A' <<'B'\nsleep 100 &\nA\nprintf ok\nB", "opaque"],
    ["file supersedes heredoc", "source /dev/stdin <<'A' </dev/null\nsleep 100 &\nA", "opaque"],
    ["combined output keeps input", doc("source /dev/stdin &>out"), "blocked"],
    ["leading combined append", "<<'EOF' &>>out cat\nsleep 100 &\nEOF", "ask"],
    ["reported init-file and here-string payloads already refuse", "bash --rcfile /dev/fd/3 -i 3<<'EOF'\nsleep 100 &\nEOF\necho done", "blocked"],
    ["dynamic shell wrapper", "X=bash; \"$X\" -c 'sleep 100 >/dev/null 2>&1 &'", "ask"],
    ["CR-dependent heredoc boundaries retain main refusal", "echo text\\\r\nnext", "blocked"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print -- - <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["function dynamic rm", "f(){ rm -rf \"$X\"; }; f <<'EOF'\nhello\nEOF", "blocked"],
    ["continued heredoc operators retain conservative refusal", "node <\\\n\\\n<'EOF'\nrequire('fs').unlinkSync(process.argv[1])\nEOF", "blocked"],
    ["source process-substitution heredocs already refuse at preflight", "bash -c 'source <(cat)' <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["unrelated function and read", "f(){ :; }; read x <<'EOF'\nhello\nEOF", "ask"],
    ["unquoted heredoc continuations precede delimiter matching", "node <<EOF\n// \\\nEOF\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["continued heredoc operators retain conservative refusal", "python3 - <\\\n<'EOF'\nshutil.rmtree(sys.argv[1])\nEOF", "blocked"],
    ["unresolved sourced input retains main refusals", "source <(printf \"%s\" \"$SCRIPT\")", "blocked"],
    ["profiler and pretty-print modes retain data-only stdin", "node -i --prof-process <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print +n <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print -n +n <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["reported init-file and here-string payloads already refuse", "source /dev/stdin <<< 'sleep 100 >/dev/null 2>&1 &'; true", "blocked"],
    ["leading blank lines and comments do not change fixed heredoc targets", "cd elsewhere\nnode <<'EOF'\nfs.rmSync('./scratch',{recursive:true})\nEOF", "blocked"],
    ["Bash dump and Node completion modes do not execute stdin", "bash -nD <<'EOF'\nsleep 100 &\nEOF", "ask"],
    ["syntax-only Bash and help-only Python do not execute stdin", "bash -n -c +n 'source /dev/stdin' <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["missing Python option operands do not execute heredoc input", "python3 -iW <<'EOF'\nshutil.rmtree(sys.argv[1])\nEOF", "ask"],
    ["syntax-only Bash and help-only Python do not execute stdin", "bash -n <<EOF\n$(sleep 100 &)\nEOF", "blocked"],
    ["syntax-only Bash and help-only Python do not execute stdin", "bash -n -s <<'EOF'\nsleep 100 &\nEOF", "ask"],
    ["literal process source launch", "source <(echo 'sleep 100 &')", "blocked"],
  ]);
});
test("heredoc consumer options distinguish programs, data and terminal modes", () => {
  // Bit masks: Shell=1, Node=2, Python=4, unresolved=8, nonexecuting=16.
  const rows: readonly (readonly [
    string,
    number,
    number
  ])[] = [
    ["bash -s /dev/fd/3", 0, 1], ["bash -s /dev/fd/3", 3, 0],
    ["bash -n", 0, 16], ["bash -n +n", 0, 1], ["bash -ni", 0, 1],
    ["bash -o noexec", 0, 16], ["bash -o noexec +o noexec", 0, 1],
    ["bash --pretty-print", 0, 16], ["bash --pretty-print -i", 0, 1],
    ["bash -D", 0, 16], ["bash --rcfile", 0, 16], ["bash --rcfile --dump-strings", 0, 1],
    ["bash -c cat", 0, 0], ["bash -- /dev/fd/3", 3, 1],
    ["bash -- file", 0, 0], ["bash -- -", 0, 1],
    ['bash -- "$SCRIPT"', 0, 8], ["bash --pretty-print -- file", 0, 16],
    ["bash --dump-po-strings", 0, 16], ["bash -c 'cat' <<'EOF'", 0, 0],
    ["node --title worker", 0, 2], ["node --title=worker", 0, 2],
    ["node --unknown-future-flag value", 0, 2], ["node --require --v8-options", 0, 2],
    ["node --no-addons script.js", 0, 0], ["node --test", 0, 0],
    ["node --check", 0, 0], ["node -i --prof-process", 0, 0],
    ["node --completion-bash", 0, 0], ["node --v8-options", 0, 0],
    ["node -i -e 'console.log(1)'", 0, 2], ["node -p 1", 0, 0],
    ["node -- /dev/fd/3", 3, 2], ['node -- "$SCRIPT"', 0, 2],
    ["python3 -i /dev/fd/3", 3, 4], ["python3 -i /dev/fd/3", 0, 4],
    ["python -i -c", 0, 16], ["python -im", 0, 16], ["python -icpass", 0, 4],
    ["python -i -m code", 0, 4], ["python -c print", 0, 0],
    ["python -W", 0, 16], ["python -Xdev", 0, 4], ["python -W -VV", 0, 4],
    ['python -W "$OPTIONS"', 0, 4], ['python --check-hash-based-pycs "$MODE"', 0, 4],
    ["python --check-hash-based-pycs", 0, 16], ["python --check-hash-based-pycs always", 0, 4],
    ["python -iVV", 0, 0], ["python --help-env", 0, 0],
    ["py -V:Company/Tag", 0, 4], ["py -3.12", 0, 4],
    ["source script.sh", 0, 0], ["builtin -- source /dev/fd/3", 3, 1],
    ["env timeout 5 bash", 0, 1], ["command env bash", 0, 1],
    ["command -v node", 0, 0], ['env LABEL="$VALUE" node', 0, 2],
    ["{ node; python; }", 0, 6],
  ];
  for (const [header, descriptor, expected] of rows) {
    assert.equal(heredocConsumers(header, descriptor), expected, header);
    assert.equal(heredocConsumer(header, descriptor), expected & 1 ? "bash" : expected & 2 ? "node" : expected & 4 ? "python" : undefined, header);
  }
});
test("descriptor provenance follows copies, closes, rebinding and script channels", async (t) => {
  const stored = doc("exec", "console.log(1)", "3") + "\n";
  await rules(t, [
    ["stdin copy survives source descriptor close", "node 3<<'EOF' 0<&3 3<&-\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["multi-digit source descriptor", "builtin source /dev/fd/19 19<<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["input file supersedes copied stdin", "source /dev/stdin <<'EOF' 3<&0 </dev/null\nsleep 100 &\nEOF", "ask"],
    ["known script path", stored + "true; node /dev/fd/3", "opaque"],
    ["known script mutation", doc("exec", nodeDelete, "3") + "\n:; node /dev/fd/3", "blocked"],
    ["lost proc path", stored + "echo ok; node /proc/self/fd/3", "blocked"],
    ["lost stdin copy", stored + "echo ok; node - <&3", "blocked"],
    ["lost stdin path", stored + "echo ok; node < /dev/fd/3", "blocked"],
    ["dynamic descriptor path", stored + "fd=3; node /dev/fd/$fd", "blocked"],
    ["dynamic stdin descriptor", stored + "fd=3; node - <&$fd", "blocked"],
    ["named descriptor", doc("exec", "print(1)", "{v}") + "\npython /dev/fd/$v", "blocked"],
    ["copy survives close", stored + "exec 4<&3; exec 3<&-; node /dev/fd/4", "blocked"],
    ["descriptor move", stored + "exec 4<&3-; node /dev/fd/4", "blocked"],
    ["literal close", stored + "exec 3<&-; node /dev/fd/3", "opaque"],
    ["file rebind", stored + "exec 3</dev/null; node /dev/fd/3", "opaque"],
    ["data path", stored + "echo ok; cat /dev/fd/3", "opaque"],
    ["unbound source", "source /dev/fd/3", "blocked"],
    ["explicit input binding", "source /dev/fd/3 3<input", "opaque"],
    ["wrapped lost read", stored + "echo ok; bash -c 'source /dev/fd/3'", "blocked"],
    ["same-command copy", "source /dev/fd/4 3<<'EOF' 4<&3\nprintf ok\nEOF", "opaque"],
    ["redirect order", "source /dev/fd/3 3<&0 <<'EOF'\nsleep 100 &\nEOF", "opaque"],
    ["later descriptor copies cannot hide heredoc source", "exec 9<<'EOF'\necho hi\nEOF\nexec 3<file; exec 4<&3; source /dev/fd/4", "ask"],
    ["persistent interpreter descriptor reads reject lost or dynamic bodies", "exec 3<<'EOF'\nfs.unlinkSync(target)\nEOF\nfd=3; env NODEJS.exe < /dev/fd/$fd", "blocked"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/3 <<'EOF' 3<&'0' 0<&-\nsleep 100 &\nEOF", "blocked"],
    ["lost heredoc descriptor source retains lifecycle refusal", "exec 3<<'EOF'\nsleep 100 &\nEOF\necho ok; builtin -- source /dev/fd/3", "blocked"],
    ["wrapped lost descriptors refuse and known contents recurse", "exec 3<<'EOF'\necho hi\nEOF\ntrue; bash -c 'source /dev/fd/3'", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; exec 5<&4; source /dev/fd/5", "blocked"],
    ["interactive Python inspects descriptor scripts before stdin", "py -V:Acme/3.13 -i /dev/fd/3 3<<'EOF'\nshutil.rmtree(sys.argv[1])\nEOF", "blocked"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; cat <&4", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF' 4<&3\necho hi\nEOF\nsource /dev/fd/4", "ask"],
    ["wrapped lost descriptors refuse and known contents recurse", "exec 3<<'EOF'\necho hi\nEOF\ntrue; bash -c 'bash -c \"source /dev/fd/3\"'", "ask"],
    ["descriptor binding data and known readonly source remain admitted", "exec 3<<'A'\nsleep 100 &\nA\nexec 3<<'B'\necho hi\nB\nsource /dev/fd/3", "ask"],
    ["heredoc source descriptors identify executable input without leaking fd words", "3<<'EOF' source /proc/self/fd/3\nsleep 100 &\nEOF", "blocked"],
    ["known interpreter bodies recurse while data and closed descriptors retain D3", "exec 3<<'EOF'\nconsole.log(1)\nEOF\necho ok; node - < /dev/null", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; exec 5<&3; source /dev/fd/4", "blocked"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/4 <<'EOF' 3<&0 4<&3\nsleep 100 &\nEOF", "blocked"],
    ["known interpreter bodies recurse while data and closed descriptors retain D3", "exec 3<<'EOF'\nconsole.log(1)\nEOF\ntrue; node - <&3", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<file; exec 4<&3; source /dev/fd/4", "ask"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/3 3<<'EOF' 3<&3-\nsleep 100 &\nEOF", "blocked"],
  ]);
});
test("launchers and function forwarding retain the resolved consumer", async (t) => {
  await rules(t, [
    ["nested timeout launcher", "env timeout 5 node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["supported sudo launcher", "sudo node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["unsupported env data consumer", "env -u FOO cat <<'EOF'\nordinary data\nEOF", "ask"],
    ["command dispatch preserves env consumer", "command env node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["unresolved prefixes retain heredoc consumer uncertainty", "sudo -u root node <<'EOF'\nunlinkSync(target)\nEOF", "blocked"],
    ["unresolved prefixes retain heredoc consumer uncertainty", "foo [np]* <<'EOF'\nordinary data\nEOF", "blocked"],
    ["unresolved prefixes retain heredoc consumer uncertainty", "foo $(printf node) <<'EOF'\nordinary data\nEOF", "blocked"],
    ["shared Node basename", "env FOO=1 /usr/bin/NODEJS.EXE --eval 'unlinkSync(target)'", "blocked"],
    ["shared Python basename", "env /usr/bin/PYTHON3.12.EXE -c 'shutil.rmtree(target)'", "blocked"],
    ["supported env flags", doc("env -i --unset=FOO -uBAR -0 -- node", "console.log(1)"), "opaque"],
    ["env assignment preserves executable stdin", doc("env LABEL=literal bash"), "blocked"],
    ["unknown prefix consumer", doc("ionice -c3 bash"), "blocked"],
    ["dynamic prefix tail", doc('foo "$TOOL"', "ordinary data"), "blocked"],
    ["unknown prefix data", doc("ionice -c3 cat", "ordinary data"), "opaque"],
    ["unknown eval launcher boundary", "foo bash -c 'sleep 100 &'", "opaque"],
    ["unparsed env eval", "env -S 'X' node -e 'unlinkSync(process.argv[1])'", "blocked"],
    ["dynamic forwarding", doc('python() { command python -W "$@"; }; python', pythonDelete), "blocked"],
    ["fixed forwarding script", doc('python() { command python script.file "$@"; }; python', pythonDelete), "opaque"],
    ["function source", doc("function f\n{ source /dev/stdin; }; f"), "blocked"],
    ["function redefinition", doc("f(){ source /dev/stdin; }; f(){ cat; }; f"), "opaque"],
    ["unlisted runtime", doc("pypy3", pythonDelete), "opaque"],
    ["outer process launch", "perl -e 'print 1' &", "blocked"],
    ["function-dependent heredoc consumers cannot hide executable input", "if true; then f(){ source /dev/stdin; }; fi; f <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["builtin dispatch cannot hide executable stdin", "builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["builtin dispatch cannot hide executable stdin", "command builtin source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["expanded forwarding retains possible interpreter stdin", "node() { command node -- \"$@\"; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["expanded forwarding retains possible interpreter stdin", "node() { command node script.file \"$@\"; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "ask"],
    ["unparsed env options retain heredoc refusal", "command env -u FOO node <<'EOF'\nunlinkSync(process.argv[1])\nEOF", "blocked"],
    ["unparsed env options retain heredoc refusal", "env --unset=FOO node <<'EOF'\nconsole.log(1)\nEOF", "ask"],
    ["expanded forwarding retains possible interpreter stdin", "node() { command node -- '$@'; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "ask"],
    ["builtin dispatch cannot hide executable stdin", "builtin -- source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
  ]);
});
test("pipeline, compound and coproc input uses the connected stage", async (t) => {
  await rules(t, [
    ["unrelated function preserves decoded source", "function unrelated { printf evil; }; base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "ask"],
    ["literal wrapper reads executable input", "bash -c 'source /dev/stdin' <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["wrapper cwd change invalidates body target", "bash -c 'cd sub; source /dev/stdin' <<'EOF'\ntouch target\nEOF", "blocked"],
    ["literal wrapper data consumer", "bash -c 'cat' <<'EOF'\nnohup is only data\nEOF", "ask"],
    ["multiple interpreter consumers", doc("{ node; python; }", "fs.rmSync(target,{recursive:true})"), "blocked"],
    ["compound consumer", doc("{ ! source /dev/stdin; }"), "blocked"],
    ["literal wrapper", doc("bash -c 'eval >out source /dev/stdin'"), "blocked"],
    ["connected pipe", "cat <<'EOF' | >out source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["disconnected output", "cat <<'EOF' >out | source /dev/stdin\nsleep 100 &\nEOF", "ask"],
    ["disconnected input", "cat <<'EOF' | source /dev/stdin </dev/null\nsleep 100 &\nEOF", "opaque"],
    ["restored stdout copy", "cat <<'EOF' 3>&1 >out 1>&3- | source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["unknown transform", "cat <<'EOF' | tr X '&' | bash\nsleep 100 X\nEOF", "blocked"],
    ["base64 transform", "cat <<'EOF' | base64 -d | source /dev/stdin\nc2xlZXAgMTAwICYK\nEOF", "blocked"],
    ["base64 harmless", "base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "opaque"],
    ["shadowed transform", "function base64() ( printf ignored; ); base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "blocked"],
    ["coproc shell", "coproc { bash <<'EOF'\nsleep 100 &\nEOF\n}", "blocked"],
    ["coproc interpreter", doc("coproc NAME { node; }", nodeDelete), "blocked"],
    ["coproc data", doc("coproc NAME { cat; }", "data"), "opaque"],
    ["coproc existing foreground boundary", "true && coproc sleep 100", "opaque"],
    ["coproc nested background", "coproc { sleep 100 & }", "blocked"],
    ["coproc named conditional", "coproc NAME if true; then cat <<'EOF'\ndata\nEOF\nfi", "blocked"],
    ["coproc unnamed conditional", "coproc if true; then node <<'EOF'\nconsole.log(1)\nEOF\nfi", "blocked"],
    ["named coproc subshell boundary", "coproc NAME ( sleep 100 )", "opaque"],
    ["heredoc alias consumer", "{ alias run='source /dev/stdin'; run; } <<'EOF'\nsleep 30 &\nEOF", "blocked"],
    ["coproc keeps actual heredoc consumers and main lifecycle boundaries", "{ coproc { cat; }; }; coproc {\nbash <<'EOF'\nsleep 100 &\nEOF\n}", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "(source /dev/stdin) <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "{ { source /dev/stdin; }; } <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["unknown transforms cannot hide shell heredoc source", "cat <<'EOF' | tr X '&' >output | source /dev/stdin\nsleep 100 X\nEOF", "ask"],
    ["coproc keeps actual heredoc consumers and main lifecycle boundaries", "coproc ( bash <<'EOF'\nsleep 100 &\nEOF\n)", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "{ time source /dev/stdin; } <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["function shadows invalidate heredoc transforms", "function base64 { printf '%s\\n' 'sleep 100 &'; }; base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "blocked"],
    ["coproc keeps actual heredoc consumers and main lifecycle boundaries", "coproc cat 'if' <<'EOF'\nconsole.log('data')\nEOF", "ask"],
    ["disconnected pipeline data does not become a script", "cat <<'EOF' 3>&1 >out 1>&3 | source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "X=value source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["supported transformed heredoc streams inspect the decoded executable input", "base64 -d <<'EOF' | node\nZnMucm1TeW5jKHRhcmdldCx7cmVjdXJzaXZlOnRydWV9KQ==\nEOF", "blocked"],
    ["supported transformed heredoc streams inspect the decoded executable input", "cat <<'EOF' | cat - | source /dev/stdin\nprintf ok\nEOF", "admitted"],
  ]);
});
type CodeRule = readonly [
  name: string,
  body: string,
  target: "unknown" | "opaque" | readonly string[]
];
async function deletionRules(t: TestContext, language: string, rows: readonly CodeRule[]) {
  for (const [name, body, target] of rows) {
    const command = program(language, body), scan = inspectHighRiskBashMutation({ command }, process.cwd());
    if (target === "opaque")
      assert.notEqual(scan?.mutationDetected, true, name);
    else {
      assert.equal(scan?.mutationDetected, true, name);
      assert.equal(scan?.unverifiableScope, target === "unknown", name);
      assert.deepEqual(scan?.targets, target === "unknown" ? [] : target.map(path => resolve(path)), name);
    }
    await rules(t, [[name, command, target === "unknown" ? "blocked" : target === "opaque" ? "opaque" : "ask"]]);
  }
}
test("Node deletion spellings share target assessment and bounded decoding", async (t) => {
  await deletionRules(t, "node", [
    ["optional call", "fs.rmSync ?. (target,{recursive:true})", "unknown"],
    ["literal key", 'fs?.["unlinkSync"]?.(target)', "unknown"],
    ["wrapped reference", "((fs.rmSync))('scratch',{recursive:true})", ["scratch"]],
    ["indirect apply", "((fs['unlinkSync']).apply)?.(null,[target])", "unknown"],
    ["indirect call", "fs.rmSync.call(null,target,{recursive:true})", "unknown"],
    ["identifier Unicode", String.raw `fs.r\u006dSync(target,{recursive:true})`, "unknown"],
    ["key hex", String.raw `fs['r\x6dSync'](target,{recursive:true})`, "unknown"],
    ["key codepoint", String.raw `fs['unl\u{69}nkSync']('scratch')`, ["scratch"]],
    ["identity escape", String.raw `fs['r\mSync'](target,{recursive:true})`, "unknown"],
    ["legacy octal", String.raw `fs['r\155Sync'](target,{recursive:true})`, "unknown"],
    ["line continuation forms", "fs['rm\\\n\\\r\\\r\n\\\u2028\\\u2029Sync'](target,{recursive:true})", "unknown"],
    ["template key", "fs[`r\\mSync`](target,{recursive:true})", "unknown"],
    ["interpolated key", "fs[`rm${part}`](target)", "unknown"],
    ["invalid hex", String.raw `fs['r\xZ0Sync'](target)`, "unknown"],
    ["invalid codepoint", String.raw `fs.\u{110000}(target)`, "unknown"],
    ["invalid identifier digits", String.raw `fs.r\uZZZZSync(target)`, "unknown"],
    ["empty codepoint", String.raw `fs['r\u{}Sync'](target)`, "unknown"],
    ["literal codepoint overflow", String.raw `fs['r\u{110000}Sync'](target)`, "unknown"],
    ["invalid template octal", "fs[`r\\155Sync`](target)", "unknown"],
    ["invalid template decimal", "fs[`r\\8Sync`](target)", "unknown"],
    ["bounded key", `fs['${"x".repeat(257)}'](target)`, "unknown"],
    ["other decoded key", String.raw `fs['r\x65adFileSync'](target)`, "opaque"],
    ["single-character escapes", String.raw `fs['x\b\f\n\r\t\v\0\00\377\8\9\'\"\\x'](target)`, "opaque"],
    ["ASCII key", "(fs)[`readFileSync`](target)", "opaque"],
    ["no recursive option", "fs.rmSync('a.txt'); other({recursive:true})", "opaque"],
    ["false recursive option", "fs.rmSync('a.txt',{force:true,recursive:false,maxRetries:3,retryDelay:10,})", "opaque"],
    ["uncertain recursive option", "fs.rmSync('scratch',{recursive:false,...options})", "unknown"],
    ["computed recursive key", "fs.rmSync('scratch',{[key]:true})", "unknown"],
    ["nested target", "fs.rm(path.join('.',target),{recursive:true},done)", "unknown"],
    ["encoded target", String.raw `fs.rmSync('\x2egit',{recursive:true})`, "unknown"],
    ["partial target", "fs.rmSync('.gi'+'t',{recursive:true})", "unknown"],
    ["regex punctuation", "fs.rmSync((/\\)/, '/protected'),{recursive:true})", "unknown"],
    ["regex conservative text", "const re = /fs.unlinkSync(x)/", "unknown"],
    ["division real call", "1 / require('fs').unlinkSync(process.argv[1]) / 2", "unknown"],
    ["Unicode ends comment", "// comment\u2028fs.unlinkSync(target)", "unknown"],
    ["string and comment data", "console.log(\"rmSync?.(\"); /* fs.unlinkSync(target) */", "opaque"],
    ["indirect properties", "const {rmSync:remove}=fs; remove(target); fs[name](target); fs['rm'+'Sync'](target)", "opaque"],
    ["template expression boundary", "`${require('fs').unlinkSync(process.argv[1])}`", "opaque"],
    ["every call contributes", "fs.rmSync('one',{recursive:true}); fs.unlinkSync('two')", ["one", "two"]],
    ["comment between key and bracket", String.raw `fs[ /* before */ 'r\x6dSync' /* after */ ]('build',{recursive:true})`, ["build"]],
    ["Unicode property whitespace", "fs?.[\u2000'unlinkSync']?.(target)", "unknown"],
    ["line comment after key", "fs['unlinkSync' // key\n](target)", "unknown"],
    ["unclosed literal key", "fs['unlinkSync\n](target)", "unknown"],
    ["escaped nondeletion property", String.raw `fs.l\u006fg(1)`, "opaque"],
    ["decoded computed key boundary", String.raw `fs['r\x6d'+'Sync'](target,{recursive:true})`, "opaque"],
    ["array-return string data", `function f(){return ['${"x".repeat(300)}\\u0061']}`, "opaque"],
  ]);
  await rules(t, [
    ["template in conditional heredoc", "if node <<'EOF'\n`${require('fs').unlinkSync(process.argv[1])}`\nEOF\nthen :; fi", "ask"],
    ["nonrecursive literal-key eval", "node -e 'fs['\\''rmSync'\\'']('\\''a.txt'\\'')'", "ask"],
    ["interpolated wrapped key", "node <<'EOF'\n(fs)[`rm${part}`](target)\nEOF", "blocked"],
    ["literal regex text retains target assessment", "node -e 'const re = /fs.unlinkSync('\\''..'\\'')/'", "ask"],
    ["template expressions remain opaque across shell input shapes", "node -e \"`\\${require('fs').unlinkSync(process.argv[1])}`\"", "ask"],
    ["unquoted heredoc unescaping leaves interpreter source opaque", "node <<EOF\n\\`\\${require('fs').rmSync('/protected',{recursive:true})}\\`\nEOF", "ask"],
    ["template expressions remain opaque across shell input shapes", "node -e \"\\`\\${require('fs').unlinkSync(process.argv[1])}\\`\"", "ask"],
    ["identifier data and indirect properties remain opaque", "node -e 'const data=['\\''hello\\n'\\'','\\''r\\\\u006dSync'\\''];'", "ask"],
    ["template expressions remain opaque across shell input shapes", "node <<'EOF' && echo done\n`${require('fs').unlinkSync(process.argv[1])}`\nEOF", "ask"],
    ["parenthesized direct interpreter calls retain targets", "node -e '((fs.rmSync).call)('\\''receiver'\\'',target,{recursive:true})'", "blocked"],
    ["Bash dump and Node completion modes do not execute stdin", "node --title --completion-bash - <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["escaped Node and normalized Python methods retain target assessment", "node -e 'fs.r\\u{6d}Sync?.(target,{recursive:true})'", "blocked"],
    ["regex punctuation retains an uncertain Node mutation", "node - <<'EOF'\nfs.rmSync(value / divisor)\nEOF", "blocked"],
    ["every embedded mutation call contributes its target", "node <<'EOF'\nfs.rmSync('./scratch',{recursive:true}); fs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["complete Node literal-key escapes retain deletion checks", "node <<'EOF'\n(fs)['x\\00x'](target)\nEOF", "ask"],
    ["escaped Node and normalized Python methods retain target assessment", "node -e 'fs /* receiver */ ['\\''r\\x6dSync'\\''](target,{recursive:true})'", "blocked"],
    ["escaped Node and normalized Python methods retain target assessment", "node <<'EOF'\nfs.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\u006d(target)\nEOF", "blocked"],
    ["operand-free Node flags preserve program file data", "node --no-addons script.js <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", "ask"],
    ["Node option values cannot conceal stdin mutations", "node --no-warnings --title worker <<'EOF'\nconst fs=require('node:fs'); fs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["Node option values cannot conceal stdin mutations", "node --title --eval <<'EOF'\nconst fs=require('node:fs'); fs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["Node substitution body", "node <<EOF\n$(printf '%s' 'fs.rmSync(target,{recursive:true})')\nEOF", "ask"],
    ["Node interactive eval and print preserve executable stdin", "node --require helper.js -i -e 'void 0' <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["Node interactive eval and print preserve executable stdin", "node --interactive --eval 'void 0' <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
    ["Node interactive eval and print preserve executable stdin", "node --print=0 --interactive <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "blocked"],
  ]);
});
test("Python deletion properties retain ordinary targets and opaque language boundaries", async (t) => {
  await deletionRules(t, "python", [
    ["attribute whitespace", "(shutil # comment\n.rmtree)(target)", "unknown"],
    ["continued receiver", "shutil\\\n.rmtree('scratch')", ["scratch"]],
    ["wrapped receiver", "((shutil)).rmtree(target)", "unknown"],
    ["single call attribute", "shutil.rmtree . __call__ (target)", "unknown"],
    ["Path call attribute", "(Path('scratch') . unlink . __call__)()", ["scratch"]],
    ["normalized properties", "shutil.ｒmtree.__ｃall__(target)", "unknown"],
    ["normalized Path", "Path('scratch').ｕnlink()", ["scratch"]],
    ["unknown receiver", "get_path().unlink()", "unknown"],
    ["bare unlink receiver", "path.unlink()", "unknown"],
    ["Path suffix is not Path", "OtherPath('scratch').unlink()", "unknown"],
    ["Path call whitespace", "Path ('scratch').unlink()", ["scratch"]],
    ["parenthesized Path target", "Path(('/protected')).unlink()", "unknown"],
    ["multipart Path", "Path('.', target).unlink()", "unknown"],
    ["Path keyword option", "pathlib.Path('scratch',).unlink(missing_ok=True)", ["scratch"]],
    ["encoded target", String.raw `shutil.rmtree('\x2egit')`, "unknown"],
    ["concatenated target", 'shutil.rmtree(".gi" "t")', "unknown"],
    ["escaped literal quote", 'shutil.rmtree("say\\\"hi")', ['say"hi']],
    ["nonproperty Unicode", "中文变量=1; 对象.中文方法(); print(中文变量)", "opaque"],
    ["call data", 'print.__call__("shutil.rmtree.__call__(target)"); # Path(target).unlink()', "opaque"],
    ["indirect boundary", "from shutil import rmtree; rmtree(target); getattr(shutil,'rmtree')(target); shutil.rmtree.__call__.__call__(target)", "opaque"],
    ["f-string boundary", 'f"{shutil.rmtree(target)}"', "opaque"],
  ]);
  await rules(t, [
    ["missing interactive Python source operands remain data", "py -V:Company/Tag -i -c <<'EOF'\nshutil.rmtree(target)\nEOF", "ask"],
    ["unlink receiver boundaries retain unknown targets", "python - <<'EOF'\nPath(\n 'scratch'\n).unlink()\nEOF", "ask"],
    ["Python attribute whitespace and wrapped methods", "python -c '(Path(target) # c\n. unlink)()'", "blocked"],
    ["V8 and doubled Python version flags do not execute stdin", "python -iVV <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nPath('/protected').unlink()\nEOF", "ask"],
  ]);
});
test("sort and find options distinguish operands, targets and terminal errors", async (t) => {
  await rules(t, [
    ["escaped backticks are a literal target", "touch \\`pwd\\`/../escaped", "allowed"],
    ["positional, redirection and find-root targets retain expansion flags", "sed -i 's/a/b/' `pwd`/../escaped", "blocked"],
    ["terminal help retains only actual preceding effects", "sort --out=.git/config --he", "allowed"],
    ["terminal help retains only actual preceding effects", "sort -ro.git/config --help", "allowed"],
    ["sort unique output prefix", "sort -T tmp --outp ../outside", "ask"],
    ["sort short cluster target", "sort -uro\"$X\"", "blocked"],
    ["sort dynamic attached temp", "sort --te=`pwd`/../outside", "blocked"],
    ["sort literal backtick", "sort --out='`pwd`/../outside'", "allowed"],
    ["sort compressor", "sort --comp=./codec", "opaque"],
    ["sort unknown option", "sort -T tmp --unknown-option", "opaque"],
    ["sort ambiguous prefix", "sort -o .git/config --i", "read-only"],
    ["sort no-argument value", "sort -o .git/config --help=x", "read-only"],
    ["sort optional check value", "sort --check=quiet -o .git/config", "ask"],
    ["sort option operand", "sort --random-source --help -o output", "allowed"],
    ["sort after terminator", "sort -- --out=x", "read-only"],
    ["sort ambiguous spelling as operand", "sort -o --i input", "allowed"],
    ["sort long output after operand", "sort --random-source --help --output=output", "allowed"],
    ["sort unknown before ambiguous", "sort --unknown --i -o file", "opaque"],
    ["sort terminal after preceding write", "rm -rf /protected; sort -o .git/config --help", "admitted"],
    ["sort help as filename", "sort -o .git/config -- --help", "ask"],
    ["sort keeps shell redirection", "sort --help=x > .git/config", "ask"],
    ["find terminal before action", "find --help -fprint .git/config", "read-only"],
    ["find execution operand is not terminal help", "find . -exec printf --help ';'", "blocked"],
    ["find terminal after action", "find -fprint .git/config --help", "ask"],
    ["find help as predicate operand", "find -name --help -fprint .git/config", "ask"],
    ["find files0 operand", "find -files0-from -delete", "read-only"],
    ["find files0 then action", "find -files0-from --help -delete", "blocked"],
    ["find predicate operand", "find . -fstype -delete", "read-only"],
    ["find output after delete", "find scratch -delete -fprintf .git/config '%p'", "ask"],
    ["find expanded output", "find . -fprint `pwd`/../outside", "blocked"],
    ["find expanded root", "find -H -- `pwd`/../victim -delete", "blocked"],
    ["find format data", "find . -fprintf output '`pwd`/../outside'", "allowed"],
    ["find target limit", "find . " + Array.from({ length: 17 }, (_, i) => `-fprint out${i}`).join(" "), "blocked"],
    ["sort temporary directories are mutation targets", "sort -S1K -T ../outside -o output input", "ask"],
    ["clustered sort output flags preserve unknown-target denial", "sort -k 1 -ro\"$X\"", "blocked"],
    ["find output targets retain expansion flags", "find . -maxdepth 0 -fprint0 `pwd`/../outside", "blocked"],
    ["sort targets retain executable expansion metadata", "sort -ro`pwd`/../outside input", "blocked"],
    ["sort unique prefixes retain targets and opaque options", "sort -T tmp --te=../outside", "ask"],
    ["clustered sort output flags preserve unknown-target denial", "sort -uro \"$X\"", "blocked"],
    ["sort long operands do not become output options", "sort --random-sort --random-source -o", "ask"],
    ["values on no-argument sort options terminate before effects", "sort -o .git/config --version=x", "allowed"],
    ["sort targets retain executable expansion metadata", "sort -T tmp --o=`pwd`/../outside input", "blocked"],
    ["sort targets retain executable expansion metadata", "sort -T`pwd`/../outside input", "blocked"],
  ]);
});
test("lifecycle expansion distinguishes delayed code from literal data", async (t) => {
  await rules(t, [
    ["literal arithmetic comparison", "[[ 1 -eq 1 ]]", "allowed"],
    ["stored source overflow reaches authorization", "X0=':'; trap \"$X0\" EXIT; X1=':'; trap \"$X1\" EXIT; X2=':'; trap \"$X2\" EXIT; X3=':'; trap \"$X3\" EXIT; X4=':'; trap \"$X4\" EXIT; X5=':'; trap \"$X5\" EXIT; X6=':'; trap \"$X6\" EXIT; X7=':'; trap \"$X7\" EXIT; X8=':'; trap \"$X8\" EXIT; X9=':'; trap \"$X9\" EXIT; X10=':'; trap \"$X10\" EXIT; X11=':'; trap \"$X11\" EXIT; X12=':'; trap \"$X12\" EXIT; X13=':'; trap \"$X13\" EXIT; X14=':'; trap \"$X14\" EXIT; X15=':'; trap \"$X15\" EXIT; BAD=':'; trap \"$BAD\" EXIT", "blocked"],
    ["process source overflow reaches authorization", "source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':'); source <(echo ':')", "blocked"],
    ["negated indexed test", "! [ -v a[x] ]", "blocked"],
    ["stored and sourced body overflow refuses", "X0=':'; trap \"$X0\" EXIT; X1=':'; trap \"$X1\" EXIT; X2=':'; trap \"$X2\" EXIT; X3=':'; trap \"$X3\" EXIT; X4=':'; trap \"$X4\" EXIT; X5=':'; trap \"$X5\" EXIT; X6=':'; trap \"$X6\" EXIT; X7=':'; trap \"$X7\" EXIT; X8=':'; trap \"$X8\" EXIT; X9=':'; trap \"$X9\" EXIT; X10=':'; trap \"$X10\" EXIT; X11=':'; trap \"$X11\" EXIT; X12=':'; trap \"$X12\" EXIT; X13=':'; trap \"$X13\" EXIT; X14=':'; trap \"$X14\" EXIT; X15=':'; trap \"$X15\" EXIT", "ask"],
    ["stored subscript text", "x='a[$(sleep 100 &)]'; echo $((x))", "blocked"],
    ["ANSI-quoted subscript text", "printf '%s' $'a[$(sleep 100 &)]'", "blocked"],
    ["nested subscript text", "printf '%s' 'a[b[$(sleep 100 &)]]'", "blocked"],
    ["comment inside subscript substitution", "printf '%s' a[<(printf ok # comment\n)]", "blocked"],
    ["subshell inside subscript substitution", "printf '%s' a[<((printf ok); printf done)]", "blocked"],
    ["indexed arithmetic command", "(( a[$(sleep 100 &)] ))", "blocked"],
    ["process subscript text", "printf '%s' 'a[<(printf ok)]'", "blocked"],
    ["indirect builtin name", "printf -v a[x] '%s' value", "blocked"],
    ["numeric builtin name", "printf -v 'a[0]' '%s' 'a[x]'", "opaque"],
    ["read prompt is data", "read -p 'a[x]' 'a[0]' < f.txt", "opaque"],
    ["read array option names storage", "read -ra a[x] < f.txt", "blocked"],
    ["indexed test builtin", "test -v 'a[0]'", "blocked"],
    ["plain test", "[[ -v HOME ]]", "read-only"],
    ["arithmetic literal", "echo $((1+2))", "read-only"],
    ["arithmetic loop boundary", "for ((i=0;i<3;i++)); do :; done", "opaque"],
    ["regex data", "grep 'a[0-9]' f", "read-only"],
    ["mapfile callback cluster", "readarray -tC\"sleep 100 &\" -c 1 a < f.txt", "blocked"],
    ["mapfile delimiter operand", "mapfile -dC a < f.txt", "opaque"],
    ["function substitution launch", "echo ${ echo ${ sleep 100 & }; }", "blocked"],
    ["function in command substitution", "echo $(echo ${ sleep 100 & })", "blocked"],
    ["direct function substitution", "echo ${ sleep 100 & }", "blocked"],
    ["nested prompt transform", "echo \"${x:-${y@P}}\"", "blocked"],
    ["indexed prompt transform", "echo \"${a[0]@P}\"", "blocked"],
    ["prompt in shell input", doc("bash", 'echo "${x@P}"'), "blocked"],
    ["literal function substitution", "echo ${| REPLY=hi; }", "opaque"],
    ["parameter transform data", "echo \"${x@Q}\"", "read-only"],
    ["quoted prompt text", "echo '${x@P}'", "read-only"],
    ["PS4 existing delayed boundary", "PS4='$(sleep 100 &)'; set -x; :", "opaque"],
    ["PS4 exported wrapper", "export PS4='$(sleep 100 &)'; bash -xc :", "blocked"],
    ["literal trap", "ACTION='printf ok'; trap \"$ACTION\" EXIT", "opaque"],
    ["trap clear", "trap - EXIT", "opaque"],
    ["trap lists signals", "trap -l", "opaque"],
    ["literal eval mutation", "eval 'touch' '\"$X\"'", "blocked"],
    ["literal eval harmless", "eval printf ok", "opaque"],
    ["trap dynamic rm", "ACTION='rm -rf \"$X\"'; trap \"$ACTION\" EXIT; true", "blocked"],
    ["function substitutions retain main lifecycle boundaries", "echo ${ echo $((1 << 3)); }", "ask"],
    ["unsafe Bash test operands retain main refusal", "[[ 'a[$(sleep 100 &)]' -eq 0 ]]", "blocked"],
    ["function substitutions retain main lifecycle boundaries", "echo ${ echo \"${ printf hi; }\"; }", "blocked"],
    ["literal eval and trap actions retain lifecycle inspection", "builtin -- trap -- 'sleep 100 &' EXIT", "blocked"],
    ["unresolved trap retains main lifecycle refusal", "ACTION='printf ok'; trap \"$ACTION\" EXIT; trap \"$OTHER\" INT", "blocked"],
    ["mapfile callbacks always retain lifecycle refusal", "if mapfile -tC 'sleep 100 &' a < f.txt; then :; fi", "blocked"],
    ["builtin name subscripts cannot conceal arithmetic execution", "declare -i 'x=a[y]'", "blocked"],
    ["unsafe Bash test operands retain main refusal", "if test -v a[x]; then :; fi", "blocked"],
    ["function substitutions retain main lifecycle boundaries", "VALUE=${ sh <<'EOF'\nsleep 100 &\nEOF\n; }", "blocked"],
    ["mapfile callbacks always retain lifecycle refusal", "mapfile -- a < f.txt", "ask"],
    ["builtin name subscripts cannot conceal arithmetic execution", "declare 'a[123]=1'", "ask"],
    ["function substitutions retain main lifecycle boundaries", "echo ${ case x in x) printf hi;; esac; }", "blocked"],
    ["unsafe Bash test operands retain main refusal", "[ -v 'a[$(sleep 100 &)]' ]", "blocked"],
    ["builtin name subscripts cannot conceal arithmetic execution", "printf -v first -v 'a[0]' '%s' 'a[x]'", "ask"],
    ["trap action expansion cannot defer inspection of executable source", "ACTION='sleep 100 &'; trap \"$ACTION\" EXIT; true", "blocked"],
  ]);
});
test("alias and source proofs are invalidated by possible shell state changes", async (t) => {
  await rules(t, [
    ["alias mutation target", "shopt -s expand_aliases\nalias run='rm -rf \"$X\"'\nrun", "blocked"],
    ["harmless sourced setup preserves later consumer", "source /dev/stdin <<'SETUP'\nprintf ok\nSETUP\nnode <<'EOF'\nconsole.log(1)\nEOF", "ask"],
    ["disabled alias expansion preserves producer", "shopt -u expand_aliases; source <(echo ':')", "ask"],
    ["harmless prefix preserves process producer", "true; source <(printf '%s' ':')", "ask"],
    ["state assignment without later mutation", "echo $((CDPATH=1))", "ask"],
    ["literal expanded alias control", "ACTION='printf ok'; alias run=\"$ACTION\"\nrun", "ask"],
    ["alias assignment", doc("BASH_ALIASES[node]='source /dev/stdin'; node", "data"), "blocked"],
    ["dynamic shopt flag", doc('shopt -s "$OPTION"; node', "data"), "blocked"],
    ["file sourcing", doc("source ./aliases.sh; node", "data"), "blocked"],
    ["unrelated shopt", doc("shopt -s nullglob; node", "console.log(1)"), "opaque"],
    ["alias without expansion", "alias node='echo hi'", "opaque"],
    ["alias listing", "alias -p", "opaque"],
    ["sourced setup uncertainty", "source <(echo 'shopt -s expand_aliases'); source <(echo ':')", "blocked"],
    ["shadowed producer", "function echo() { printf ignored; }; source <(echo ':')", "blocked"],
    ["literal producer", "source <(printf '%s' 'printf ok')", "opaque"],
    ["successive literal producers", "source <(echo ':'); source <(echo ':')", "opaque"],
    ["unknown alias value boundary", "alias run=\"$SCRIPT\"\nrun", "opaque"],
    ["expanded alias code", "ACTION='sleep 100 &'; alias run=\"$ACTION\"\nrun", "blocked"],
    ["earlier target retains cwd", "rm -r scratch; PATH=/tmp; echo ok", "ask"],
    ["later target loses cwd", "rm -r first; PATH=/tmp; rm -r second", "blocked"],
    ["nested target loses cwd", "echo ok; PATH=/tmp; bash -c 'rm -r scratch'", "blocked"],
    ["expanded output name", "printf x >&\"$X\"", "blocked"],
    ["literal read-write target", "printf x 1<>target", "ask"],
    ["fd duplication data", "printf x 1>&2", "read-only"],
    ["later lookup state cannot invalidate earlier mutation targets", "for x in 1 2; do rm -r scratch; PATH=/tmp; done; echo ok", "blocked"],
    ["state-changing builtins and expansions taint later mutation context", "[[ -v 'a[CDPATH=1]' ]]; cd sub && touch target", "blocked"],
    ["possible alias changes retain heredoc lifecycle refusal", "declare -A BASH_ALIASES=([node]='source /dev/stdin');\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["shadowed process producers retain unresolved source refusal", "printf() { printf '%s\\n' 'sleep 100 &'; }; source <(printf '%s' ':')", "blocked"],
    ["sourced setup heredocs cannot change later consumers through aliases", "source /dev/stdin <<'SETUP'\nshopt -s expand_aliases\nalias node='source /dev/stdin'\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["literal alias definitions retain lifecycle and mutation inspection", "shopt -s expand_aliases\nalias run='sleep 30 >/dev/null 2>&1 &'\nrun", "blocked"],
    ["sourced setup heredocs cannot change later consumers through aliases", "source /dev/stdin <<'SETUP'\nBASH_ALIASES[node]='source /dev/stdin'\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["state-changing builtins and expansions taint later mutation context", "echo $((CDPATH=1)); cd sub && touch target", "blocked"],
    ["later state cannot invalidate an earlier high-risk target", "rm -r first; rm -r \"$X\"", "blocked"],
    ["alias state invalidates literal process producers", "shopt -s expand_aliases\nBASH_ALIASES[echo]='printf payload'\nsource <(echo ':')", "blocked"],
    ["alias state invalidates literal process producers", "shopt -s \"$OPTION\"\nsource <(echo ':')", "blocked"],
    ["later lookup state cannot invalidate earlier mutation targets", "rm -r scratch; hash -p /tmp/echo echo; echo ok", "ask"],
    ["state-changing builtins and expansions taint later mutation context", "((CDPATH=1)); cd sub && touch target", "blocked"],
    ["later state cannot invalidate an earlier high-risk target", "rm -r scratch; printf -v X foo", "ask"],
    ["later lookup state cannot invalidate earlier mutation targets", "echo ok; PATH=/tmp; echo $(rm -r scratch)", "blocked"],
    ["sourced setup heredocs cannot change later consumers through aliases", "source /dev/stdin <<'SETUP'\nsource ./aliases.sh\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["later state cannot invalidate an earlier fixed mutation", "touch first; printf -v X foo; touch second", "blocked"],
    ["alias state invalidates literal process producers", "shopt -s expand_aliases\nalias echo='printf \"%s\" \"rm -rf /protected\"'\nalias printf='echo \"rm -rf /protected\"'\nsource <(echo ':')", "blocked"],
    ["alias state invalidates literal process producers", "source ./aliases.sh\nsource <(echo ':')", "blocked"],
    ["alias state invalidates literal process producers", "source <(echo 'shopt -s expand_aliases')\nsource <(printf '%s' ':')", "blocked"],
    ["later lookup state cannot invalidate earlier mutation targets", "rm -r scratch; export PATH=/tmp; echo ok", "ask"],
    ["sourced setup heredocs cannot change later consumers through aliases", "source /dev/stdin <<'SETUP'\neval 'alias node=source'\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["possible alias changes retain heredoc lifecycle refusal", "shopt \"$FLAGS\" expand_aliases;\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["possible alias changes retain heredoc lifecycle refusal", "function setup { source ./aliases.sh; }; setup;\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["possible alias changes retain heredoc lifecycle refusal", "setup() { alias node='source /dev/stdin'; }; setup;\nnode <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["literal alias definitions retain lifecycle and mutation inspection", "shopt -s expand_aliases\nbuiltin alias run='sleep 30 &'\nrun", "blocked"],
  ]);
});
test("inspection bounds, borrowed regexes and temporary views release on every exit", () => {
  for (const [name, inspect] of [
    ["stored source limit", () => {
        const source = Array.from({ length: 17 }, (_, i) => `X${i}=':'; trap "$X${i}" EXIT`).join("; ");
        assert.equal(literalStoredScripts(source), null);
        assert.match(inspectBashResourceLifecycle({ command: source }) ?? "", /SHELL_INSPECTION_LIMIT/);
        assert.deepEqual(literalStoredScripts('ACTION=\'printf ok\'; trap "$ACTION" EXIT'), ["printf ok"]);
        assert.deepEqual(literalStoredScripts('ACTION=\'printf ok\'; builtin -- trap -- "$ACTION" EXIT'), ["printf ok"]);
        assert.deepEqual(inspectBashPermissionScope({ command: "builtin eval touch target" }, process.cwd())?.targets, [resolve("target")]);
        assert.equal(literalStoredScripts('ACTION=\'printf ok\'; unset ACTION; trap "$ACTION" EXIT'), undefined);
        for (const source of ['ACTION=\'printf ok\' | trap "$ACTION" EXIT', 'ACTION=\'printf ok\' && trap "$ACTION" EXIT', '( ACTION=\'printf ok\'; ); trap "$ACTION" EXIT'])
          assert.equal(literalStoredScripts(source), undefined, source);
      }],
    ["process source limit", () => {
        const before = { ...aliasRiskCounters };
        assert.equal(literalProcessSources(Array(17).fill("source <(echo ':')").join("; ")), null);
        assert.match(inspectBashResourceLifecycle({ command: Array(17).fill("source <(echo ':')").join("; ") }) ?? "", /SHELL_INSPECTION_LIMIT/);
        assert.deepEqual(literalProcessSources("source <(echo ':')"), [":"]);
        assert.equal(aliasRiskCounters.liveViews, 0);
        assert.equal(aliasRiskCounters.viewsCreated - before.viewsCreated, aliasRiskCounters.viewsReleased - before.viewsReleased);
      }],
    ["base64 decoding", () => {
        for (const [encoded, expected] of [[Buffer.from("printf 日本語\n").toString("base64"), "printf 日本語\n"], ["%%%", undefined], ["/w==", undefined], ["a".repeat(128 * 1024 + 1), undefined]])
          assert.equal(decodeLiteralBase64(encoded!), expected);
      }],
    ["borrowed matching state", () => {
        assert.equal(inspectHighRiskBashMutation({ command: program("node", Array(65).fill("fs.unlinkSync('./scratch');").join("")) }, process.cwd())?.unverifiableScope, true);
        for (const command of [program("node", "fs['rmSync']?.(target,{recursive:true})"), program("python", Array(65).fill("Path(target).unlink.__call__()").join("; "))])
          assert.equal(inspectHighRiskBashMutation({ command }, process.cwd())?.unverifiableScope, true);
        for (const pattern of [NODE_LITERAL_METHOD_KEY_PATTERN, NODE_RM_CALL_PATTERN, NODE_UNLINK_PATTERN, PYTHON_RMTREE_PATTERN, PYTHON_UNLINK_PATTERN])
          assert.equal(pattern.lastIndex, 0);
        for (const pattern of [NODE_COMMAND_PATTERN, PYTHON_COMMAND_PATTERN]) {
          assert.equal(pattern.global, false);
          assert.equal(pattern.sticky, false);
        }
      }],
    ["descriptor scratch", () => {
        const before = { ...persistentDescriptorCounters };
        inspectBashResourceLifecycle({ command: doc("exec", "console.log(1)", "3") + "\n" + Array.from({ length: 18 }, (_, i) => `exec ${i + 4}<&3`).join("; ") + "; node /dev/fd/21" });
        assert.ok(persistentDescriptorCounters.overflows > before.overflows);
        assert.ok(persistentDescriptorCounters.maxEntries <= 16);
        const includes = Array.prototype.includes;
        Array.prototype.includes = function (...args) { if (persistentDescriptorCounters.liveArrays)
          throw new Error("descriptor scratch failure"); return includes.apply(this, args); };
        try {
          assert.throws(() => inspectBashResourceLifecycle({ command: doc("exec", "console.log(1)", "3") + "\nnode /dev/fd/3" }), /descriptor scratch failure/);
        }
        finally {
          Array.prototype.includes = includes;
        }
        assert.equal(persistentDescriptorCounters.liveArrays, 0);
        assert.equal(persistentDescriptorCounters.arraysCreated - before.arraysCreated, persistentDescriptorCounters.arraysReleased - before.arraysReleased);
      }],
  ] as const) {
    try {
      inspect();
    }
    catch (error) {
      throw new Error(name, { cause: error });
    }
  }
});
test("primitive scanner counters exclude extra passes and ASCII decoding work", () => {
  const cwd = resolve("review*cwd");
  assert.equal(inspectBashPermissionScope({ command: process.platform === "win32" ? `rmdir '${cwd}'` : `rmdir ${cwd}` }, cwd)?.unverifiableMutation, true);
  assert.equal(inspectBashPermissionScope({ command: "python -c 'print(1)'" }, cwd)?.dynamicScope, false);
  const descriptors = "cat <<'EOF' " + Array.from({ length: 17 }, (_, i) => `${i + 3}<&0`).join(" ") + "\ndata\nEOF";
  assert.equal(prepareShellAnalysis(descriptors).unboundedHeredoc, true);
  const methods = { ...codeMethodNameCounters };
  for (const [language, body] of [
    ["node", String.raw `fs.rmSync(target,{recursive:true}); fs['unlinkSync'](target); const \u0061=1; const data=['hello\n'];`],
    ["python", "shutil.rmtree.__call__(target); Path(target).unlink(); 中文变量=1; print(中文变量)"],
  ])
    inspectHighRiskBashMutation({ command: program(language!, body!) }, process.cwd());
  assert.deepEqual(codeMethodNameCounters, methods);
  inspectHighRiskBashMutation({ command: program("node", String.raw `fs.r\u006dSync(target,{recursive:true})`) }, process.cwd());
  assert.equal(codeMethodNameCounters.nodeDecodes - methods.nodeDecodes, 1);
  inspectHighRiskBashMutation({ command: program("python", "shutil.ｒmtree(target)") }, process.cwd());
  assert.equal(codeMethodNameCounters.pythonNormalizations - methods.pythonNormalizations, 1);
  assert.ok(Object.values(codeMethodNameCounters).every(value => typeof value === "number"));
  const before = { ...shellAnalysisCounters };
  const command = "printf '%s' 'a[0-9]' \"b[12]\" $'c[3]'";
  assert.equal(extractCommandSubstitutions(command).unsupported, false);
  assert.equal(shellAnalysisCounters.substitutionCalls - before.substitutionCalls, 1);
  assert.equal(shellAnalysisCounters.subscriptTextChars - before.subscriptTextChars, command.length);
  const heads = shellAnalysisCounters.promptParameterCalls;
  extractCommandSubstitutions("printf ok");
  assert.equal(shellAnalysisCounters.promptParameterCalls, heads);
  assert.equal(extractCommandSubstitutions('echo "${x@P}"').boundaryRefusal, 1);
  assert.equal(shellAnalysisCounters.promptParameterCalls - heads, 1);
  const calls = heredocConsumerCounters.tailCalls, words = heredocConsumerCounters.tailWords;
  assert.equal(heredocConsumers("foo x node"), 8);
  assert.equal(heredocConsumerCounters.tailCalls - calls, 1);
  assert.equal(heredocConsumerCounters.tailWords - words, 2);
  const original = String.prototype.charCodeAt;
  let reads = 0;
  String.prototype.charCodeAt = function (index) { reads++; return original.call(this, index); };
  try {
    const source = "node <" + "\\\n".repeat(8192) + "<'EOF'\nconsole.log(1)\nEOF", count = shellAnalysisCounters.prepareCalls;
    reads = 0;
    const view = prepareShellAnalysis(source);
    assert.equal(shellAnalysisCounters.prepareCalls - count, 1);
    assert.strictEqual(view.command, source);
    assert.equal(view.unboundedHeredoc, true);
    assert.equal(view.hereDocuments, undefined);
    assert.ok(reads <= 2 * source.length + 16);
  }
  finally {
    String.prototype.charCodeAt = original;
  }
});
test("permission policy denies unknown targets and never-ask external effects", async (t) => {
  await rules(t, [["unknown PowerShell deletion target", "Remove-Item -Recurse $x", "blocked", undefined, "powershell"]]);
  const cwd = workspace(t), policy = new SessionPermissionController({ appendEntry() { } } as never);
  const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => "sort-never-ask" }, ui: { setStatus() { } } };
  await policy.restore(ctx as never);
  policy.state.setMode("workspace-write");
  policy.state.setApprovalPolicy("never-ask");
  for (const command of ["sort -T ../outside -o output input", "sort --compress-program=./codec"]) {
    const decision = await policy.authorizeToolCall({ type: "tool_call", toolName: "bash", toolCallId: "sort", input: { command } } as never, ctx as never);
    assert.equal(decision?.block, true, command);
  }
});
