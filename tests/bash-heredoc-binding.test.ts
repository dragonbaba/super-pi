import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, createLocalBashOperations, type BashToolOptions } from "../packages/coding-agent/src/core/tools/bash.ts";
import { getShellConfig } from "../packages/coding-agent/src/utils/shell.ts";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";

const { withMsysStdinBridge } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/msys-bash.ts");
const shellPath = process.platform === "win32" && existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : getShellConfig().shell;
const literal = "cat <<'EOF'\nprintf BODY_EXECUTED\nEOF";

async function dispatch(cwd: string, command: string, options: BashToolOptions = {}, deny = false) {
 let processes = 0; let permissions = 0; let providers = 0;
 const hook = createHook({ init(_id, type) { if (type === "PROCESSWRAP") processes++; } });
 const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); },
  beforeToolCall: async ({ args }) => {
   permissions++; assert.equal(args.command, command);
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

test("bound heredoc: ordinary supported consumer emits literal data through production dispatch", { skip: process.platform !== "linux" }, async () => {
 const outcome = await dispatch(process.cwd(), literal, { spawnHook: context => ({ ...context, env: { ...context.env, PATH: "/usr/bin:/bin", BASH_ENV: "", ENV: "" } }) });
 assert.equal(outcome.result.isError, false); assert.equal(outcome.processes, 1);
 assert.equal(outcome.text.trim(), "printf BODY_EXECUTED");
});

test("bound heredoc: inherited functions and startup input never execute", async t => {
 const cwd = mkdtempSync(join(tmpdir(), "pi-heredoc-binding-")); t.after(() => rmSync(cwd, { recursive: true }));
 const startup = join(cwd, "startup.sh"); const marker = join(cwd, "startup-ran");
 writeFileSync(startup, 'printf STARTUP > startup-ran\ncat(){ eval "$(/usr/bin/cat)"; }\n');
 for (const addition of [{ "BASH_FUNC_cat%%": '() { eval "$(/usr/bin/cat)"; }' }, { BASH_ENV: startup }]) {
  const outcome = await dispatch(cwd, literal, { spawnHook: context => ({ ...context, env: { ...context.env, ...addition } }) });
  assert.equal(outcome.result.isError, true); assert.match(outcome.text, /HEREDOC_EXECUTION_UNVERIFIED/);
  assert.equal(outcome.processes, 0); assert.equal(existsSync(marker), false);
 }
});

test("bound heredoc: custom backend and changed command/cwd cannot inherit local authority", async () => {
 let customCalls = 0;
 for (const options of [
  { operations: { exec: async () => { customCalls++; return { exitCode: 0 }; } } },
  { commandPrefix: "echo setup" },
  { spawnHook: (context: any) => ({ ...context, command: "printf REPLACED" }) },
  { spawnHook: (context: any) => ({ ...context, cwd: tmpdir() }) },
 ]) {
  const outcome = await dispatch(process.cwd(), literal, options);
  assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0);
 }
 assert.equal(customCalls, 0);
 const operations = createLocalBashOperations({ shellPath });
 const tool = createBashTool(process.cwd(), { operations, exposeSessionEnvironment: false });
 operations.exec = async () => { customCalls++; return { exitCode: 0 }; };
 await assert.rejects(tool.execute("replacement", { command: literal }), /HEREDOC_EXECUTION_UNVERIFIED/);
 assert.equal(customCalls, 0);
});

test("bound heredoc: actual Windows bridge refuses before nested shell launch", { skip: process.platform !== "win32" }, async () => {
 const outcome = await dispatch(process.cwd(), "cat <<'EOF'\nC:\\\\data\nEOF", { spawnHook: withMsysStdinBridge });
 assert.equal(outcome.result.isError, true); assert.equal(outcome.processes, 0);
 assert.match(outcome.text, /HEREDOC_EXECUTION_UNVERIFIED/);
});

test("bound heredoc: denied call and ordinary non-heredoc compatibility", async () => {
 const denied = await dispatch(process.cwd(), literal, {}, true);
 assert.equal(denied.result.isError, true); assert.equal(denied.processes, 0);
 const ordinary = await dispatch(process.cwd(), "printf ORDINARY");
 assert.equal(ordinary.result.isError, false); assert.equal(ordinary.text, "ORDINARY"); assert.equal(ordinary.processes, 1);
});
