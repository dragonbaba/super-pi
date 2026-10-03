import assert from "node:assert/strict";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const jiti = createJiti(import.meta.url);
const { loadRuntime } = await jiti.import<any>("../packages/lsp/src/adapters.ts");
const { selectDiagnosticRoutes } = await jiti.import<any>("../packages/lsp/src/routes.ts");
const { runDiagnostics, runFix } = await jiti.import<any>("../packages/lsp/src/runner.ts");
const { LspClientPool } = await jiti.import<any>("../packages/lsp/src/client-pool.ts");
const { default: extension } = await jiti.import<any>("../packages/lsp/src/pi-lsp.ts");
const server = resolve("tests/fixtures/lsp-diagnostic-server.mjs");

function fixture(mode = "full") {
  const root = mkdtempSync(join(tmpdir(), "sp-lsp-scope-"));
  mkdirSync(join(root, ".sp/config"), { recursive: true });
  writeFileSync(join(root, "page.html"), "<script>const broken = ;</script>");
  writeFileSync(join(root, "example.ts"), "const n = 1;");
  writeFileSync(join(root, ".sp/config/pi-lsp.json"), JSON.stringify({ timeout: 2500, servers: { fixture: {
    command: [process.execPath, server, mode], extensions: [".ts"], pushDiagnosticsGraceMs: mode === "push-provisional" ? 250 : 60, diagnosticsSettleMs: 10,
  } } }));
  const runtime = loadRuntime(root, { projectTrusted: true });
  return { root, ...runtime, release() { assert.equal(dirname(root), tmpdir()); removeOwnedFixture(root); } };
}
function tools() {
  const registered = new Map<string, any>(), events = new Map<string, any>();
  extension({ registerTool(tool: any) { registered.set(tool.name, tool); }, registerCommand() {}, on(name: string, fn: any) { events.set(name, fn); } });
  return { registered, events };
}

test("configured route is explicit about zero files and unsupported HTML; no client acquisition", async () => {
  const f = fixture(); let acquired = 0;
  try {
    assert.throws(() => selectDiagnosticRoutes(f.adapters, { root: f.root, paths: ["page.html"] }, 50), /No supported files/);
    const result = await runDiagnostics({ acquire() { acquired++; throw new Error("unexpected spawn"); } }, f.adapters[0], { root: f.root, files: [] }, 100, undefined, { ui: { setStatus() {} } }, "lsp");
    assert.equal(result.isError, true); assert.equal(result.details.status, "not_checked"); assert.equal(acquired, 0);
    assert.equal(result.details.summary.files, 0);
    const missing = { ...f.adapters[0], isDefault: true, defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const routes = selectDiagnosticRoutes([missing], { root: f.root, paths: ["example.ts"] }, 50);
    assert.equal(routes.routes.length, 0); assert.equal(routes.skipped.length, 1);
    assert.deepEqual(routes.skipped[0].files, [join(f.root, "example.ts")]);
    assert.throws(() => selectDiagnosticRoutes([missing], { root: f.root, paths: ["page.html"] }, 50), /No supported files/);
  } finally { f.release(); }
});

test("a capped skipped route remains incomplete after its known files overlap a live route", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "a.ts"), "const a = 1;"); writeFileSync(join(f.root, "z.py"), "x = 1");
    const broad = { ...f.adapters[0], isDefault: true, name: "missing-broad", extensions: [".ts", ".py"],
      isSupportedFile(file: string) { return file.endsWith(".ts") || file.endsWith(".py"); },
      defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const limited = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "z.py"], limit: 1 }, 50);
    assert.deepEqual(limited.uncoveredFiles, []);
    assert.equal(limited.skippedScopeLimited, true);
    assert.equal(limited.incomplete, true, "known overlap is not proof of coverage beyond the cap");
    const exhausted = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts"], limit: 1 }, 50);
    assert.equal(exhausted.skippedScopeLimited, false);
    assert.equal(exhausted.incomplete, false, "a fully collected overlapping skipped route does not create missing scope");
    mkdirSync(join(f.root, "single")); writeFileSync(join(f.root, "single", "one.ts"), "const one = 1;");
    const exactDirectory = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["single"], limit: 1 }, 50);
    assert.equal(exactDirectory.skippedScopeLimited, false, "the final entry can exactly fill the cap without truncation");
    const repeated = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "a.ts"], limit: 1 }, 50);
    assert.equal(repeated.skippedScopeLimited, false);
    const remaining = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "a.ts", "z.py"], limit: 1 }, 50);
    assert.equal(remaining.skippedScopeLimited, true);
    const unrelated = selectDiagnosticRoutes([f.adapters[0], broad], { root: f.root, paths: ["a.ts", "page.html"], limit: 1 }, 50);
    assert.equal(unrelated.skippedScopeLimited, false, "a known unsupported explicit file does not truncate a skipped route");
  } finally { f.release(); }
});

test("unavailable policies share one real directory traversal without changing per-policy scope", () => {
  const f = fixture();
  const scan = join(f.root, "scan");
  mkdirSync(join(scan, "sub"), { recursive: true });
  writeFileSync(join(scan, "a.ts"), "const a = 1;");
  writeFileSync(join(scan, "sub", "b.ts"), "const b = 1;");
  try {
    // Instrument before module loading in a private process, including cached Jiti imports.
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-shared-scan.mjs"), f.root], {
      encoding: "utf8", env: { ...process.env, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const selected = JSON.parse(child.stdout);
    assert.equal(selected.routes, 1); assert.equal(selected.skipped, 0);
    assert.equal(selected.incomplete, false);
    assert.equal(selected.directoryReads, 2, "directory IO must not multiply by unavailable server count");
  } finally { f.release(); }
});

test("shared route traversal preserves each policy's skipped subtrees and explicit paths", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "scan", "skip-live"), { recursive: true });
    mkdirSync(join(f.root, "scan", "skip-missing"));
    writeFileSync(join(f.root, "scan", "a.ts"), "const a = 1;");
    writeFileSync(join(f.root, "scan", "skip-live", "b.ts"), "const b = 1;");
    writeFileSync(join(f.root, "scan", "skip-live", "c.py"), "x = 1");
    writeFileSync(join(f.root, "scan", "skip-missing", "d.py"), "x = 2");
    const live = { ...f.adapters[0], skipDirectories: new Set(["skip-live"]) };
    const missing = { ...f.adapters[0], name: "missing", isDefault: true, extensions: [".py"], skipDirectories: new Set(["skip-missing"]),
      isSupportedFile(file: string) { return file.endsWith(".py"); }, defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] } };
    const selected = selectDiagnosticRoutes([live, missing], { root: f.root, paths: ["scan"] }, 50);
    assert.deepEqual(selected.routes[0].files, [join(f.root, "scan", "a.ts")]);
    assert.deepEqual(selected.uncoveredFiles, [join(f.root, "scan", "skip-live", "c.py")]);
    const explicit = selectDiagnosticRoutes([live, missing], { root: f.root, paths: ["scan/skip-missing/d.py"] }, 50);
    assert.deepEqual(explicit.uncoveredFiles, [join(f.root, "scan", "skip-missing", "d.py")]);
  } finally { f.release(); }
});

for (const mode of ["full", "push-empty", "push-provisional", "push-silent", "push-missing-report", "push-null-report", "missing-report", "error"]) {
  test(`real protocol process: ${mode} preserves diagnostic status (not a language-capability test)`, async () => {
    const f = fixture(mode), pool = new LspClientPool();
    try {
      const work = runDiagnostics(pool, f.adapters[0], { root: f.root, paths: ["example.ts"] }, 2500, undefined, { ui: { setStatus() {} } }, "lsp");
      if (mode === "full" || mode === "push-empty" || mode === "push-provisional") {
        const result = await work;
        assert.equal(result.details.status, "diagnostics_received"); assert.equal(result.details.summary.files, 1);
        assert.equal(result.details.summary.diagnostics, mode === "push-provisional" ? 1 : 0);
      } else await assert.rejects(work, /unconfirmed|synthetic diagnostic failure/);
    } finally { await pool.shutdownAll(); f.release(); }
  });
}

test("tool uses session cwd, preserves received count and discloses unverified embedded languages", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    for (const name of ["subproject", " subproject", ...(process.platform === "win32" ? [] : ["subproject "])]) {
      mkdirSync(join(f.root, name)); writeFileSync(join(f.root, name, "example.ts"), "const n = 1;");
    }
    for (const root of [undefined, "   ", "subproject", " subproject", ...(process.platform === "win32" ? [] : ["subproject "])]) {
      const result = await registration.registered.get("lsp_diagnostics").execute("scope", { root, paths: ["example.ts"] }, undefined, undefined, ctx);
      assert.equal(result.details.root, root?.trim() ? join(f.root, root) : f.root);
      assert.equal(result.details.submittedFiles, 1);
      assert.equal(result.details.status, "diagnostics_received");
      assert.match(result.content[0].text, /Embedded languages.*not established/);
      assert.equal(result.isError, false);
    }
  } finally { await registration.events.get("session_shutdown")({}, ctx); f.release(); }
});

test("strict validation can fail for silence while source fixes retain an empty diagnostic context", async () => {
  const f = fixture("push-silent"), pool = new LspClientPool();
  const ctx = { ui: { setStatus() {} } };
  try {
    await assert.rejects(runDiagnostics(pool, f.adapters[0], { root: f.root, paths: ["example.ts"] }, 2500, undefined, ctx, "lsp"), /unconfirmed/);
    const result = await runFix(pool, f.adapters[0], { root: f.root, path: "example.ts", write: false }, 2500, undefined, ctx, "lsp");
    assert.equal(result.details.changed, true);
    assert.equal(result.details.editCount, 1);
    assert.match(result.content[0].text, /const n = 2/);
    assert.equal(readFileSync(join(f.root, "example.ts"), "utf8"), "const n = 1;", "preview is not a write or a validation pass");
  } finally { await pool.shutdownAll(); f.release(); }
});

test("actual tool reports live-route truncation as partial and exact-cap exhaustion as complete", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    writeFileSync(join(f.root, "second.ts"), "const second = 2;");
    const partial = await registration.registered.get("lsp_diagnostics").execute("limited", { paths: ["example.ts", "second.ts"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(partial.details.submittedFiles, 1);
    assert.equal(partial.details.routedScopeLimited, true);
    assert.equal(partial.details.status, "partial"); assert.equal(partial.isError, true);
    assert.match(partial.content[0].text, /available route.*unvisited/i);
    const complete = await registration.registered.get("lsp_diagnostics").execute("complete", { paths: ["example.ts"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.routedScopeLimited, false);
    assert.equal(complete.details.status, "diagnostics_received"); assert.equal(complete.isError, false);
    const unrelated = await registration.registered.get("lsp_diagnostics").execute("unrelated", { paths: ["example.ts", "page.html"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(unrelated.details.routedScopeLimited, false);
    assert.equal(unrelated.details.status, "diagnostics_received"); assert.equal(unrelated.isError, false);
    mkdirSync(join(f.root, "later.html")); writeFileSync(join(f.root, "later.html", "more.ts"), "const more = 1;");
    const directory = await registration.registered.get("lsp_diagnostics").execute("directory", { paths: ["example.ts", "later.html"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(directory.details.routedScopeLimited, true, "an unsupported-looking directory still has unvisited scope");
    assert.equal(directory.details.status, "partial"); assert.equal(directory.isError, true);
  } finally { await registration.events.get("session_shutdown")({}, ctx); f.release(); }
});

test("actual tool classifies capped directory symlinks before declaring omitted scope", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    const scan = join(f.root, "scan"); mkdirSync(scan);
    writeFileSync(join(scan, "a.ts"), "const a = 1;");
    symlinkSync(join(f.root, "page.html"), join(scan, "z.html"), "file");
    const tool = registration.registered.get("lsp_diagnostics");
    const complete = await tool.execute("unsupported-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.status, "diagnostics_received");
    assert.equal(complete.details.routedScopeLimited, false); assert.equal(complete.isError, false);
    symlinkSync(join(f.root, "absent.html"), join(scan, "z-dangling.html"), "file");
    const dangling = await tool.execute("dangling-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(dangling.details.status, "diagnostics_received"); assert.equal(dangling.isError, false);
      // This Windows runtime cannot unlink a dangling file link. Restore only
      // this fixture-owned target after the dangling-link assertion.
      writeFileSync(join(f.root, "absent.html"), "fixture cleanup target");
    symlinkSync(join(f.root, "example.ts"), join(scan, "z.ts"), "file");
    const supported = await tool.execute("supported-link", { paths: ["scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(supported.details.status, "partial"); assert.equal(supported.isError, true);
    const directoryScan = join(f.root, "directory-scan"); mkdirSync(directoryScan);
    writeFileSync(join(directoryScan, "a.ts"), "const a = 1;");
    symlinkSync(scan, join(directoryScan, "z.html"), process.platform === "win32" ? "junction" : "dir");
    const directory = await tool.execute("directory-link", { paths: ["directory-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(directory.details.status, "partial"); assert.equal(directory.isError, true);
  } finally { await registration.events.get("session_shutdown")({}, ctx); f.release(); }
});

test("actual tool recognizes a capped directory already exhausted through an earlier symlink", async () => {
  const f = fixture(), registration = tools();
  const ctx = { cwd: f.root, isProjectTrusted() { return true; }, ui: { setStatus() {} } };
  try {
    await registration.events.get("session_start")({}, ctx);
    const scan = join(f.root, "alias-scan"), target = join(scan, "z-real");
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, "only.ts"), "const only = 1;");
    symlinkSync(target, join(scan, "a-link"), process.platform === "win32" ? "junction" : "dir");
    const tool = registration.registered.get("lsp_diagnostics");
    const complete = await tool.execute("visited-directory", { paths: ["alias-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(complete.details.status, "diagnostics_received");
    assert.equal(complete.details.submittedFiles, 1); assert.equal(complete.isError, false);
    writeFileSync(join(target, "second.ts"), "const second = 2;");
    const partial = await tool.execute("incomplete-visited-directory", { paths: ["alias-scan"], limit: 1 }, undefined, undefined, ctx);
    assert.equal(partial.details.status, "partial"); assert.equal(partial.isError, true);
  } finally { await registration.events.get("session_shutdown")({}, ctx); f.release(); }
});

test("mixed available and unavailable matching default routes retain uncovered files and return partial", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "uncovered.py"), "x = 1\n");
    const binary = createRequire(import.meta.url).resolve(`@biomejs/cli-${process.platform}-${process.arch}/biome${process.platform === "win32" ? ".exe" : ""}`);
    const privatePath = dirname(binary);
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-skipped-tool.mjs"), f.root, "mixed"], {
      encoding: "utf8", env: { ...process.env, PATH: privatePath, Path: privatePath, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "partial", JSON.stringify(result));
    assert.equal(result.details.submittedFiles, 1);
    assert.deepEqual(result.details.uncoveredFiles, [join(f.root, "uncovered.py")]);
    assert.deepEqual(result.details.skipped[0].files, [join(f.root, "uncovered.py")]);
  } finally { f.release(); }
});

test("all unavailable default commands return not_checked from the actual tool in a private process", () => {
  const f = fixture();
  try {
    const child = spawnSync(process.execPath, [resolve("tests/fixtures/lsp-skipped-tool.mjs"), f.root], {
      encoding: "utf8", env: { ...process.env, PATH: f.root, Path: f.root, SP_CODING_AGENT_DIR: join(f.root, "isolated-agent") },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "not_checked");
    assert.equal(result.details.submittedFiles, 0);
    assert.match(result.content[0].text, /No validation pass/);
  } finally { f.release(); }
});

test("available real Biome diagnoses standalone JS; HTML route alone does not prove embedded JS coverage", async t => {
  const f = fixture(), pool = new LspClientPool();
  try {
    const biome = resolve("node_modules/@biomejs/biome/bin/biome");
    writeFileSync(join(f.root, ".sp/config/pi-lsp.json"), JSON.stringify({ servers: { biome: { command: [process.execPath, biome, "lsp-proxy"], extensions: [".js", ".html"] } } }));
    writeFileSync(join(f.root, "broken.js"), "const broken = ;");
    const { adapters } = loadRuntime(f.root, { projectTrusted: true });
    const js = await runDiagnostics(pool, adapters[0], { root: f.root, paths: ["broken.js"] }, 10000, undefined, { ui: { setStatus() {} } }, "lsp");
    assert.ok(js.details.summary.diagnostics > 0, "real malformed JS must be detected");
    const html = await runDiagnostics(pool, adapters[0], { root: f.root, paths: ["page.html"] }, 10000, undefined, { ui: { setStatus() {} } }, "lsp");
    // This records the observed server result; no assertion treats zero as HTML validity.
    t.diagnostic(JSON.stringify({ server: "repository-installed Biome", standaloneJsDiagnostics: js.details.summary.diagnostics, htmlDiagnostics: html.details.summary.diagnostics,
      htmlMessages: html.details.files.flatMap((file: any) => file.diagnostics.map((diagnostic: any) => diagnostic.message)), embeddedJsCoverage: "not established by route" }));
  } finally { await pool.shutdownAll(); f.release(); }
});
