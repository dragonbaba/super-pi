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
type Outcome = "blocked" | "opaque" | "read-only" | "allowed" | "ask" | "admitted" | "once";
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
      if (outcome !== "once") assert.equal(lifecycle, undefined, name);
      if (outcome !== "once") assert.notEqual(mutation?.unverifiableScope, true, name);
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
        assert.equal(fixture.dialogs(), outcome === "once" || mode === "workspace-write" && (outcome === "opaque" || outcome === "ask") ? 1 : 0, name);
      }
      finally {
        call.outcome?.finalAuthorization?.release();
      }
    }
  }
}
test("heredoc syntax binds data and executable input to the owning command", async (t) => {
  await rules(t, [
    ["expanded Python body stays opaque", "PAYLOAD=\"import shutil; shutil.rmtree('/protected')\"; python <<EOF\n$PAYLOAD\nEOF", "ask"],
    ["data consumer", doc("cat"), "opaque"],
    ["literal shell input", doc("source /dev/stdin", "printf ok"), "opaque"],
    ["leading redirection", "<<'EOF' builtin source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["header after continued line", "source \\\n<<'EOF' \\\n/dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["comment is not delimiter", "cat <<'EOF' # <<'FAKE'\nhello\nEOF", "opaque"],
    ["unquoted continuation changes terminator", "cat <<EOF\nEO\\\nF\nsleep 100 &\nEOF", "blocked"],
    ["data body CR", doc("node", "/*a\rb*/\nconsole.log(1)"), "opaque"],
    ["expanded interpreter body", "node <<EOF\n$PAYLOAD\nEOF", "opaque"],
    ["last heredoc wins", "source /dev/stdin <<'A' <<'B'\nsleep 100 &\nA\nprintf ok\nB", "opaque"],
    ["file supersedes heredoc", "source /dev/stdin <<'A' </dev/null\nsleep 100 &\nA", "opaque"],
    ["combined output keeps input", doc("source /dev/stdin &>out"), "blocked"],
    ["leading combined append", "<<'EOF' &>>out cat\nsleep 100 &\nEOF", "ask"],
    ["dynamic shell wrapper", "X=bash; \"$X\" -c 'sleep 100 >/dev/null 2>&1 &'", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print -- - <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["unrelated function and read", "f(){ :; }; read x <<'EOF'\nhello\nEOF", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "node -i --prof-process <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print +n <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["profiler and pretty-print modes retain data-only stdin", "bash --pretty-print -n +n <<'EOF'\nsleep 100 &\nrm -rf /protected\nEOF", "ask"],
    ["Bash dump and Node completion modes do not execute stdin", "bash -nD <<'EOF'\nsleep 100 &\nEOF", "ask"],
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
    ["multi-digit source descriptor", "builtin source /dev/fd/19 19<<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["input file supersedes copied stdin", "source /dev/stdin <<'EOF' 3<&0 </dev/null\nsleep 100 &\nEOF", "ask"],
    ["known script path", stored + "true; node /dev/fd/3", "opaque"],
    ["literal close", stored + "exec 3<&-; node /dev/fd/3", "opaque"],
    ["file rebind", stored + "exec 3</dev/null; node /dev/fd/3", "opaque"],
    ["data path", stored + "echo ok; cat /dev/fd/3", "opaque"],
    ["explicit input binding", "source /dev/fd/3 3<input", "opaque"],
    ["same-command copy", "source /dev/fd/4 3<<'EOF' 4<&3\nprintf ok\nEOF", "opaque"],
    ["redirect order", "source /dev/fd/3 3<&0 <<'EOF'\nsleep 100 &\nEOF", "opaque"],
    ["later descriptor copies cannot hide heredoc source", "exec 9<<'EOF'\necho hi\nEOF\nexec 3<file; exec 4<&3; source /dev/fd/4", "ask"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/3 <<'EOF' 3<&'0' 0<&-\nsleep 100 &\nEOF", "blocked"],
    ["wrapped lost descriptors refuse and known contents recurse", "exec 3<<'EOF'\necho hi\nEOF\ntrue; bash -c 'source /dev/fd/3'", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; cat <&4", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<<'EOF' 4<&3\necho hi\nEOF\nsource /dev/fd/4", "ask"],
    ["wrapped lost descriptors refuse and known contents recurse", "exec 3<<'EOF'\necho hi\nEOF\ntrue; bash -c 'bash -c \"source /dev/fd/3\"'", "ask"],
    ["descriptor binding data and known readonly source remain admitted", "exec 3<<'A'\nsleep 100 &\nA\nexec 3<<'B'\necho hi\nB\nsource /dev/fd/3", "ask"],
    ["heredoc source descriptors identify executable input without leaking fd words", "3<<'EOF' source /proc/self/fd/3\nsleep 100 &\nEOF", "blocked"],
    ["known interpreter bodies recurse while data and closed descriptors retain D3", "exec 3<<'EOF'\nconsole.log(1)\nEOF\necho ok; node - < /dev/null", "ask"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/4 <<'EOF' 3<&0 4<&3\nsleep 100 &\nEOF", "blocked"],
    ["known interpreter bodies recurse while data and closed descriptors retain D3", "exec 3<<'EOF'\nconsole.log(1)\nEOF\ntrue; node - <&3", "ask"],
    ["later descriptor copies cannot hide heredoc source", "exec 3<file; exec 4<&3; source /dev/fd/4", "ask"],
    ["heredoc descriptor copies retain executable source", "source /dev/fd/3 3<<'EOF' 3<&3-\nsleep 100 &\nEOF", "blocked"],
  ]);
});
test("launchers and function forwarding retain the resolved consumer", async (t) => {
  await rules(t, [
    ["unsupported env data consumer", "env -u FOO cat <<'EOF'\nordinary data\nEOF", "ask"],
    ["supported env flags", doc("env -i --unset=FOO -uBAR -0 -- node", "console.log(1)"), "opaque"],
    ["env assignment preserves executable stdin", doc("env LABEL=literal bash"), "blocked"],
    ["unknown prefix data", doc("ionice -c3 cat", "ordinary data"), "opaque"],
    ["unknown eval launcher boundary", "foo bash -c 'sleep 100 &'", "opaque"],
    ["fixed forwarding script", doc('python() { command python script.file "$@"; }; python', pythonDelete), "opaque"],
    ["function source", doc("function f\n{ source /dev/stdin; }; f"), "blocked"],
    ["function redefinition", doc("f(){ source /dev/stdin; }; f(){ cat; }; f"), "opaque"],
    ["unlisted runtime", doc("pypy3", pythonDelete), "opaque"],
    ["outer process launch", "perl -e 'print 1' &", "blocked"],
    ["function-dependent heredoc consumers cannot hide executable input", "if true; then f(){ source /dev/stdin; }; fi; f <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["builtin dispatch cannot hide executable stdin", "builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin builtin source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["builtin dispatch cannot hide executable stdin", "command builtin source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["expanded forwarding retains possible interpreter stdin", "node() { command node script.file \"$@\"; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "ask"],
    ["unparsed env options retain heredoc refusal", "env --unset=FOO node <<'EOF'\nconsole.log(1)\nEOF", "ask"],
    ["expanded forwarding retains possible interpreter stdin", "node() { command node -- '$@'; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", "ask"],
    ["builtin dispatch cannot hide executable stdin", "builtin -- source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
  ]);
});
test("pipeline, compound and coproc input uses the connected stage", async (t) => {
  await rules(t, [
    ["unrelated function preserves decoded source", "function unrelated { printf evil; }; base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "ask"],
    ["literal wrapper reads executable input", "bash -c 'source /dev/stdin' <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["literal wrapper data consumer", "bash -c 'cat' <<'EOF'\nnohup is only data\nEOF", "ask"],
    ["compound consumer", doc("{ ! source /dev/stdin; }"), "blocked"],
    ["connected pipe", "cat <<'EOF' | >out source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["disconnected output", "cat <<'EOF' >out | source /dev/stdin\nsleep 100 &\nEOF", "ask"],
    ["disconnected input", "cat <<'EOF' | source /dev/stdin </dev/null\nsleep 100 &\nEOF", "opaque"],
    ["restored stdout copy", "cat <<'EOF' 3>&1 >out 1>&3- | source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["base64 transform", "cat <<'EOF' | base64 -d | source /dev/stdin\nc2xlZXAgMTAwICYK\nEOF", "blocked"],
    ["base64 harmless", "base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", "opaque"],
    ["coproc data", doc("coproc NAME { cat; }", "data"), "opaque"],
    ["coproc existing foreground boundary", "true && coproc sleep 100", "opaque"],
    ["coproc nested background", "coproc { sleep 100 & }", "blocked"],
    ["named coproc subshell boundary", "coproc NAME ( sleep 100 )", "opaque"],
    ["compound commands and literal wrappers propagate executable heredoc input", "(source /dev/stdin) <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "{ { source /dev/stdin; }; } <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["unknown transforms cannot hide shell heredoc source", "cat <<'EOF' | tr X '&' >output | source /dev/stdin\nsleep 100 X\nEOF", "ask"],
    ["compound commands and literal wrappers propagate executable heredoc input", "{ time source /dev/stdin; } <<'EOF'\nsleep 100 &\nEOF", "blocked"],
    ["coproc keeps actual heredoc consumers and main lifecycle boundaries", "coproc cat 'if' <<'EOF'\nconsole.log('data')\nEOF", "ask"],
    ["disconnected pipeline data does not become a script", "cat <<'EOF' 3>&1 >out 1>&3 | source /dev/stdin\nsleep 100 &\nEOF", "blocked"],
    ["compound commands and literal wrappers propagate executable heredoc input", "X=value source /dev/stdin <<'EOF'\nsleep 100 &\nEOF", "blocked"],
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
    await rules(t, [[name, command, target === "unknown" ? "once" : target === "opaque" ? "opaque" : "ask"]]);
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
    ["literal regex text retains target assessment", "node -e 'const re = /fs.unlinkSync('\\''..'\\'')/'", "blocked"],
    ["template expressions remain opaque across shell input shapes", "node -e \"`\\${require('fs').unlinkSync(process.argv[1])}`\"", "ask"],
    ["unquoted heredoc unescaping leaves interpreter source opaque", "node <<EOF\n\\`\\${require('fs').rmSync('/protected',{recursive:true})}\\`\nEOF", "ask"],
    ["template expressions remain opaque across shell input shapes", "node -e \"\\`\\${require('fs').unlinkSync(process.argv[1])}\\`\"", "ask"],
    ["identifier data and indirect properties remain opaque", "node -e 'const data=['\\''hello\\n'\\'','\\''r\\\\u006dSync'\\''];'", "ask"],
    ["template expressions remain opaque across shell input shapes", "node <<'EOF' && echo done\n`${require('fs').unlinkSync(process.argv[1])}`\nEOF", "ask"],
    ["complete Node literal-key escapes retain deletion checks", "node <<'EOF'\n(fs)['x\\00x'](target)\nEOF", "ask"],
    ["operand-free Node flags preserve program file data", "node --no-addons script.js <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", "ask"],
    ["Node substitution body", "node <<EOF\n$(printf '%s' 'fs.rmSync(target,{recursive:true})')\nEOF", "ask"],
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
    ["V8 and doubled Python version flags do not execute stdin", "python -iVV <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nPath('/protected').unlink()\nEOF", "ask"],
  ]);
});
test("sort and find options distinguish operands, targets and terminal errors", async (t) => {
  await rules(t, [
    ["escaped backticks are a literal target", "touch \\`pwd\\`/../escaped", "allowed"],
    ["terminal help retains only actual preceding effects", "sort --out=.git/config --he", "allowed"],
    ["terminal help retains only actual preceding effects", "sort -ro.git/config --help", "allowed"],
    ["sort unique output prefix", "sort -T tmp --outp ../outside", "ask"],
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
    ["find terminal after action", "find -fprint .git/config --help", "ask"],
    ["find help as predicate operand", "find -name --help -fprint .git/config", "ask"],
    ["find files0 operand", "find -files0-from -delete", "read-only"],
    ["find predicate operand", "find . -fstype -delete", "read-only"],
    ["find output after delete", "find scratch -delete -fprintf .git/config '%p'", "ask"],
    ["find format data", "find . -fprintf output '`pwd`/../outside'", "allowed"],
    ["sort temporary directories are mutation targets", "sort -S1K -T ../outside -o output input", "ask"],
    ["sort unique prefixes retain targets and opaque options", "sort -T tmp --te=../outside", "ask"],
    ["sort long operands do not become output options", "sort --random-sort --random-source -o", "ask"],
    ["values on no-argument sort options terminate before effects", "sort -o .git/config --version=x", "allowed"],
  ]);
});
test("lifecycle expansion distinguishes delayed code from literal data", async (t) => {
  await rules(t, [
    ["literal arithmetic comparison", "[[ 1 -eq 1 ]]", "allowed"],
    ["stored and sourced body overflow refuses", "X0=':'; trap \"$X0\" EXIT; X1=':'; trap \"$X1\" EXIT; X2=':'; trap \"$X2\" EXIT; X3=':'; trap \"$X3\" EXIT; X4=':'; trap \"$X4\" EXIT; X5=':'; trap \"$X5\" EXIT; X6=':'; trap \"$X6\" EXIT; X7=':'; trap \"$X7\" EXIT; X8=':'; trap \"$X8\" EXIT; X9=':'; trap \"$X9\" EXIT; X10=':'; trap \"$X10\" EXIT; X11=':'; trap \"$X11\" EXIT; X12=':'; trap \"$X12\" EXIT; X13=':'; trap \"$X13\" EXIT; X14=':'; trap \"$X14\" EXIT; X15=':'; trap \"$X15\" EXIT", "ask"],
    ["numeric builtin name", "printf -v 'a[0]' '%s' 'a[x]'", "opaque"],
    ["read prompt is data", "read -p 'a[x]' 'a[0]' < f.txt", "opaque"],
    ["plain test", "[[ -v HOME ]]", "read-only"],
    ["arithmetic literal", "echo $((1+2))", "read-only"],
    ["arithmetic loop boundary", "for ((i=0;i<3;i++)); do :; done", "opaque"],
    ["regex data", "grep 'a[0-9]' f", "read-only"],
    ["mapfile delimiter operand", "mapfile -dC a < f.txt", "opaque"],
    ["function substitution launch", "echo ${ echo ${ sleep 100 & }; }", "blocked"],
    ["function in command substitution", "echo $(echo ${ sleep 100 & })", "blocked"],
    ["direct function substitution", "echo ${ sleep 100 & }", "blocked"],
    ["literal function substitution", "echo ${| REPLY=hi; }", "opaque"],
    ["parameter transform data", "echo \"${x@Q}\"", "read-only"],
    ["quoted prompt text", "echo '${x@P}'", "read-only"],
    ["PS4 existing delayed boundary", "PS4='$(sleep 100 &)'; set -x; :", "opaque"],
    ["literal trap", "ACTION='printf ok'; trap \"$ACTION\" EXIT", "opaque"],
    ["trap clear", "trap - EXIT", "opaque"],
    ["trap lists signals", "trap -l", "opaque"],
    ["literal eval harmless", "eval printf ok", "opaque"],
    ["function substitutions retain main lifecycle boundaries", "echo ${ echo $((1 << 3)); }", "ask"],
    ["literal eval and trap actions retain lifecycle inspection", "builtin -- trap -- 'sleep 100 &' EXIT", "blocked"],
    ["mapfile callbacks always retain lifecycle refusal", "mapfile -- a < f.txt", "ask"],
    ["builtin name subscripts cannot conceal arithmetic execution", "declare 'a[123]=1'", "ask"],
    ["builtin name subscripts cannot conceal arithmetic execution", "printf -v first -v 'a[0]' '%s' 'a[x]'", "ask"],
    ["trap action expansion cannot defer inspection of executable source", "ACTION='sleep 100 &'; trap \"$ACTION\" EXIT; true", "blocked"],
  ]);
});
test("alias and source proofs are invalidated by possible shell state changes", async (t) => {
  await rules(t, [
    ["harmless sourced setup preserves later consumer", "source /dev/stdin <<'SETUP'\nprintf ok\nSETUP\nnode <<'EOF'\nconsole.log(1)\nEOF", "ask"],
    ["disabled alias expansion preserves producer", "shopt -u expand_aliases; source <(echo ':')", "ask"],
    ["harmless prefix preserves process producer", "true; source <(printf '%s' ':')", "ask"],
    ["state assignment without later mutation", "echo $((CDPATH=1))", "ask"],
    ["literal expanded alias control", "ACTION='printf ok'; alias run=\"$ACTION\"\nrun", "ask"],
    ["unrelated shopt", doc("shopt -s nullglob; node", "console.log(1)"), "opaque"],
    ["alias without expansion", "alias node='echo hi'", "opaque"],
    ["alias listing", "alias -p", "opaque"],
    ["literal producer", "source <(printf '%s' 'printf ok')", "opaque"],
    ["successive literal producers", "source <(echo ':'); source <(echo ':')", "opaque"],
    ["unknown alias value boundary", "alias run=\"$SCRIPT\"\nrun", "opaque"],
    ["expanded alias code", "ACTION='sleep 100 &'; alias run=\"$ACTION\"\nrun", "blocked"],
    ["earlier target retains cwd", "rm -r scratch; PATH=/tmp; echo ok", "ask"],
    ["literal read-write target", "printf x 1<>target", "ask"],
    ["fd duplication data", "printf x 1>&2", "read-only"],
    ["literal alias definitions retain lifecycle and mutation inspection", "shopt -s expand_aliases\nalias run='sleep 30 >/dev/null 2>&1 &'\nrun", "blocked"],
    ["later lookup state cannot invalidate earlier mutation targets", "rm -r scratch; hash -p /tmp/echo echo; echo ok", "ask"],
    ["later state cannot invalidate an earlier high-risk target", "rm -r scratch; printf -v X foo", "ask"],
    ["later lookup state cannot invalidate earlier mutation targets", "rm -r scratch; export PATH=/tmp; echo ok", "ask"],
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
test("permission policy requires confirmation without UI for unknown or external effects", async (t) => {
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
