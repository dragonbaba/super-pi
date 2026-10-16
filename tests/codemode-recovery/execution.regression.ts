import assert from "node:assert/strict";
import test from "node:test";
import { body } from "./fixture.ts";
import { executionFixture as fixture } from "./execution-fixture.ts";

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
  assert.match(body(first.result.content), /\{"handled":true\}/, "allowFailure must return the failed outcome without throwing");
  assert.doesNotMatch(body(first.result.content), /caught failure/, "catch must not substitute for explicit allowFailure handling");
  assert.deepEqual(f.calls, ["failure", "ok"], "no replay of the failed or successful child");
  const facts = (first.result.details as any).codemode.calls;
  assert.equal(facts[0].isError, true); assert.equal(facts[1].isError, false);
  assert.equal((first.result.details as any).codemode.scriptOk, true);
  assert.deepEqual({ failed: first.result.isError, saved: body(second.result.content).includes('"recovered":"yes"') },
    { failed: false, saved: true }, "a recovered script must commit its store while preserving the failed child record");
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
