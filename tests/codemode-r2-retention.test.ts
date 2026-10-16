import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";

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
