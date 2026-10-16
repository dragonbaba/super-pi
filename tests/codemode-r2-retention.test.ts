import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body } from "./codemode-recovery/fixture.ts";

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
