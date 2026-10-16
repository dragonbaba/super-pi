import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { body, sessionFixture } from "./fixture.ts";

const diagnostic = "ffmpeg version fixture\n" + "configuration: offline diagnostic fixture\n".repeat(48)
  + "[Parsed_volumedetect_0 @ 0] No such filter: 'volumedetect'\nError opening output files: Filter not found\nCommand exited with code 1";

async function fixture(t: TestContext, approvalDelay = 0) {
  const calls: string[] = [], aborted: string[] = [];
  let announceStarted!: () => void;
  const started = new Promise<void>(resolve => { announceStarted = resolve; });
  const extension: ExtensionFactory = pi => {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "probe" && (event.input as { kind?: string }).kind === "approval") {
        const choice = await ctx.ui.select("Synthetic approval", ["allow"], { signal: ctx.signal });
        if (choice !== "allow") return { block: true, reason: "fixture cancelled" };
      }
    });
  };
  const f = await sessionFixture(t, { g2: false, extensions: approvalDelay ? [extension] : [], customTools: [{
    name: "probe", label: "probe", description: "offline result fixture", parameters: Type.Object({
      kind: Type.String(), blob: Type.Optional(Type.String()), id: Type.Optional(Type.String()), delay: Type.Optional(Type.Number()),
    }),
    execute: async (_id: string, args: { kind: string; id?: string; delay?: number }, signal?: AbortSignal) => {
      calls.push(args.kind);
      announceStarted();
      if (args.delay) await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); aborted.push(args.kind); reject(new Error("fixture cancelled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, args.delay);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
      return { content: args.kind === "blocks" ? Array.from({ length: 100 }, (_, i) => ({ type: "text" as const, text: `block-${i}` }))
        : [{ type: "text" as const, text: args.kind === "diagnostic" ? diagnostic : args.kind === "failure" ? "expected fixture failure" : `ok ${args.id ?? ""}` }],
        details: {}, isError: args.kind === "failure" || args.kind === "diagnostic" };
    },
  }] });
  let dialogs = 0;
  if (approvalDelay) {
    // Use the real extension wait scope; this selector never displays a real dialog.
    const runner = f.session.extensionRunner;
    await f.session.bindExtensions({ mode: "tui", uiContext: { ...runner.getUIContext(), select: async (_title, _choices, options) => {
      dialogs++;
      return new Promise<string | undefined>(resolve => {
        const signal = options?.signal;
        const finish = (value: string | undefined) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); };
        const abort = () => finish(undefined);
        const timer = setTimeout(() => finish("allow"), approvalDelay);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    } } });
  }
  return { ...f, calls, aborted, started, dialogs: () => dialogs };
}

test("F-C1 the next model request contains the actual FFmpeg failure, not only its banner", async t => {
  const f = await fixture(t);
  const { result, requests } = await f.run('await tools.probe({kind:"diagnostic"});');
  assert.deepEqual(f.calls, ["diagnostic"]); assert.equal(result.isError, true);
  const visible = body(requests.at(-1)!.find(m => m.role === "toolResult")!.content as never);
  assert.match(visible, /No such filter: 'volumedetect'/);
  assert.match(visible, /(?:exit=1|exited with code 1)/);
});

test("F-C2 explicitly handled failure + successful alternative commits the store and keeps child facts", async t => {
  const f = await fixture(t);
  const first = await f.run(`try {
    const outcome = await callTool("probe", {kind:"failure"}, {allowFailure:true});
    text({handled:outcome.isError});
  } catch (error) { text("caught failure; selecting alternative"); }
  await tools.probe({kind:"ok"}); store("recovered", "yes"); text("alternative completed");`);
  const second = await f.run('text({recovered:load("recovered") ?? null});');
  assert.deepEqual(f.calls, ["failure", "ok"], "no replay of the failed or successful child");
  const facts = (first.result.details as any).codemode.calls;
  assert.equal(facts[0].isError, true); assert.equal(facts[1].isError, false);
  assert.equal((first.result.details as any).codemode.scriptOk, true);
  assert.deepEqual({ failed: first.result.isError, saved: body(second.result.content).includes('"recovered":"yes"') },
    { failed: false, saved: true }, "a recovered script must commit its store while preserving the failed child record");
});

test("control: an unhandled child failure still fails the parent and does not commit store", async t => {
  const f = await fixture(t);
  const first = await f.run('store("uncommitted","no"); await tools.probe({kind:"failure"});');
  const second = await f.run('text({value:load("uncommitted") ?? null});');
  assert.equal(first.result.isError, true); assert.match(body(second.result.content), /"value":null/);
  assert.deepEqual(f.calls, ["failure"]);
});

test("F-C4 displaying 300 successful blocks does not fail the task or discard the store", async t => {
  const f = await fixture(t);
  const first = await f.run('for(let i=0;i<3;i++) await show((await tools.probe({kind:"blocks"})).ref); store("displayed",true);');
  const second = await f.run('text({displayed:load("displayed") ?? false});');
  assert.deepEqual(f.calls, ["blocks", "blocks", "blocks"]);
  assert.ok((first.result.details as any).codemode.calls.every((c: any) => !c.isError));
  assert.deepEqual({ failed: first.result.isError, saved: body(second.result.content).includes('"displayed":true') }, { failed: false, saved: true });
});

test("F-C5 large inputs do not evict six tiny results before show(first.ref)", async t => {
  const f = await fixture(t);
  const { result } = await f.run(`const blob="x".repeat(220000);
    const first=await tools.probe({kind:"ok",id:"FIRST_RESULT",blob});
    for(let i=0;i<5;i++) await tools.probe({kind:"ok",blob});
    await show(first.ref);`);
  assert.equal(f.calls.length, 6);
  assert.equal(result.isError, false, body(result.content));
  assert.match(body(result.content), /FIRST_RESULT/);
});

test("control: one bounded child completes within the script deadline", async t => {
  const f = await fixture(t);
  const { result } = await f.run('// @options: {"timeout_ms":800}\nawait tools.probe({kind:"delay",delay:300});');
  assert.equal(result.isError, false); assert.deepEqual(f.aborted, []);
});

test("F-C6 D4: serial child execution does not consume the script computation allowance", async t => {
  const f = await fixture(t);
  const { result } = await f.run('// @options: {"timeout_ms":800}\nfor(let i=0;i<4;i++) await tools.probe({kind:"delay",delay:300});');
  assert.deepEqual({ failed: result.isError, calls: f.calls.length, aborted: f.aborted.length }, { failed: false, calls: 4, aborted: 0 });
});

test("F-C6 D4: approval waiting does not expire the script before the authorized child runs", async t => {
  const f = await fixture(t, 1200);
  const { result } = await f.run('// @options: {"timeout_ms":500}\nawait tools.probe({kind:"approval"});');
  assert.equal(f.dialogs(), 1);
  assert.deepEqual({ failed: result.isError, calls: f.calls }, { failed: false, calls: ["approval"] });
});

test("control: script computation remains bounded", async t => {
  const f = await fixture(t);
  const { result } = await f.run('// @options: {"timeout_ms":100}\nwhile(true) {}');
  assert.equal(result.isError, true); assert.match(body(result.content), /timeout|timed out/i); assert.deepEqual(f.calls, []);
});

test("control: user cancellation still reaches a waiting child", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pending = f.run('await tools.probe({kind:"delay",delay:10000});');
  await f.started;
  await f.session.abort();
  const { result } = await pending;
  assert.equal(result.isError, true); assert.deepEqual(f.calls, ["delay"]); assert.deepEqual(f.aborted, ["delay"]);
});
