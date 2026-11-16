import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBashToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";

test("script parse failures distinguish successful truncated shell output and recover without replay", async t => {
  const owned = createOwnedTaskFixture("codemode-shell-json-");
  const oldTemps = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
  process.env.TMP = owned.root; process.env.TEMP = owned.root; process.env.TMPDIR = owned.root;
  const payload = JSON.stringify({ items: Array.from({ length: 4000 }, (_, index) => index) }, null, 2);
  const calls: string[] = [];
  let saved = "";
  const shell = createBashToolDefinition(owned.root, { exposeSessionEnvironment: false, operations: {
    async exec(command, cwd, options) {
      calls.push(command);
      const text = command === "large" ? payload : command === "recover"
        ? JSON.stringify({ count: JSON.parse(readFileSync(saved, "utf8")).items.length })
        : command === "invalid" ? "not json" : '{"ok":true}';
      options.onData(Buffer.from(text));
      return { exitCode: 0, termination: "exit", observation: { started: true, cwd, exitCode: 0, signal: null, outputDrained: true } };
    },
  } });
  const f = await sessionFixture(t, { fixtureRoot: owned.root, g2: false, customTools: [shell], allowReplacements: true });
  t.after(() => {
    for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) {
      if (oldTemps[index] === undefined) delete process.env[key]; else process.env[key] = oldTemps[index];
    }
    owned.cleanup();
  });
  const first = (await f.run('const r=await tools.bash({command:"large"});store("uncommitted",true);JSON.parse(r.content[0].text);')).result;
  assert.equal(first.isError, true, "the actual script failure must remain visible");
  assert.deepEqual([first.details.codemode.succeeded, first.details.codemode.failed], [1, 0]);
  const fact = first.details.codemode.calls[0];
  assert.equal(fact.exitCode, 0); assert.equal(fact.resultComplete, true, "capture drained successfully");
  assert.equal(fact.outputTruncated, true, "a drained capture is not a complete script document");
  saved = fact.outputPath;
  assert.ok(saved.startsWith(owned.root));
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), JSON.parse(payload));
  assert.match(body(first.content), /CODEMODE_SCRIPT.*successful bash output is truncated/);
  assert.match(body(first.content), /Do not repeat completed commands/);
  assert.match(body(first.content), /bash: exited; exit=0; output truncated/);
  const next = (await f.run('const r=await tools.bash({command:"recover"});text(JSON.parse(r.content[0].text).count);text(load("uncommitted")??null);')).result;
  assert.equal(next.isError, false, body(next.content));
  assert.match(body(next.content), /4000/); assert.match(body(next.content), /null/);
  assert.deepEqual(calls, ["large", "recover"], "successful producer is never replayed");
  const plain = (await f.run('const r=await tools.bash({command:"plain"});text(JSON.parse(r.content[0].text).ok);')).result;
  assert.equal(plain.isError, false); assert.equal(plain.details.codemode.calls[0].outputTruncated, false);
  const invalid = (await f.run('const r=await tools.bash({command:"invalid"});JSON.parse(r.content[0].text);')).result;
  assert.equal(invalid.isError, true);
  assert.doesNotMatch(body(invalid.content), /successful bash output is truncated/);
});
