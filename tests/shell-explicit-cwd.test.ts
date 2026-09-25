import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, createLocalBashOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createPowerShellTool } from "../packages/coding-agent/src/core/tools/powershell.ts";
import { getShellCwdBinding, prepareShellCwd } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { CONFIG_DIR_NAME } from "../packages/coding-agent/src/config.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
const { default: lifecycle } = await createJiti(import.meta.url).import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
const bashPath = process.platform !== "win32" ? "/bin/bash" : existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : join(process.env.ProgramFiles!, "Git/bin/bash.exe");

async function fixture(t: test.TestContext, auxiliary?: any, aliasedTrustedRoot = false) {
  const root = mkdtempSync(join(tmpdir(), "sp-shell-cwd-")); let cwd = join(root, "workspace"); mkdirSync(cwd);
  if (aliasedTrustedRoot) { const alias = join(root, "workspace-alias"); symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir"); cwd = alias; }
  const session = SessionManager.create(cwd, join(root, "sessions"));
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(lifecycle, cwd, createEventBus(), runtime);
  const extensions = [extension]; if (auxiliary) extensions.push(await loadExtensionFromFactory(auxiliary, cwd, createEventBus(), runtime));
  const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
  let onApproval = () => {}, afterAuthorization = (_args: any) => {}, approvals = 0;
  const agent = new Agent({ streamFn: () => { throw new Error("offline"); }, beforeToolCall: async ({ toolCall, args }) => {
    const result = await runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never);
    afterAuthorization(args); return result;
  } });
  agent.state.tools = [createBashTool(cwd, { shellPath: bashPath }), createPowerShellTool(cwd)];
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => ["bash", "powershell"], appendEntry: (kind: string, data: any) => session.appendCustomEntry(kind, data) } as never,
    { getSignal: () => agent.signal, getModel: () => agent.state.model, isProjectTrusted: () => aliasedTrustedRoot, isIdle: () => true, hasPendingMessages: () => false } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; onApproval(); return "仅允许本次"; } }, "tui");
  await runner.emit({ type: "session_start" } as never);
  t.after(async () => { agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, agent, runner, session, approvals: () => approvals,
    onApproval(fn: () => void) { onApproval = fn; }, afterAuthorization(fn: (args: any) => void) { afterAuthorization = fn; },
    async call(name: string, command: string, directory?: string) {
      const input = { command, ...(directory === undefined ? {} : { cwd: directory }) }; const id = `${name}-${session.getBranch().length}`;
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as never);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name, arguments: input }); session.appendMessage(result); return result;
    },
  };
}

for (const name of ["bash", "powershell"]) test(`${name}: literal relative/absolute cwd, Chinese spaces and dollars reach actual local spawn`, async t => {
  const f = await fixture(t); const relative = "中文 space $(literal) 'quote'"; const directory = join(f.cwd, relative); mkdirSync(directory); writeFileSync(join(directory, "marker.txt"), "correct-target");
  writeFileSync(join(f.cwd, "marker.txt"), "session-target");
  const command = name === "bash" ? "cat marker.txt" : "Get-Content -LiteralPath marker.txt";
  for (const path of [relative, directory]) {
    const result = await f.call(name, command, path);
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal((result.details as any).cwd, realpathSync.native(directory));
    assert.ok(result.content[0].type === "text" && result.content[0].text.includes("correct-target"));
  }
  const omitted = await f.call(name, command); assert.equal(omitted.isError, false, JSON.stringify(omitted));
  assert.ok(omitted.content[0].type === "text" && omitted.content[0].text.includes("session-target"));
  assert.equal(f.runner.createContext().cwd, f.cwd);
  const reopened = SessionManager.open(f.session.getSessionFile()!); assert.ok(reopened.getBranch().length > 0);
});

test("outside directory uses permission; replacement during approval prevents spawn", async t => {
  const f = await fixture(t); const outside = join(f.root, "outside"); mkdirSync(outside);
  f.onApproval(() => { renameSync(outside, join(f.root, "old")); mkdirSync(outside); });
  const result = await f.call("bash", "printf done > marker", outside);
  assert.equal(result.isError, true); assert.ok(f.approvals() > 0); assert.equal(existsSync(join(outside, "marker")), false);
});

test("junction/symlink alias drift is detected; binding releases authority", async t => {
  const f = await fixture(t); const a = join(f.cwd, "a"), b = join(f.cwd, "b"), alias = join(f.cwd, "alias"); mkdirSync(a); mkdirSync(b);
  symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
  const input = { cwd: alias }; const binding = (await prepareShellCwd(input, f.cwd))!;
  assert.equal(getShellCwdBinding(input), binding); binding.beforeSpawn(binding.canonical);
  rmSync(alias); symlinkSync(b, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => binding.beforeSpawn(binding.canonical), /SHELL_CWD_CHANGED/);
  binding.release(); assert.throws(() => binding.beforeSpawn(binding.canonical), /SHELL_CWD_CHANGED/);
});

test("missing, empty and file cwd refuse with zero command side effects", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "file"), "file");
  for (const directory of ["", "missing", "file", "~/not-expanded"]) {
    const result = await f.call("bash", "printf forbidden > marker", directory); assert.equal(result.isError, true);
    assert.equal(existsSync(join(f.cwd, "marker")), false);
  }
});

test("custom backend, spawn hook and command prefix cannot silently reinterpret explicit cwd", async t => {
  const f = await fixture(t); let invoked = 0;
  for (const options of [
    { operations: { exec: async () => { invoked++; return { exitCode: 0 }; } } },
    { spawnHook: (context: any) => { invoked++; return context; } },
    { commandPrefix: "echo prefix" },
  ]) {
    f.agent.state.tools = [createBashTool(f.cwd, { shellPath: bashPath, ...options })];
    const result = await f.call("bash", "echo safe", "/remote/not-local");
    assert.equal(result.isError, true); assert.ok(result.content[0].type === "text" && result.content[0].text.includes("SHELL_CWD_UNSUPPORTED"));
  }
  assert.equal(invoked, 0); assert.equal(f.approvals(), 0);
});

test("permission changes after approval revoke explicit cwd before execution", async t => {
  const f = await fixture(t); mkdirSync(join(f.cwd, "sub"));
  f.afterAuthorization(() => { f.runner.invalidate(); });
  const result = await f.call("bash", "printf forbidden > marker", "sub");
  assert.equal(result.isError, true); assert.equal(existsSync(join(f.cwd, "sub/marker")), false);
});

test("review: cloned local backend cannot acquire local identity, omitted cwd uses live exec", async t => {
  const f = await fixture(t); let calls = 0;
  const backend = { ...createLocalBashOperations({ shellPath: bashPath }), exec: async () => { calls++; return { exitCode: 0 }; } };
  const tool = createBashTool(f.cwd, { operations: backend }); f.agent.state.tools = [tool];
  assert.equal((await f.call("bash", "echo safe", f.cwd)).isError, true); assert.equal(calls, 0);
  backend.exec = async () => { calls += 10; return { exitCode: 0 }; };
  assert.equal((await f.call("bash", "echo safe")).isError, false); assert.equal(calls, 10);
});

test("review: each reused input receives a fresh binding after execution", async t => {
  const f = await fixture(t); const input = { command: "printf reused", cwd: f.cwd };
  const tool = createBashTool(f.cwd, { shellPath: bashPath });
  await tool.execute("first", input); const first = getShellCwdBinding(input)!; assert.equal(first.isReleased, true);
  await tool.execute("second", input); assert.notEqual(getShellCwdBinding(input), first); assert.equal(getShellCwdBinding(input)!.isReleased, true);
});

test("review: removing the prepared binding after authorization refuses execution", async t => {
  const f = await fixture(t); let binding: ReturnType<typeof getShellCwdBinding>;
  f.afterAuthorization(args => {
    binding = getShellCwdBinding(args);
    for (const key of Object.getOwnPropertySymbols(args)) if (key.description === "super-pi.shell-cwd-binding") Reflect.deleteProperty(args, key);
  });
  const result = await f.call("bash", "printf forbidden > marker", f.cwd);
  assert.equal(result.isError, true); assert.equal(existsSync(join(f.cwd, "marker")), false); assert.equal(binding?.isReleased, true);
});

test("review: auxiliary snapshot disagreement releases terminal directory authority", async t => {
  const f = await fixture(t, (pi: any) => pi.on("tool_call", () => ({ finalAuthorization: {
    consume(args: any) { return { command: args.command, cwd: "different", timeout: args.timeout, purpose: args.purpose }; }, release() {},
  } })));
  let binding: ReturnType<typeof getShellCwdBinding>; f.afterAuthorization(args => { binding = getShellCwdBinding(args); });
  const result = await f.call("bash", "printf forbidden > marker", f.cwd);
  assert.equal(result.isError, true); assert.equal(binding!.isReleased, true); assert.equal(existsSync(join(f.cwd, "marker")), false);
});

test("review: removed alias produces a cwd error without an executable errno", async t => {
  const f = await fixture(t); const target = join(f.cwd, "target"), alias = join(f.cwd, "alias"); mkdirSync(target);
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const binding = (await prepareShellCwd({ cwd: alias }, f.cwd))!; rmSync(alias);
  assert.throws(() => binding.beforeSpawn(binding.canonical), error => error instanceof Error && error.message.includes("SHELL_CWD_CHANGED") && !("code" in error));
  binding.release();
});

test("changed backend rejection releases already handed-off directory authority", async t => {
  const f = await fixture(t); const backend = createLocalBashOperations({ shellPath: bashPath });
  f.agent.state.tools = [createBashTool(f.cwd, { operations: backend })];
  let binding: ReturnType<typeof getShellCwdBinding>;
  f.afterAuthorization(args => { binding = getShellCwdBinding(args); backend.exec = async () => { throw new Error("must not execute"); }; });
  const result = await f.call("bash", "printf forbidden > marker", f.cwd);
  assert.equal(result.isError, true); assert.equal(binding!.isReleased, true); assert.equal(existsSync(join(f.cwd, "marker")), false);
});


test("review: released attached binding cannot renew after authorization", async t => {
  const f = await fixture(t); const a = join(f.cwd, "a"), b = join(f.cwd, "b"), alias = join(f.cwd, "alias"); mkdirSync(a); mkdirSync(b);
  symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
  f.afterAuthorization(args => { getShellCwdBinding(args)!.release(); rmSync(alias); symlinkSync(b, alias, process.platform === "win32" ? "junction" : "dir"); });
  const result = await f.call("bash", "printf forbidden > marker", alias);
  assert.equal(result.isError, true); assert.equal(existsSync(join(a, "marker")), false); assert.equal(existsSync(join(b, "marker")), false);
});

test("review: denied and throwing approval release prepared directory bindings", async t => {
  const f = await fixture(t); const outside = join(f.root, "outside"); mkdirSync(outside);
  for (const throws of [false, true]) {
    f.runner.setUIContext({ ...f.runner.getUIContext(), select: async () => { if (throws) throw new Error("approval unavailable"); return "拒绝"; } }, "tui");
    const input = { command: "printf forbidden > marker", cwd: outside };
    try { await f.runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: `refuse-${throws}`, input } as never); } catch { /* permission refusal may propagate */ }
    assert.equal(getShellCwdBinding(input)!.isReleased, true); assert.equal(existsSync(join(outside, "marker")), false);
  }
});

test("review: standalone scoped wrapper canonicalizes before trusting project settings", async t => {
  const f = await fixture(t); const outside = join(f.root, "outside"), alias = join(f.cwd, "alias"); mkdirSync(join(outside, CONFIG_DIR_NAME, "config"), { recursive: true });
  writeFileSync(join(outside, CONFIG_DIR_NAME, "config/settings.json"), JSON.stringify({ shellPath: join(f.root, "untrusted-executable-does-not-exist") }));
  symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  const previous = process.env.SP_CODING_AGENT_DIR; process.env.SP_CODING_AGENT_DIR = join(f.root, "agent");
  mkdirSync(join(f.root, "agent/config"), { recursive: true }); writeFileSync(join(f.root, "agent/config/settings.json"), JSON.stringify({ shellPath: bashPath }));
  try {
    const { default: loop } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
    const definitions: any[] = []; loop({ registerTool(tool: any) { definitions.push(tool); }, on() {} });
    const bash = definitions.find(tool => tool.name === "bash"); const input = { command: "printf safe", cwd: alias };
    const context = f.runner.createContext(); Object.defineProperty(context, "isProjectTrusted", { value: () => true });
    const result = await bash.execute("standalone", input, undefined, undefined, context);
    assert.ok(result.content[0].text.includes("safe")); assert.equal(result.details.cwd, realpathSync.native(outside)); assert.equal(getShellCwdBinding(input)!.isReleased, true);
    const first = getShellCwdBinding(input); const reused = await bash.execute("standalone-reused", input, undefined, undefined, context);
    assert.ok(reused.content[0].text.includes("safe")); assert.notEqual(getShellCwdBinding(input), first); assert.equal(getShellCwdBinding(input)!.isReleased, true);
    Reflect.deleteProperty(input, "cwd"); const omitted = await bash.execute("standalone-omitted", input, undefined, undefined, context);
    assert.ok(omitted.content[0].text.includes("safe")); assert.equal(getShellCwdBinding(input), undefined);
  } finally { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; }
});


test("review: trusted symlinked Session root retains project shell settings", async t => {
  const f = await fixture(t); const alias = join(f.root, "workspace-alias"); symlinkSync(f.cwd, alias, process.platform === "win32" ? "junction" : "dir");
  mkdirSync(join(f.cwd, CONFIG_DIR_NAME, "config"), { recursive: true });
  writeFileSync(join(f.cwd, CONFIG_DIR_NAME, "config/settings.json"), JSON.stringify({ shellPath: bashPath }));
  const previous = process.env.SP_CODING_AGENT_DIR; process.env.SP_CODING_AGENT_DIR = join(f.root, "agent");
  mkdirSync(join(f.root, "agent/config"), { recursive: true }); writeFileSync(join(f.root, "agent/config/settings.json"), JSON.stringify({ shellPath: join(f.root, "global-invalid-shell") }));
  try {
    const { default: loop } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
    const definitions: any[] = []; loop({ registerTool(tool: any) { definitions.push(tool); }, on() {} });
    const bash = definitions.find(tool => tool.name === "bash"), input = { command: "printf trusted-root", cwd: "." };
    const context = f.runner.createContext(); Object.defineProperty(context, "isProjectTrusted", { value: () => true }); Object.defineProperty(context, "cwd", { value: alias });
    const result = await bash.execute("trusted-alias", input, undefined, undefined, context);
    assert.ok(result.content[0].text.includes("trusted-root")); assert.equal(result.details.cwd, realpathSync.native(f.cwd)); assert.equal(getShellCwdBinding(input)!.isReleased, true);
  } finally { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; }
});


test("review: fresh omitted-cwd reuse clears only released bindings", async t => {
  const f = await fixture(t);
  for (const tool of [createBashTool(f.cwd, { shellPath: bashPath }), createPowerShellTool(f.cwd)]) {
    const input: { command: string; cwd?: string } = { command: "echo safe", cwd: f.cwd };
    await tool.execute("explicit", input); const old = getShellCwdBinding(input)!; assert.equal(old.isReleased, true);
    Reflect.deleteProperty(input, "cwd"); const result = await tool.execute("omitted", input);
    assert.ok(result.content[0].type === "text" && result.content[0].text.includes("safe")); assert.equal(getShellCwdBinding(input), undefined);
    input.cwd = f.cwd; const active = (await prepareShellCwd(input, f.cwd))!; Reflect.deleteProperty(input, "cwd");
    await assert.rejects(prepareShellCwd(input, f.cwd), error => error instanceof Error && error.message.includes("SHELL_CWD_CHANGED")); assert.equal(getShellCwdBinding(input), active); active.release();
    const guarded = await f.runner.emitToolCall({ type: "tool_call", toolName: tool.name, toolCallId: "fresh-omitted", input } as never);
    assert.notEqual(guarded?.block, true); assert.equal(getShellCwdBinding(input), undefined); guarded?.finalAuthorization?.release();
  }
});


test("review: Session root retarget after approval cannot promote outside project settings", async t => {
 for (const restoreTree of [false, true]) {
  const f = await fixture(t, undefined, true); const outside = join(f.root, "outside"); mkdirSync(join(outside, CONFIG_DIR_NAME, "config"), { recursive: true });
  writeFileSync(join(outside, CONFIG_DIR_NAME, "config/settings.json"), JSON.stringify({ shellPath: join(f.root, "untrusted-invalid-shell") }));
  const previous = process.env.SP_CODING_AGENT_DIR; process.env.SP_CODING_AGENT_DIR = join(f.root, "agent");
  mkdirSync(join(f.root, "agent/config"), { recursive: true }); writeFileSync(join(f.root, "agent/config/settings.json"), JSON.stringify({ shellPath: bashPath }));
  try {
    const { default: loop } = await createJiti(import.meta.url).import<any>("../packages/extensions/tool-loop-guardrails/index.ts");
    const definitions: any[] = []; loop({ registerTool(tool: any) { definitions.push(tool); }, on() {} });
    f.agent.state.tools = [wrapToolDefinition(definitions.find(tool => tool.name === "bash"), () => f.runner.createContext())];
    const retarget = () => { rmSync(f.cwd); symlinkSync(outside, f.cwd, process.platform === "win32" ? "junction" : "dir"); };
    if (restoreTree) { retarget(); await f.runner.emit({ type: "session_tree" } as never); } else f.onApproval(retarget);
    const result = await f.call("bash", "printf unsafe > marker", outside);
    assert.equal(result.isError, true); assert.ok(result.content[0].type === "text" && result.content[0].text.includes("SHELL_CWD_CHANGED"), JSON.stringify(result));
    assert.equal(existsSync(join(outside, "marker")), false); if (!restoreTree) assert.ok(f.approvals() > 0);
  } finally { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; }
 }
});
