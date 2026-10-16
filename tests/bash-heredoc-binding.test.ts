import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, type BashToolOptions } from "../packages/coding-agent/src/core/tools/bash.ts";
import { getShellConfig } from "../packages/coding-agent/src/utils/shell.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { boundedShellInput, MAX_BOUND_SHELL_INPUT_BYTES } from "../packages/coding-agent/src/core/tools/bounded-shell-input.ts";
import { withMsysStdinBridge } from "../packages/coding-agent/src/core/tools/msys-stdin.ts";
import { shellHeredocKind } from "../packages/coding-agent/src/core/tools/shell-heredoc-gate.ts";

const shellPath = process.platform === "win32" && existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : getShellConfig().shell;
const literal = "cat <<'EOF'\nprintf BODY_EXECUTED\nEOF";

test("review sixteen: function-substitution heredocs cannot bypass configured Bash preparation or execution", async () => {
 for (const command of [
  "echo ${ bash <<'EOF'\nprintf ok\nEOF\n; }", 'echo "${ bash <<\'EOF\'\nprintf ok\nEOF\n; }"',
  "VALUE=${| source /dev/stdin <<'EOF'\nprintf ok\nEOF\n; }", 'echo "${ { echo hi; }; bash <<\'EOF\'\nprintf ok\nEOF\n; }"',
  "echo $(echo ${ sh <<'EOF'\nprintf ok\nEOF\n; })", "echo ${x:-${ bash <<'EOF'\nprintf ok\nEOF\n; }}",
 ]) {
  assert.equal(shellHeredocKind(command), 1, command);
  for (const options of [{ commandPrefix: "true" }, { spawnHook: (context: any) => context }, { operations: { exec: async () => ({ exitCode: 0 }) } }]) {
   const denied = await dispatch(process.cwd(), command, options, false, 0);
   assert.equal(denied.processes, 0); assert.match(denied.text, /\[SHELL_HEREDOC\]/);
   const tool = createBashTool(process.cwd(), { shellPath, ...options });
   await assert.rejects(tool.execute("function-recheck", { command }), /\[SHELL_HEREDOC\]/);
  }
 }
});

test("review sixteen: ordinary CR-bearing cat and Node bodies retain D3 execution", async () => {
 for (const command of ["cat <<'EOF'\na\rb\nEOF", "cat <<EOF\na\rb\nEOF", "node <<'EOF'\n/*a\rb*/\nconsole.log('ok')\nEOF"]) {
  const admitted = await dispatch(process.cwd(), command);
  assert.equal(admitted.result.isError, false, admitted.text); assert.equal(admitted.processes, 1);
  assert.equal(admitted.text.replaceAll("\r", "").trim(), command.startsWith("node") ? "ok" : "ab");
 }
});

test("review fifteen: parameter words are data while nested executable substitutions retain the heredoc gate", async () => {
 for (const command of ["echo ${x:-a<<b}", "echo ${x:-${y:-a<<b}}", "echo ${x:-(a<<b)}", "echo ${x:-'a<<b'}", 'echo "${x:-a<<b}"', "echo ${x:-$(printf '%s' 'a<<b')}"]) {
  assert.equal(shellHeredocKind(command), 0, command);
  const input = { command };
  for (const options of [{ commandPrefix: "true" }, { spawnHook: (context: any) => context }, { operations: { exec: async () => ({ exitCode: 0 }) } }]) {
   const tool = createBashTool(process.cwd(), { shellPath, ...options });
   assert.strictEqual(tool.prepareArguments!(input), input);
   const result = await tool.execute("parameter-data", input);
   assert.equal(result.isError, undefined, command);
  }
 }
 const actual = await createBashTool(process.cwd(), { shellPath, commandPrefix: "true" }).execute("parameter-output", { command: "unset sp_gate_value; echo ${sp_gate_value:-a<<b}" });
 assert.equal(actual.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim(), "a<<b");
 for (const command of ["echo ${x:-$(cat <<'E'\nx\nE\n)}", "echo ${x:-${y:-$(cat <<'E'\nx\nE\n)}}", "echo ${x:-a<<b}; cat <<'E'\nx\nE"]) {
  assert.equal(shellHeredocKind(command), 1, command);
  const denied = await dispatch(process.cwd(), command, { commandPrefix: "true" }, false, 0);
  assert.equal(denied.processes, 0); assert.match(denied.text, /\[SHELL_HEREDOC\]/);
 }
});

test("heredoc gate preserves bounded diagnostics and scans only executable syntax", () => {
 for (const consumer of ["cat", "node"]) for (const delimiter of ["E", "EOF", "_long123", "Z".repeat(32)]) {
  for (const body of ["", "data\n", "EOF\n", "中文😀\n", "\ud800\n", "a\r\n", "a\0\n", "x".repeat(12270) + "\n"]) {
   for (const ending of ["", "\n", "\necho done"]) {
    const command = `${consumer} \t<<'${delimiter}'\n${body}${delimiter}${ending}`;
    assert.equal(shellHeredocKind(command), boundedShellInput(command) ? 2 : 1, command);
   }
  }
 }
 for (const command of ["cat <<EOF\nx\nEOF", "cat<<'E'\nx\nE", "echo \"$(cat <<'E'\nx\nE\n)\"", "echo $((1 + $(cat <<'E'\n2\nE\n)))", "cat <\\\n<'E'\nx\nE", "# comment\ncat <<'E'\nx\nE", "cat <<<'data'; cat <<'E'\nx\nE"]) assert.equal(shellHeredocKind(command), 1, command);
 for (const command of ["printf '%s' 'a << b'", 'echo "a << b"', "echo $((1 << 3))", "((x = 1 << 3))", "echo $[1 << 3]", "# cat <<'E'\necho hi", "cat <<<'data'", "node -e 'console.log(1 << 3)'", "echo \\<<data"]) assert.equal(shellHeredocKind(command), 0, command);
});

test("preparation scans once without a command copy, including large inputs", () => {
 const original = String.prototype.charCodeAt;
 let reads = 0;
 String.prototype.charCodeAt = function(index) { reads++; return original.call(this, index); };
 try {
  for (const length of [1024, 128 * 1024, 1024 * 1024]) {
   const command = "echo " + "x".repeat(length), input = { command };
   const tool = createBashTool(process.cwd(), { shellPath, commandPrefix: "true" });
   reads = 0; assert.strictEqual(tool.prepareArguments!(input), input);
   assert.ok(reads <= 4 * command.length + 16, `${reads} character reads for ${command.length}`);
  }
 } finally { String.prototype.charCodeAt = original; }
});

async function dispatch(cwd: string, command: string, options: BashToolOptions = {}, deny = false, expectedPermissions = 1) {
 let processes = 0; let permissions = 0; let providers = 0;
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") processes++; } });
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); },
  beforeToolCall: async ({ args }) => {
   permissions++; assert.equal((args as { command: string }).command, command);
   const reason = deny ? "permission denied" : inspectBashResourceLifecycle(args);
   return reason ? { block: true, reason } : undefined;
  } });
 agent.state.tools = [createBashTool(cwd, { shellPath, exposeSessionEnvironment: false, ...options })];
 hook.enable();
 try {
  const result = await agent.dispatchHostTool({ type: "toolCall", id: "heredoc", name: "bash", arguments: { command } });
  await agent.waitForIdle();
  assert.equal(agent.state.pendingToolCalls.size, 0); assert.equal(providers, 0); assert.equal(permissions, expectedPermissions);
  return { result, processes, text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n") };
 } finally { hook.disable(); agent.abort(); }
}

for (const [command, expected] of [["printf '%s\n' 'a << b'", "a << b"], ["echo $((1 << 3))", "8"], ["node -e 'console.log(1 << 3)'", "8"]]) {
 test(`ordinary compatibility: ${command}`, async () => {
  const outcome = await dispatch(process.cwd(), command);
  assert.equal(outcome.result.isError, false); assert.equal(outcome.text.trim(), expected); assert.equal(outcome.processes, 1);
  const denied = await dispatch(process.cwd(), command, {}, true);
  assert.equal(denied.result.isError, true); assert.equal(denied.processes, 0);
 });
}


test("bounded input refuses custom hooks/backend/prefix before execution on every platform", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pi-heredoc-fallback-")); t.after(() => rmSync(cwd, { recursive: true }));
 const startup = join(cwd, "startup.sh"); writeFileSync(startup, 'printf UNWANTED > marker\n');
 let hooks = 0, backends = 0;
 for (const options of [{ commandPrefix: "printf PREFIX" }, { spawnHook: (context: any) => { hooks++; return { ...context, env: { ...context.env, BASH_ENV: startup, "BASH_FUNC_cat%%": '() { eval "$(/usr/bin/cat)"; }' } }; } }, { operations: { exec: async () => { backends++; return { exitCode: 0 }; } } }]) {
  const outcome = await dispatch(cwd, literal, options, false, 0);
  assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0); assert.match(outcome.text, /SHELL_INPUT_UNSUPPORTED/);
 }
 assert.equal(hooks, 0); assert.equal(backends, 0); assert.equal(existsSync(join(cwd, "marker")), false);
});

test("compound and trailing heredocs refuse changed Bash semantics before spawn", async () => {
 let hooks = 0, backends = 0;
 const options: BashToolOptions[] = [
  { commandPrefix: "shopt -s expand_aliases" },
  { spawnHook: context => { hooks++; return { ...context, env: { ...context.env, "BASH_FUNC_node%%": "() { source /dev/stdin; }" } }; } },
  { operations: { exec: async () => { backends++; return { exitCode: 0 }; } } },
 ];
 for (const command of ["cd . && cat <<'EOF'\necho hi\nEOF", "node <<'EOF'\nconsole.log('hi')\nEOF\necho done", "cd . && node <<'EOF'\nconsole.log('hi')\nEOF", "cat <<'EOF'\necho hi\nEOF\necho done"]) {
  for (const configuration of options) {
   const outcome = await dispatch(process.cwd(), command, configuration, false, 0);
   assert.equal(outcome.result.isError, true); assert.match(outcome.text, /\[SHELL_HEREDOC\]/); assert.equal(outcome.processes, 0);
   // Direct invocation must repeat the preparation guard before the hook/backend.
   const tool = createBashTool(process.cwd(), { shellPath, ...configuration });
   await assert.rejects(tool.execute("recheck", { command }), /\[SHELL_HEREDOC\]/);
  }
  const admitted = await dispatch(process.cwd(), command);
  assert.equal(admitted.result.isError, false, admitted.text); assert.equal(admitted.processes, 1);
 }
 assert.equal(hooks, 0); assert.equal(backends, 0);
});

test("bounded quoted data and Node source execute original UTF-8 bytes through real Bash", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pi-bounded-input-")); t.after(() => rmSync(cwd, { recursive: true }));
 const data = '中文 "quotes" $HOME $(touch forbidden) `false` \\\\ tail\n';
 for (const command of [`cat <<'END'\n${data}END`, "cat <<'END'\nEND", `node <<'END'\nconst text = ${JSON.stringify(data)};\nprocess.stdout.write(text);\nEND`]) {
  assert.ok(boundedShellInput(command));
  assert.equal(inspectBashResourceLifecycle({ command }), undefined);
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
  const result = await dispatch(cwd, command, { spawnHook: withMsysStdinBridge });
  assert.equal(result.result.isError, false, result.text); assert.equal(result.processes, 1);
  assert.equal(result.text, command === "cat <<'END'\nEND" ? "(no output)" : data);
  const denied = await dispatch(cwd, command, { spawnHook: withMsysStdinBridge }, true);
  assert.equal(denied.result.isError, true); assert.equal(denied.processes, 0);
 }
 assert.equal(existsSync(join(cwd, "forbidden")), false);
});

test("stdin bridge keeps its limits while broader heredoc forms require opaque permission", () => {
 const overhead = Buffer.byteLength("cat <<'END'\n\nEND");
 assert.ok(boundedShellInput(`cat <<'END'\n${"x".repeat(MAX_BOUND_SHELL_INPUT_BYTES - overhead)}\nEND`));
 for (const command of [
  `cat <<'END'\n${"x".repeat(MAX_BOUND_SHELL_INPUT_BYTES - overhead + 1)}\nEND`,
  "cat <<END\nx\nEND", "cat <<'END' > file\nx\nEND", "cat <<'END'\nx\nEND\necho later",
  "cat <<'END'\nEND\necho hidden\nEND", "node <<'END'\r\nconsole.log(1)\r\nEND", "cat file <<'END'\nx\nEND",
  "cat <<'END' | node\nx\nEND", "cat <<'ONE' <<'TWO'\nx\nONE\nx\nTWO",
 ]) { assert.equal(boundedShellInput(command), undefined); assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script"); }
});

test("fallback: executable quoted operands are not accepted as inert data", async () => {
 for (const command of ["command bash -c 'sleep 100 &'", `echo "$(coproc case x in x) : ;; esac; printf REACHED)"`]) {
  const outcome = await dispatch(process.cwd(), command);
  assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0);
 }
 for (const command of [`bash -c "cat <<'EOF'\nprintf DATA\nEOF"`, `eval "cat <<'EOF'\nprintf DATA\nEOF"`]) {
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
  const outcome = await dispatch(process.cwd(), command, {}, true);
  assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0);
 }
});

test("fallback: ordinary approved prefix and backend retain base behavior", async () => {
 const outcome = await dispatch(process.cwd(), "echo $((1 << 3))", { commandPrefix: "printf PREFIX" });
 assert.equal(outcome.result.isError, false); assert.equal(outcome.text.trim(), "PREFIX8"); assert.equal(outcome.processes, 1);
 let calls = 0;
 const custom = await dispatch(process.cwd(), "printf '%s\\n' 'a << b'", { operations: { exec: async () => { calls++; return { exitCode: 0 }; } } });
 assert.equal(custom.result.isError, false); assert.equal(calls, 1);
});


test("Node compatibility retains opaque-script permission classification", () => {
 assert.equal(inspectBashPermissionScope({ command: "node -e 'console.log(1 << 3)'" }, process.cwd())?.kind, "opaque-script");
});

test("a longer valid node -e keeps argv content and executes under the existing policy", async () => {
 const script = `const value = ${JSON.stringify("中文 \\\\ \\\"quoted")}; console.log(value + " ${"x".repeat(1800)}");`;
 const command = `node -e '${script.replaceAll("'", "'\\''")}'`;
 assert.equal(inspectBashResourceLifecycle({ command }), undefined);
 const outcome = await dispatch(process.cwd(), command);
 assert.equal(outcome.result.isError, false);
 assert.match(outcome.text, /中文/);
 assert.match(outcome.text, /quoted/);
 assert.equal(outcome.processes, 1);
});


test("fallback: unrelated quoted text does not taint an eval segment", async () => {
 const outcome = await dispatch(process.cwd(), "printf '%s' 'a << b'; eval 'echo SAFE'");
 assert.equal(outcome.result.isError, false); assert.equal(outcome.processes, 1); assert.equal(outcome.text.trim(), "a << bSAFE");
});
