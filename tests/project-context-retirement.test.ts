import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { searchFixture } from "./helpers/tool-search-fixture.ts";
import { classifyError } from "../packages/extensions/tool-loop-guardrails/failure-classification.ts";

const extension = await import(new URL("../packages/project-context/src/index.js", import.meta.url).href);
const core = await import(new URL("../packages/project-context/src/core.js", import.meta.url).href);

interface Command {
  description: string;
  handler(args: string, context: unknown): Promise<void>;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sp-project-context-retirement-"));
  const cwd = join(root, "project"), agent = join(root, "agent");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".codegraph"));
  mkdirSync(agent);
  execFileSync("git", ["init", "--quiet", cwd], { stdio: "pipe", windowsHide: true });
  const agents = Buffer.from("# User rules\r\n\r\nKeep these bytes.  \r\n");
  const indexBytes = Buffer.from("retained user index\n");
  writeFileSync(join(cwd, "AGENTS.md"), agents);
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
  async function run(name: string) {
    const command = commands.get(name);
    assert.ok(command, `missing retained command: ${name}`);
    const before = notices.length;
    await command.handler("", context);
    assert.equal(notices.length, before + 1);
    const notice = notices.at(-1)!;
    assert.equal(notice.level, "info", notice.text);
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
  const memory = join(core.detectHermes(f.cwd, f.cwd, f.agent).memoryDir, "MEMORY.md");
  const memoryBytes = Buffer.from("Keep saved memory.  \r\n");
  writeFileSync(memory, memoryBytes);
  await f.run("project-init");
  assert.deepEqual(readFileSync(join(f.cwd, "AGENTS.md")), f.agents);
  assert.deepEqual(readFileSync(memory), memoryBytes);
  assert.deepEqual(readFileSync(join(f.cwd, ".codegraph", "codegraph.db")), f.indexBytes);
  const index = readFileSync(join(f.cwd, ".sp", "project-index.jsonl"), "utf8");
  assert.match(index, /src\/main\.ts/);
  assert.doesNotMatch(index, /codegraph/i);
  assert.doesNotMatch(readFileSync(join(f.cwd, ".sp", "project-context.md"), "utf8"), /codegraph/i);
  assert.match(await f.run("project-status"), /files \(fresh\)/);
  writeFileSync(join(f.cwd, "src", "next.ts"), "export const next = true;\n");
  assert.match(await f.run("project-status"), /files \(stale\)/);
  assert.doesNotMatch(await f.run("project-refresh"), /codegraph/i);
  assert.match(await f.run("project-status"), /files \(fresh\)/);
  assert.deepEqual(readFileSync(memory), memoryBytes);
  assert.deepEqual(readFileSync(join(f.cwd, ".codegraph", "codegraph.db")), f.indexBytes);
});

test("legacy graph recommendations become stale until an explicit refresh", async t => {
  const f = fixture(t);
  await f.run("project-init");
  const profile = join(f.cwd, ".sp", "project-context.md");
  const legacy = readFileSync(profile, "utf8")
    + "\n## Deep Index Recommendation\n\n- CodeGraph may be useful: initialize only after explicit approval.\n";
  writeFileSync(profile, legacy);
  assert.equal(core.getStatus(f.cwd, f.agent).indexFresh, false);
  assert.equal(readFileSync(profile, "utf8"), legacy, "status must not rewrite the legacy profile");
  assert.match(await f.run("project-status"), /files \(stale\)/);
  assert.match(await f.run("project-refresh"), /context refreshed:/);
  assert.equal(core.getStatus(f.cwd, f.agent).indexFresh, true);
  assert.doesNotMatch(readFileSync(profile, "utf8"), /codegraph/i);
  assert.match(await f.run("project-refresh"), /already current/);
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
