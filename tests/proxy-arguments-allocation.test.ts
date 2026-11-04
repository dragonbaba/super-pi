import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const [phase, size] of [["counts", "16384"], ["counts", "65536"], ["wire", "65536"], ["lifecycle", "16384"]]) {
  test(`proxy linear work and released ownership: ${phase}/${size}`, t => {
    const owned = createOwnedTaskFixture("h10-proxy-gate-"); t.after(owned.cleanup);
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", fileURLToPath(new URL("../scripts/bench/proxy-tool-arguments.ts", import.meta.url)), phase!, size!], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, PROXY_BASELINE_PATH: undefined, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
    });
    writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent, childPid: child.pid, startedAt, code: child.status, purpose: phase }));
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr + child.stdout);
    const [metadata, report] = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    if (phase === "lifecycle") {
      assert.equal(report.parserRefs, 3); assert.equal(report.retainedParsers, 0); assert.equal(report.streamsAlive, 3);
      assert.deepEqual(report.rawInResults, [0, 0, 0]); assert.deepEqual(report.listeners, [0, 0, 0]);
      assert.ok(report.transport.every((row: { locked: boolean }) => !row.locked));
      assert.ok(report.released.every((row: { closed: boolean; retainedRawCodeUnits: number; depth: number }) => row.closed && row.retainedRawCodeUnits === 0 && row.depth === 0));
    } else {
      assert.equal(report.argumentParses, 0); assert.equal(report.parsedArgumentCodeUnits, 0); assert.equal(report.parserPromises, 0);
      assert.deepEqual(report.structural, { deltaObjects: 0, deltaSpreads: 0 });
      assert.equal(report.wireSplits, 0); assert.equal(report.decodeOptionIdentities, 1); assert.equal(report.transport.locked, false);
      if (phase === "counts") {
        assert.equal(report.deltas, Math.ceil(metadata.inputCodeUnits / 64)); assert.equal(report.parsers.length, 1);
        assert.equal(report.parsers[0].scannedCodeUnits, metadata.inputCodeUnits); assert.equal(report.parsers[0].retainedRawCodeUnits, 0);
      } else assert.ok(report.wireScanCodeUnits < 2 * Number(size), "scan only new wire chunks, not the accumulated SSE line");
    }
    t.diagnostic(JSON.stringify(report));
  });
}

test("proxy delta and SSE line scanner have no transient containers, closures, regex or async wrappers", () => {
  const source = readFileSync(new URL("../packages/agent/src/proxy.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("proxy.ts", source, ts.ScriptTarget.Latest, true);
  const selected: ts.Node[] = [];
  function locate(node: ts.Node): void {
    if (ts.isCaseClause(node) && node.expression.getText(file) === '"toolcall_delta"') selected.push(node);
    if (ts.isWhileStatement(node) && node.expression.getText(file) === "newline !== -1") selected.push(node.statement);
    ts.forEachChild(node, locate);
  }
  locate(file); assert.equal(selected.length, 2);
  const violations: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isThrowStatement(node)) { assert.equal(node.expression.getText(file), 'new Error("Received toolcall_delta without an active tool call")'); return; }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isAwaitExpression(node) || ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isSpreadAssignment(node) || ts.isSpreadElement(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) violations.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  selected.forEach(visit); assert.deepEqual(violations, []);
  assert.doesNotMatch(source, /partialJson|parseStreamingJson|\.split\(/);
});
