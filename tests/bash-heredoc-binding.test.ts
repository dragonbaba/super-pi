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

const shellPath = process.platform === "win32" && existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : getShellConfig().shell;
const literal = "cat <<'EOF'\nprintf BODY_EXECUTED\nEOF";

async function dispatch(cwd: string, command: string, options: BashToolOptions = {}, deny = false) {
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
  assert.equal(agent.state.pendingToolCalls.size, 0); assert.equal(providers, 0); assert.equal(permissions, 1);
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


test("fallback: actual heredocs are rejected before hooks/backend/spawn on every platform", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pi-heredoc-fallback-")); t.after(() => rmSync(cwd, { recursive: true }));
 const startup = join(cwd, "startup.sh"); writeFileSync(startup, 'printf UNWANTED > marker\n');
 let hooks = 0, backends = 0;
 for (const options of [{}, { spawnHook: (context: any) => { hooks++; return { ...context, env: { ...context.env, BASH_ENV: startup, "BASH_FUNC_cat%%": '() { eval "$(/usr/bin/cat)"; }' } }; } }, { operations: { exec: async () => { backends++; return { exitCode: 0 }; } } }]) {
  const outcome = await dispatch(cwd, literal, options);
  assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0); assert.match(outcome.text, /uncertain\/uninspectable/);
 }
 assert.equal(hooks, 0); assert.equal(backends, 0); assert.equal(existsSync(join(cwd, "marker")), false);
});

test("fallback: executable quoted operands are not accepted as inert data", async () => {
 for (const command of [`bash -c "cat <<'EOF'\nprintf DATA\nEOF"`, `eval "cat <<'EOF'\nprintf DATA\nEOF"`, "command bash -c 'sleep 100 &'", `echo "$(coproc case x in x) : ;; esac; printf REACHED)"`]) {
  const outcome = await dispatch(process.cwd(), command);
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


test("fallback: unrelated quoted text does not taint an eval segment", async () => {
 const outcome = await dispatch(process.cwd(), "printf '%s' 'a << b'; eval 'echo SAFE'");
 assert.equal(outcome.result.isError, false); assert.equal(outcome.processes, 1); assert.equal(outcome.text.trim(), "a << bSAFE");
});
