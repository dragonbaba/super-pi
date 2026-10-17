import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { MUTATION_READ_SOURCE } from "../packages/coding-agent/src/core/tools/read-window.ts";

function own(t: TestContext, path: string): void {
  t.after(() => { assert.equal(readFileSync(path + ".sp-owned", "utf8"), "super-pi-output-spill-v2\n"); unlinkSync(path); unlinkSync(path + ".sp-owned"); });
}

test("R2.3 show overflow keeps successful status, bounded blocks and a readable artifact after close", async t => {
  const f = await executionFixture(t);
  const { result } = await f.run('for(let i=0;i<3;i++) await show((await tools.probe({kind:"blocks"})).ref);store("shown",true);');
  assert.equal(result.isError, false);
  assert.equal(result.details.codemode.displayLimited, true);
  assert.match(body(result.content), /CODEMODE_DISPLAY_LIMITED/);
  const fact = result.details.codemode.calls[2];
  assert.equal(fact.displayLimited, true);
  assert.ok(fact.outputPath); own(t, fact.outputPath);
  await (f.session as any)._codemode.close();
  assert.match(readFileSync(fact.outputPath, "utf8"), /block-99/);
  assert.equal(f.calls.length, 3);
});

test("R2.4 close during a pending child cannot repopulate native-read references", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const owner = new CodemodeController(() => assert.fail("closed store must not commit"));
  const catalog = ["read", "wait"].map(name => ({ name, label: name, description: name, parameters: { type: "object" }, execute: async () => ({ content: [], details: {} }) }));
  owner.setTools(catalog);
  const dispatch = new NestedToolDispatch("close", () => catalog, async (call, _tool, signal) => {
    if (call.name === "wait") {
      started();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    }
    const content = [{ type: "text" as const, text: "native read" }];
    Object.defineProperty(content, MUTATION_READ_SOURCE, { value: true });
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 1, content, details: {} };
  });
  try {
    const work = (owner as any).execute('await show((await tools.read({path:"fixture"})).ref);await tools.wait({});store("late",true);', dispatch);
    await waiting; await owner.close();
    assert.equal((await work).isError, true);
    assert.equal((owner as any).displayedReads.size, 0);
    assert.equal((owner as any).current, undefined);
    assert.equal((owner as any).pendingStore, undefined);
  } finally { await owner.close(); }
});

test("R2.4 input is absent from cached results; eviction returns a persistent location without replay", async t => {
  let calls = 0;
  const f = await sessionFixture(t, { g2: false, customTools: [{ name: "payload", label: "payload", description: "bounded retention fixture",
    parameters: { type: "object", properties: { blob: { type: "string" } } },
    execute: async () => ({ content: [{ type: "text", text: `RESULT-${++calls}\n` + "x".repeat(120000) }], details: {} }) }] });
  const owner = (f.session as any)._codemode;
  const observations: any[] = [];
  const original = owner.runChild.bind(owner);
  t.mock.method(owner, "runChild", async (...args: any[]) => {
    const value = await original(...args);
    const current = owner.current;
    observations.push({ chars: current.retainedChars, entries: current.records.size,
      inputs: Array.from(current.records.values()).filter((record: any) => record.input !== undefined).length });
    return value;
  });
  const { result } = await f.run('const first=await tools.payload({blob:"x".repeat(220000)});for(let i=0;i<9;i++) await tools.payload({});text(await show(first.ref));store("evicted",true);');
  assert.equal(result.isError, false, body(result.content));
  assert.equal(calls, 10);
  assert.ok(observations.every(o => o.chars <= 1024 * 1024 && o.entries <= 256 && o.inputs === 0));
  assert.match(body(result.content), /CODEMODE_REF_EVICTED/);
  const fact = result.details.codemode.calls[0];
  assert.equal(fact.evicted, true);
  const paths = new Set<string>();
  for (const call of result.details.codemode.calls) if (call.outputPath) paths.add(call.outputPath);
  for (const path of paths) own(t, path);
  await owner.close();
  assert.match(readFileSync(fact.outputPath, "utf8"), /RESULT-1\n/);
  assert.ok(readFileSync(fact.outputPath, "utf8").includes("x".repeat(120000)));
  assert.equal(owner.current, undefined);
});
