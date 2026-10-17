import assert from "node:assert/strict";
import test from "node:test";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body } from "./codemode-recovery/fixture.ts";

test("R2.2 explicit handling leaves true child errors and default caught failures still fail store", async t => {
  const f = await executionFixture(t);
  const handled = await f.run('const r=await callTool("probe",{kind:"failure"},{allowFailure:true});text(r.isError);await tools.probe({kind:"ok"});store("saved",1);');
  assert.equal(handled.result.isError, false);
  assert.match(body(handled.result.content), /Handled failures: 1/);
  const facts = handled.result.details.codemode.calls;
  assert.deepEqual(facts.map((fact: any) => [fact.isError, fact.failureHandled, fact.executed]), [[true, true, true], [false, false, true]]);
  const caught = await f.run('try {await tools.probe({kind:"failure"});}catch{} await tools.probe({kind:"ok"});store("saved",2);');
  assert.equal(caught.result.isError, true);
  const loaded = await f.run('text(load("saved"));');
  assert.match(body(loaded.result.content), /\n1(?:\n|$)/);
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
