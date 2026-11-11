import assert from "node:assert/strict";
import test from "node:test";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body } from "./codemode-recovery/fixture.ts";

test("handled failures preserve true child errors and caught alternatives commit the store", async t => {
  const f = await executionFixture(t);
  const handled = await f.run('const r=await callTool("probe",{kind:"failure"},{allowFailure:true});text(r.isError);await tools.probe({kind:"ok"});store("saved",1);');
  assert.equal(handled.result.isError, false);
  assert.match(body(handled.result.content), /Handled failures: 1/);
  const facts = handled.result.details.codemode.calls;
  assert.deepEqual(facts.map((fact: any) => [fact.isError, fact.failureHandled, fact.executed]), [[true, true, true], [false, false, true]]);
  const caught = await f.run('try {await callTool("probe",{kind:"failure"});}catch{text("caught failure without allowFailure");} await tools.probe({kind:"ok"});store("saved",2);store("caughtOnly",true);text("alternative completed");');
  assert.match(body(caught.result.content), /caught failure without allowFailure/);
  assert.match(body(caught.result.content), /alternative completed/);
  assert.equal(caught.result.details.codemode.scriptOk, true);
  assert.deepEqual(caught.result.details.codemode.calls.map((fact: any) => fact.isError), [true, false]);
  assert.equal(caught.result.isError, false);
  assert.match(body(caught.result.content), /CODEMODE_PARTIAL/);
  assert.deepEqual([caught.result.details.codemode.succeeded, caught.result.details.codemode.failed,
    caught.result.details.codemode.handledFailures,caught.result.details.codemode.unhandled],[1,1,1,0]);
  assert.deepEqual(f.calls, ["failure", "ok", "failure", "ok"]);
  const loaded = await f.run('text({saved:load("saved"),caughtOnly:load("caughtOnly") ?? null});');
  assert.match(body(loaded.result.content), /"saved":2/);
  assert.match(body(loaded.result.content), /"caughtOnly":true/);
});

test("R2.2 handled failure never clears a concurrent unhandled failure or masks observation failure", async () => {
  for (const observationFailure of [undefined, { executionIsError: false, error: "observer failed" }]) {
    const dispatch = new NestedToolDispatch("parent", () => [], async call => ({ role: "toolResult", toolCallId: call.id,
      toolName: call.name, timestamp: 1, isError: true, content: [{ type: "text", text: "original failure" }], observationFailure }));
    const result = await dispatch.callTool("fixture", {}, { allowFailure: true });
    assert.equal(result.isError, true);
    assert.equal(dispatch.hasErrors, !!observationFailure);
    await dispatch.callTool("fixture", {});
    await dispatch.callTool("fixture", {}, { allowFailure: true });
    assert.equal(await dispatch.finish(), true);
  }
});

test("R2.2 invalid options fail before tools execute and never commit store", async t => {
  const f = await executionFixture(t);
  const result = await f.run('try {await callTool("probe",{kind:"ok"},{allowFailure:"true"});} catch {} store("bad",true);');
  assert.equal(result.result.isError, true);
  assert.equal(f.calls.length, 0);
  const loaded = await f.run('text(load("bad") ?? null);');
  assert.match(body(loaded.result.content), /null/);
});
