import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { initTheme } from "@super-pi/coding-agent";
import { searchFixture } from "./helpers/tool-search-fixture.ts";
import { classifyError } from "../packages/extensions/tool-loop-guardrails/failure-classification.ts";

const extension = await import(new URL("../packages/project-context/src/index.js", import.meta.url).href);
const core = await import(new URL("../packages/project-context/src/core.js", import.meta.url).href);
const { INDEX_STAGE } = await import(new URL("../packages/project-context/src/index-progress.js", import.meta.url).href);
const { runIndexTask } = await import(new URL("../packages/project-context/src/index-task.js", import.meta.url).href);

interface Command {
  description: string;
  handler(args: string, context: unknown): Promise<void>;
}

function fixture(t: TestContext, existingAgents = true) {
  const root = mkdtempSync(join(tmpdir(), "sp-project-context-retirement-"));
  const cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".codegraph"));
  mkdirSync(agent);
  execFileSync("git", ["init", "--quiet", cwd], { stdio: "pipe", windowsHide: true });
  const agents = Buffer.from("# User rules\r\n\r\nKeep these bytes.  \r\n");
  const indexBytes = Buffer.from("retained user index\n");
  if (existingAgents) writeFileSync(join(cwd, "AGENTS.md"), agents);
  writeFileSync(join(cwd, "src", "main.ts"), "export const answer = 42;\n");
  writeFileSync(join(cwd, ".codegraph", "codegraph.db"), indexBytes);
  const previousAgent = process.env.SP_CODING_AGENT_DIR;
  process.env.SP_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previousAgent === undefined) delete process.env.SP_CODING_AGENT_DIR;
    else process.env.SP_CODING_AGENT_DIR = previousAgent;
    rmSync(root, { recursive: true, force: true });
  });
  const commands = new Map<string, Command>();
  const tools: string[] = [];
  const notices: Array<{ text: string; level: string }> = [];
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    on() {},
    async exec() { assert.fail("project commands must not invoke the retired external executable"); },
  };
  extension.default(pi);
  const context = { cwd, hasUI: true, ui: {
    notify(text: string, level: string) { notices.push({ text, level }); },
    async confirm() { assert.fail("retained project commands require no graph initialization dialog"); },
  } };
  async function run(name: string, level = "info") {
    const command = commands.get(name);
    assert.ok(command, `missing retained command: ${name}`);
    const before = notices.length;
    await command.handler("", context);
    assert.equal(notices.length, before + 1);
    const notice = notices.at(-1)!;
    assert.equal(notice.level, level, notice.text);
    return notice.text;
  }
  return { cwd, agent, commands, tools, agents, indexBytes, run };
}

test("project-context registers only its retained commands and no graph tool", t => {
  const f = fixture(t);
  assert.deepEqual([...f.commands.keys()], ["project-status", "project-init", "project-refresh"]);
  assert.deepEqual(f.tools, []);
  assert.equal(Object.hasOwn(extension, "registerCodeGraphTool"), false);
  assert.equal(Object.hasOwn(core, "codeGraphAvailability"), false);
});

test("project refresh excludes task snapshots while retaining actual source and scratch bytes", async t => {
  const f = fixture(t);
  const scratch = join(f.cwd, ".task-tmp", "old-task", "legacy-extension");
  mkdirSync(scratch, { recursive: true });
  const cached = join(scratch, "index.ts"), bytes = Buffer.from("export const retired = true;\n");
  writeFileSync(cached, bytes);
  await f.run("project-init");
  const index = readFileSync(join(f.cwd, ".sp", "project-index.jsonl"), "utf8");
  assert.match(index, /src\/main\.ts/);
  assert.doesNotMatch(index, /old-task|legacy-extension|\.task-tmp/);
  assert.deepEqual(readFileSync(cached), bytes, "refresh never deletes scratch resources");
});

test("project-status remains read-only before initialization without graph readiness", async t => {
  const f = fixture(t);
  const text = await f.run("project-status");
  assert.match(text, /Initialized: no/);
  assert.match(text, /Index: missing/);
  assert.doesNotMatch(text, /(?:^|\n)CodeGraph[: ]/i);
  assert.equal(core.getStatus(f.cwd, f.agent).initialized, false);
  assert.deepEqual(readFileSync(join(f.cwd, "AGENTS.md")), f.agents);
});

test("initialization and refresh preserve rules, memory and legacy graph data", async t => {
  const f = fixture(t);
  await f.run("project-init");
  const agentsPath = join(f.cwd, "AGENTS.md");
  const initializedRules = readFileSync(agentsPath);
  assert.deepEqual(initializedRules.subarray(0, f.agents.length), f.agents);
  const navigation = initializedRules.subarray(f.agents.length).toString("utf8");
  assert.match(navigation, /\r\n## Project Context\r\n/);
  assert.match(navigation, /\.sp\/project-context\.md/);
  assert.match(navigation, /\.sp\/project-index\.jsonl/);
  assert.match(navigation, /\.spignore/);
  const rulesMtime = fs.statSync(agentsPath).mtimeMs;
  const memory = join(core.detectHermes(f.cwd, f.cwd, f.agent).memoryDir, "MEMORY.md");
  const memoryBytes = Buffer.from("Keep saved memory.  \r\n");
  writeFileSync(memory, memoryBytes);
  await f.run("project-init");
  assert.deepEqual(readFileSync(agentsPath), initializedRules);
  assert.deepEqual(readFileSync(memory), memoryBytes);
  assert.deepEqual(readFileSync(join(f.cwd, ".codegraph", "codegraph.db")), f.indexBytes);
  const index = readFileSync(join(f.cwd, ".sp", "project-index.jsonl"), "utf8");
  assert.match(index, /src\/main\.ts/);
  assert.doesNotMatch(index, /codegraph/i);
  assert.doesNotMatch(readFileSync(join(f.cwd, ".sp", "project-context.md"), "utf8"), /codegraph/i);
  assert.match(await f.run("project-status"), /Index: published/);
  writeFileSync(join(f.cwd, "src", "next.ts"), "export const next = true;\n");
  assert.match(await f.run("project-status"), /Index: published/);
  assert.doesNotMatch(await f.run("project-refresh"), /codegraph/i);
  assert.match(await f.run("project-status"), /Index: published/);
  assert.equal(fs.statSync(agentsPath).mtimeMs, rulesMtime);
  assert.deepEqual(readFileSync(memory), memoryBytes);
  assert.deepEqual(readFileSync(join(f.cwd, ".codegraph", "codegraph.db")), f.indexBytes);
});

test("status leaves legacy content in place until an explicit refresh", async t => {
  const f = fixture(t);
  await f.run("project-init");
  const profile = join(f.cwd, ".sp", "project-context.md");
  const legacy = readFileSync(profile, "utf8")
    + "\n## Deep Index Recommendation\n\n- CodeGraph may be useful: initialize only after explicit approval.\n";
  writeFileSync(profile, legacy);
  assert.equal(core.getStatus(f.cwd, f.agent).indexState, "published");
  assert.equal(readFileSync(profile, "utf8"), legacy, "status must not rewrite the legacy profile");
  assert.match(await f.run("project-status"), /Index: published/);
  assert.match(await f.run("project-refresh"), /context refreshed:/);
  assert.equal(core.getStatus(f.cwd, f.agent).indexState, "published");
  assert.doesNotMatch(readFileSync(profile, "utf8"), /codegraph/i);
  assert.match(await f.run("project-refresh"), /already current/);
});

test("index failure leaves identity and AGENTS ready and preserves the old published pair", async t => {
  const f = fixture(t, false);
  const ignore = join(f.cwd, ".spignore");
  mkdirSync(ignore);
  const first = await f.run("project-init", "warning");
  assert.match(first, /Project initialized:/);
  assert.match(first, /AGENTS\.md: created/);
  assert.match(first, /Index: not completed:/);
  const before = core.getStatus(f.cwd, f.agent);
  assert.equal(before.indexState, "missing");
  assert.ok(before.manifest.id);
  fs.rmdirSync(ignore);
  assert.match(await f.run("project-refresh"), /context refreshed:/);
  const index = join(f.cwd, ".sp", "project-index.jsonl");
  const profile = join(f.cwd, ".sp", "project-context.md");
  const oldIndex = readFileSync(index);
  const oldProfile = readFileSync(profile);
  mkdirSync(ignore);
  assert.match(await f.run("project-refresh", "error"), /not completed:.*Previous index retained/);
  assert.deepEqual(readFileSync(index), oldIndex);
  assert.deepEqual(readFileSync(profile), oldProfile);
  const status = await f.run("project-status");
  assert.match(status, /Index: published/);
  assert.match(status, /Last index build: not completed/);
  assert.equal(core.getStatus(f.cwd, f.agent).manifest.id, before.manifest.id);
});

test("root ignore prunes directories and files before touching their contents or attributes", async t => {
  const f = fixture(t);
  const ignored = join(f.cwd, "Library");
  const temporary = join(f.cwd, "src", "old.tmp");
  mkdirSync(ignored);
  writeFileSync(join(ignored, "generated.ts"), "excluded");
  writeFileSync(temporary, "still readable");
  writeFileSync(join(f.cwd, "src", "keep.tmp"), "included again");
  writeFileSync(join(f.cwd, "src", ".spignore"), "main.ts\n");
  writeFileSync(join(f.cwd, "package.json"), '{"scripts":{"test":"ignored"}}');
  writeFileSync(join(f.cwd, ".env"), "placeholder");
  writeFileSync(join(f.cwd, ".spignore"), "# comment\n/Library/\n!Library/generated.ts\n*.tmp\n!src/keep.tmp\n/package.json\n!.env\n");
  core.initializeProject(f.cwd);
  const opendir = fs.opendirSync;
  const stat = fs.lstatSync;
  t.mock.method(fs, "opendirSync", function checkDirectory(...args: Parameters<typeof opendir>) {
    assert.notEqual(args[0], ignored);
    return Reflect.apply(opendir, fs, args);
  });
  t.mock.method(fs, "lstatSync", function checkFile(...args: Parameters<typeof stat>) {
    assert.notEqual(args[0], temporary);
    return Reflect.apply(stat, fs, args);
  });
  syncBuiltinESMExports();
  try { core.refreshProject(f.cwd); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(temporary, "utf8"), "still readable");
  const index = readFileSync(join(f.cwd, ".sp", "project-index.jsonl"), "utf8");
  assert.match(index, /src\/keep\.tmp/);
  assert.match(index, /src\/main\.ts/);
  assert.doesNotMatch(index, /Library\/|old\.tmp|package\.json|\.env"/);
  assert.doesNotMatch(readFileSync(join(f.cwd, ".sp", "project-context.md"), "utf8"), /npm run test/);
});

test("an indexed uppercase alias cannot provide hints from an excluded package.json", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "package.json"), '{"scripts":{"test":"excluded"}}');
  writeFileSync(join(f.cwd, "PACKAGE.JSON"), '{}');
  writeFileSync(join(f.cwd, ".spignore"), "/package.json\n");
  await f.run("project-init");
  const index = readFileSync(join(f.cwd, ".sp", "project-index.jsonl"), "utf8");
  assert.match(index, /"path":"PACKAGE\.JSON"/);
  assert.doesNotMatch(index, /"path":"package\.json"/);
  assert.doesNotMatch(readFileSync(join(f.cwd, ".sp", "project-context.md"), "utf8"), /npm run test/);
});

test("status reads neither the workspace listing nor published artifact bodies", async t => {
  const f = fixture(t);
  await f.run("project-init");
  const read = fs.readFileSync;
  t.mock.method(fs, "readdirSync", function unexpectedScan() { assert.fail("status enumerated a directory"); });
  t.mock.method(fs, "opendirSync", function unexpectedWalk() { assert.fail("status opened a directory"); });
  t.mock.method(fs, "readFileSync", function checkArtifact(...args: Parameters<typeof read>) {
    assert.notEqual(args[0], join(f.cwd, ".sp", "project-index.jsonl"));
    assert.notEqual(args[0], join(f.cwd, ".sp", "project-context.md"));
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  try { assert.match(await f.run("project-status"), /Index: published/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

const largeIndexFiles = process.env.SP_TEST_PROJECT_INDEX_STRESS === "1" ? 50_001 : 2_051;

test(`indexes ${largeIndexFiles} included files with bounded sorting and no retained scratch`, t => {
  const f = fixture(t);
  const project = core.initializeProject(f.cwd);
  for (let i = 0; i < largeIndexFiles - 2; i++) writeFileSync(join(f.cwd, `item-${String(i).padStart(5, "0")}.ts`), "");
  for (let i = 0; i < 260; i++) mkdirSync(join(f.cwd, "src", `empty-${i}`));
  const first = core.refreshProject(f.cwd, project);
  const directory = join(f.cwd, ".sp");
  const index = join(directory, "project-index.jsonl");
  const profile = join(directory, "project-context.md");
  const indexBytes = readFileSync(index);
  assert.equal(first.fileCount, largeIndexFiles);
  assert.equal(first.diagnostics.peakRecords, 2048);
  assert.equal(first.diagnostics.initialRuns, Math.ceil(largeIndexFiles / 2048));
  assert.equal(first.diagnostics.peakReaders, Math.min(8, first.diagnostics.initialRuns));
  assert.equal(first.diagnostics.peakDirectories, 256);
  assert.ok(first.diagnostics.directorySpills > 0);
  assert.equal(indexBytes.toString("utf8").split("\n").length, largeIndexFiles + 1);
  const digest = createHash("sha256").update(indexBytes.subarray(0, -1)).digest("hex");
  assert.ok(readFileSync(profile, "utf8").includes(digest));
  const unchanged = core.refreshProject(f.cwd, project);
  assert.equal(unchanged.profileChanged, false);
  assert.equal(unchanged.indexChanged, false);
  assert.deepEqual(readFileSync(index), indexBytes);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["project-context.json", "project-context.md", "project-index.jsonl"]);
});

test("cancel and a second-artifact publication fault preserve both previous files", t => {
  const f = fixture(t);
  const project = core.initializeProject(f.cwd);
  core.refreshProject(f.cwd, project);
  const directory = join(f.cwd, ".sp");
  const index = join(directory, "project-index.jsonl");
  const profile = join(directory, "project-context.md");
  const oldIndex = readFileSync(index);
  const oldProfile = readFileSync(profile);
  writeFileSync(join(f.cwd, "new.ts"), "export {};\n");
  let cancelled = false;
  const control = {
    check() { if (cancelled) throw new DOMException("Index build cancelled", "AbortError"); },
    progress(stage: bigint) { if (stage === INDEX_STAGE.publish) cancelled = true; },
  };
  assert.throws(() => core.refreshProject(f.cwd, project, { control }), { name: "AbortError" });
  assert.deepEqual(readFileSync(index), oldIndex);
  assert.deepEqual(readFileSync(profile), oldProfile);
  const operations = { renameSync(from: string, to: string) {
    if (basename(to) === "project-index.jsonl" && from.endsWith(".tmp")) throw new Error("fixture publication failure");
    fs.renameSync(from, to);
  } };
  assert.throws(() => core.refreshProject(f.cwd, project, { operations }), /fixture publication failure/);
  assert.deepEqual(readFileSync(index), oldIndex);
  assert.deepEqual(readFileSync(profile), oldProfile);
  assert.equal(core.getIndexState(f.cwd), "published");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["project-context.json", "project-context.md", "project-index.jsonl"]);
  assert.equal(core.refreshProject(f.cwd, project).indexChanged, true);
});

test("an aborted Worker settles after cleanup and leaves published files available", async t => {
  const f = fixture(t);
  const project = core.initializeProject(f.cwd);
  core.refreshProject(f.cwd, project);
  writeFileSync(join(f.cwd, "new.ts"), "export {};\n");
  const directory = join(f.cwd, ".sp");
  const index = join(directory, "project-index.jsonl");
  const old = readFileSync(index);
  const controller = new AbortController();
  const result = runIndexTask(f.cwd, project, { hasUI: false, signal: controller.signal, ui: {} });
  controller.abort();
  assert.deepEqual(await result, { ok: false, cancelled: true, message: "Index build cancelled" });
  assert.deepEqual(readFileSync(index), old);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["project-context.json", "project-context.md", "project-index.jsonl"]);
  assert.equal(core.refreshProject(f.cwd, project).indexChanged, true);
});

test("dismissing the interactive loader waits for cancellation and cleanup", async t => {
  initTheme("dark");
  const f = fixture(t);
  const project = core.initializeProject(f.cwd);
  core.refreshProject(f.cwd, project);
  writeFileSync(join(f.cwd, "new.ts"), "export {};\n");
  const directory = join(f.cwd, ".sp");
  const published = readFileSync(join(directory, "project-index.jsonl"));
  const outcome = await runIndexTask(f.cwd, project, { hasUI: true, ui: {
    async custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { dispose(): void }) {
      const loader = factory({ requestRender() {} }, { fg(_color: string, text: string) { return text; } }, undefined, () => {});
      loader.dispose();
      return undefined;
    },
  } });
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(readFileSync(join(directory, "project-index.jsonl")), published);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["project-context.json", "project-context.md", "project-index.jsonl"]);
});

test("committed recovery completes cleanup when one prior backup is already gone", t => {
  const f = fixture(t);
  const project = core.initializeProject(f.cwd);
  core.refreshProject(f.cwd, project);
  const directory = join(f.cwd, ".sp");
  const entries = ["project-context.md", "project-index.jsonl"].map(target => ({
    target, staged: `${target}.fixture.tmp`, backup: `${target}.fixture.backup`, hadPrevious: true,
  }));
  const published = entries.map(entry => readFileSync(join(directory, entry.target)));
  writeFileSync(join(directory, entries[1]!.backup), "old index\n");
  writeFileSync(join(directory, ".project-context-transaction.json"), JSON.stringify({ version: 2, entries }));
  writeFileSync(join(directory, ".project-context-transaction-committed"), "");
  assert.equal(core.recoverProjectTransaction(f.cwd), true);
  for (let i = 0; i < entries.length; i++) assert.deepEqual(readFileSync(join(directory, entries[i]!.target)), published[i]);
  assert.equal(core.getIndexState(f.cwd), "published");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["project-context.json", "project-context.md", "project-index.jsonl"]);
});

test("retired graph aliases no longer filter generic tool discovery", async () => {
  for (const query of ["graph", "codegraph", "impact", "callers", "callees", "图谱", "影响分析", "调用关系"]) {
    const name = query === "codegraph" ? query : `${query}_fixture`;
    const f = searchFixture([{ name, description: "Registered independent tool." }]);
    const result = await f.search(query);
    assert.deepEqual(result.details.added, [name], query);
    assert.equal(result.details.matches[0].category, "other", query);
  }
});

test("retired graph parameter errors use generic classification and retained failures stay specific", () => {
  for (const name of ["query", "symbol", "file", "files", "action"]) {
    assert.deepEqual(classifyError("codegraph", `${name} is required.`), classifyError("unregistered", `${name} is required.`));
  }
  assert.equal(classifyError("read", "ENOENT: no such file or directory").category, "path_not_found");
  assert.equal(classifyError("edit", "oldText must be unique").category, "old_text_non_unique");
  assert.equal(classifyError("lsp_navigate", "requested path resolves outside workspace root").category, "workspace_escape");
});

test("retained project notifications still sanitize terminal control sequences", () => {
  assert.equal(extension.sanitizeUiText("\u001b]0;hidden\u0007safe\u001b[31m text\u0000"), "safe text");
});
