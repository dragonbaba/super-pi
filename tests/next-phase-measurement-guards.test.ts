import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import ts from "typescript";
import { runMeasuredChild } from "../scripts/bench/next-phase-child.mjs";
import { captureBuiltArtifacts } from "../scripts/bench/next-phase-build.mjs";

test("N4 build manifest detects ignored artifact mutation without a Git change", () => {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-build-test-")), dist = join(root, "packages", "fixture", "dist");
  try {
    mkdirSync(dist, { recursive: true }); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(dist, "index.js"), "original");
    const before = captureBuiltArtifacts(root); assert.equal(before.files.length, 1);
    assert.deepEqual(captureBuiltArtifacts(root), before);
    writeFileSync(join(dist, "index.js"), "stale artifact"); assert.notEqual(captureBuiltArtifacts(root).sha256, before.sha256);
    writeFileSync(join(root, "package-lock.json"), '{"changed":true}'); assert.notEqual(captureBuiltArtifacts(root).lockfileSha256, before.lockfileSha256);
  } finally { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
});

test("N4 shared measurement model helper imports no production module graph", () => {
  const fixture = "tests/helpers/next-phase-model.ts";
  const model = ts.createSourceFile(fixture, readFileSync(fixture, "utf8"), ts.ScriptTarget.Latest, true);
  assert.equal(model.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier), false);
  for (const file of ["tests/next-phase-task-matrix.test.ts", "tests/helpers/next-phase-session.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    assert.ok(imports.some(path => path.endsWith("/next-phase-model.ts")));
    for (const path of imports) assert.ok(path.startsWith("node:") || path === "js-tiktoken" || path.endsWith("/next-phase-model.ts") || path.endsWith("/next-phase-fixture-regex.ts"), path);
  }
});

for (const scenario of ["matrix", "session", "spill", "io"]) test(`N4 ${scenario} setup failure releases its exact owned fixture`, () => {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-setup-test-")), record = join(root, "roots.jsonl");
  try {
    const args = ["--experimental-strip-types", "--import", pathToFileURL(resolve("tests/fixtures/next-phase-measurement-preload.mjs")).href];
    if (scenario === "matrix") args.push("--test", "tests/next-phase-task-matrix.test.ts");
    else if (scenario === "spill" || scenario === "io") args.push(`scripts/bench/next-phase-${scenario === "spill" ? "output-spill" : "file-io"}.ts`);
    else args.push("--input-type=module", "-e", `const fixture = await import(${JSON.stringify(pathToFileURL(resolve("tests/helpers/next-phase-session.ts")).href)}); await fixture.costSession();`);
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnvironment } = process.env;
    const child = spawnSync(process.execPath, args, { cwd: process.cwd(), env: { ...childEnvironment, SP_N4_SETUP_RECORD: record, SP_N4_SETUP_KIND: scenario }, windowsHide: true, encoding: "utf8", timeout: 30000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 1); assert.ok((child.stdout + child.stderr).includes("N4 fixture loader setup failure"));
    const entries = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)); assert.equal(entries.length, 1);
    assert.equal(dirname(entries[0].root), tmpdir()); assert.equal(existsSync(entries[0].root), false);
  } finally { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["success", "stalled", "inherited-pty-stall", "missing"]) test(`N4 comparison child owns deadline/close path: ${scenario}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-child-test-")), file = join(root, "child.log"), ledger = join(root, "ledger.jsonl");
  try {
    const result = runMeasuredChild({ executable: scenario === "missing" ? process.execPath + ".absent" : process.execPath,
      args: ["-e", scenario === "stalled" || scenario === "inherited-pty-stall" ? "setInterval(()=>{},1000)" : "process.stdout.write('completed')"], project: root, file, ledger,
      env: process.env, tag: scenario, inheritStdio: scenario === "inherited-pty-stall", deadlineMs: scenario === "stalled" || scenario === "inherited-pty-stall" ? 150 : 10000 });
    if (scenario === "success") await result;
    else await assert.rejects(result, scenario === "missing" ? /ENOENT/ : /deadline/);
    const entries = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const end = entries.at(-1); assert.equal(end.cleanupIncomplete, false); assert.ok(end.closed);
    if (scenario === "success") assert.equal(readFileSync(file, "utf8"), "completed");
    if (scenario === "stalled" || scenario === "inherited-pty-stall") {
      const pid = entries[0].pid; assert.ok(Number.isInteger(pid));
      assert.ok(entries.some(entry => entry.terminationRequested));
      assert.throws(() => process.kill(pid, 0), (error: any) => error.code === "ESRCH");
    }
  } finally { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
});

test("N4 comparison ledger write failure terminates its recorded live child", async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-n4-ledger-test-")), spawn = childProcess.spawn; let pid: number | undefined;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { const child = Reflect.apply(spawn, childProcess, args); pid = child.pid; return child; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runMeasuredChild({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], project: root,
      file: join(root, "child.log"), ledger: root, env: process.env, tag: "ledger-failed", deadlineMs: 10000 }));
    assert.ok(pid); assert.throws(() => process.kill(pid!, 0), (error: any) => error.code === "ESRCH");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
});
