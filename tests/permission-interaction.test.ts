import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SessionPermissionController } from "../packages/extensions/resource-lifecycle-guard/permission-controller.ts";
import { ExtensionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

initTheme("dark");

async function permissionFixture() {
 const cwd = mkdtempSync(join(tmpdir(), "pi-permission-wait-"));
 const runtime = createExtensionRuntime();
 let permission!: SessionPermissionController;
 const extension = await loadExtensionFromFactory((pi) => {
  // Persistence is deliberately observed, not sent to the installed session.
  pi.appendEntry = () => {};
  permission = new SessionPermissionController(pi);
  pi.on("tool_call", (event, ctx) => permission.authorizeToolCall(event, ctx));
 }, cwd, createEventBus(), runtime);
 const scheduler = new FakeScheduler();
 const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never,
  { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
 let choose!: (value: string | undefined) => void;
 let shown!: () => void;
 const visible = new Promise<void>((resolve) => { shown = resolve; });
 let choices: string[] = [];
 let dialogOptions: any;
 runner.setUIContext({ ...runner.getUIContext(),
  select: async (_title, options, opts) => {
   choices = options; dialogOptions = opts; shown();
   return new Promise<string | undefined>((resolve) => { choose = resolve; });
  },
 }, "interactive");
 await permission.restore(runner.createContext());
 const call = () => runner.emitToolCall({ type: "tool_call", toolName: "browser_exec", toolCallId: "approval-1",
  input: { code: "print('controlled fixture')", purpose: "permission regression" } } as never);
 return { runner, scheduler, permission, visible, call, choose: (index: number) => choose(choices[index]),
  dialogOptions: () => dialogOptions };
}

test("real permission selection outlasts the 30-second machine budget", async () => {
 const f = await permissionFixture();
 const result = f.call();
 const outcome = result.then((value) => ({ value }), (error) => ({ error }));
 await f.visible;
 f.scheduler.advanceBy(60_000);
 await Promise.resolve();
 f.choose(0);
 assert.deepEqual(await outcome, { value: undefined });
 assert.equal(f.runner.hookDeliveryStats.timeouts, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("invalidating a pending approval revokes its signal and late selection", async () => {
 const f = await permissionFixture();
 const result = f.call();
 const outcome = result.then(() => "allowed", () => "rejected");
 await f.visible;
 const signal = f.dialogOptions()?.signal;
 f.runner.invalidate();
 f.choose(0);
 assert.equal(await outcome, "rejected");
 assert.equal(signal?.aborted, true);
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("permission details never push controls beyond the terminal viewport", () => {
 const terminal = { rows: 16, columns: 48 };
 const selector = new ExtensionSelectorComponent("Permission: bash", ["Approve once", "Deny"], () => {}, () => {},
  { tui: { terminal } as never, details: ("脚本 ".repeat(1000) + "\n").repeat(10) } as never);
 assert.ok(selector.render(48).length <= terminal.rows);
 terminal.rows = 9;
 const resized = selector.render(24);
 assert.ok(resized.length <= terminal.rows);
 assert.ok(resized.some((line) => line.includes("Approve")));
 selector.dispose();
});
