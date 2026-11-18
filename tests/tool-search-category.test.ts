import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import toolClassification from "../packages/tool-classification/src/index.ts";
import { searchFixture } from "./helpers/tool-search-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";

test("exact active tool discovery reports the current name without activating description matches", async () => {
  const f = searchFixture([
    { name: "known_tool", description: "Current tool" },
    { name: "browser_exec", description: "known_tool helper" },
  ]);
  f.setActive(["tool_search", "known_tool"]);
  const result = await f.search("known_tool");
  assert.deepEqual(result.details.alreadyActive, ["known_tool"]);
  assert.deepEqual(result.details.added, []);
  assert.match(body(result.content), /describeTools.*callTool/);
  assert.equal(f.counters.activationCalls, 0);
  assert.equal(f.counters.catalogReads, 1);
});

test("explicit exact lookup never activates description matches and observes catalog replacement", async () => {
  const f = searchFixture([{ name: "current_command", description: "old command helper" }]);
  const missing = await f.search("old_command", 6, true);
  assert.deepEqual(missing.details.added, []);
  assert.match(body(missing.content), /Do not repeat.*catalog changes/);
  assert.equal(f.counters.activationCalls, 0);
  f.setCatalog([{ name: "old_command", description: "Current registered contract" }, { name: "current_command", description: "old command helper" }]);
  assert.deepEqual((await f.search("old_command", 6, true)).details.added, ["old_command"]);
  assert.deepEqual((await f.search("old_command", 6, true)).details.alreadyActive, ["old_command"]);
  assert.equal(f.counters.activationCalls, 1);
  f.setActive(["tool_search"]);
  f.setAllowed(() => false);
  const rejected = await f.search("old_command", 6, true);
  assert.deepEqual(rejected.details.added, []);
  assert.deepEqual(rejected.details.rejected, ["old_command"]);
});

test("exact lookup preserves availability, policy-owned controls and browser approval routing", async () => {
  const f = searchFixture([
    { name: "hidden", description: "Current unavailable contract", available: false },
    { name: "goal_complete", description: "Direct control" },
    { name: "chrome_devtools_list_pages", description: "Current browser debug contract" },
    { name: "case_Sensitive", description: "Current exact spelling" },
  ]);
  for (const name of ["hidden", "goal_complete", "case_sensitive"]) assert.deepEqual((await f.search(name, 6, true)).details.added, []);
  assert.deepEqual((await f.search("case_Sensitive", 6, true)).details.added, ["case_Sensitive"]);
  f.emit("tool_execution_end", { toolName: "browser_exec", isError: true,
    result: { content: [{ type: "text", text: "[BROWSER_EXEC_PERMISSION_REQUIRED] fixture" }] } });
  assert.equal((await f.search("chrome_devtools_list_pages", 6, true)).details.blocked, "browser_approval");
  assert.equal(f.counters.activationCalls, 1);
});

test("category-prefixed searches cannot activate unrelated verb matches when the category is already active", async () => {
  const f = searchFixture([
    { name: "memory_search", description: "Find stored knowledge" },
    { name: "browser_exec", description: "action add replace remove web content" },
  ]);
  assert.deepEqual((await f.search("memory", 1)).details.added, ["memory_search"]);
  assert.deepEqual((await f.search("memory action add replace remove", 1)).details.added, []);
  assert.equal(f.counters.activationCalls, 1);
  f.setActive(["tool_search"]);
  assert.deepEqual((await f.search("memory: action add", 1)).details.added, ["memory_search"]);
});

test("browser debugging phrases retain precedence over a shorter browser category prefix", async () => {
  const f = searchFixture([
    { name: "browser_exec", description: "DOM inspection" },
    { name: "chrome_devtools_evaluate", description: "inspect DOM and JavaScript" },
  ]);
  assert.deepEqual((await f.search("browser DOM inspection", 1)).details.added, ["chrome_devtools_evaluate"]);
});

test("configured keyword search activates SearXNG while browser discovery stays independent", async () => {
  const f = searchFixture([
    { name: "web_search", description: "Public web search through SearXNG" },
    { name: "browser_exec", description: "Browser automation" },
    { name: "chrome_devtools_evaluate", description: "inspect DOM and JavaScript" },
  ]);
  assert.deepEqual((await f.search("web search")).details.added, ["web_search"]);
  assert.deepEqual((await f.search("网页搜索")).details.alreadyActive, ["web_search"]);
  assert.deepEqual((await f.search("browser")).details.added, ["browser_exec"]);
});

test("debug words do not override non-browser categories or borrow the browser approval pause", async () => {
  for (const [category, name] of [["memory", "memory_search"], ["delegation", "subagent"], ["skills", "skill_manage"], ["mcp", "mcp_search_tools"], ["navigation", "lsp_navigate"]]) {
    const f = searchFixture([
      { name, description: "category fixture" },
      { name: "chrome_devtools_evaluate", description: "devtools settings" },
    ]);
    f.setActive(["tool_search", name]);
    assert.deepEqual((await f.search(`${category}: recall devtools settings`, 1)).details.added, []);
    f.setActive(["tool_search"]);
    f.emit("tool_execution_end", { toolName: "browser_exec", isError: true,
      result: { content: [{ type: "text", text: "[BROWSER_EXEC_PERMISSION_REQUIRED] Chrome approval pending" }] } });
    const selected = await f.search(`${category}: devtools settings`, 1);
    assert.equal(selected.details.blocked, undefined);
    assert.deepEqual(selected.details.added, [name]);
  }
});

test("production activation and exhausted-category discovery preserve the fixed entry prefix", async t => {
  const custom = (name: string, description: string) => ({ name, label: name, description, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) });
  const f = await sessionFixture(t, { g2: false, extensions: [toolClassification], customTools: [
    custom("memory_search", "Find stored knowledge"), custom("browser_exec", "action add replace remove web content"),
  ] });
  // First request establishes the extension's initial tool pack through the real host.
  await f.run('text("baseline");');
  f.session.setActiveToolsByName(["codemode", "tool_search"]);
  const prefix = () => f.session.agent.state.systemPrompt + "\n" + f.session.agent.state.tools.find(tool => tool.name === "codemode")!.description;
  const before = prefix();
  const activated = (await f.run('await show((await tools.tool_search({query:"memory",limit:1})).ref);')).result;
  assert.equal(activated.isError, false, body(activated.content));
  assert.match(body(activated.content), /Activated conditional tools: memory_search/);
  const after = prefix(); assert.equal(after, before, "catalog activation must not expand the fixed provider entry");
  const next = (await f.run('await show((await tools.tool_search({query:"memory action add replace remove",limit:1})).ref);')).result;
  assert.equal(next.isError, false, body(next.content));
  assert.doesNotMatch(body(next.content), /Activated conditional tools: browser_exec/);
  assert.equal(prefix(), after, "no unrelated activation or avoidable prompt-prefix change");
});

test("reloaded session history cannot restore a removed tool contract or repeat its discovery", async t => {
  let legacy = true, calls = 0, reads = 0;
  const f = await sessionFixture(t, { g2: false, customTools: [{ name: "read", label: "Read", description: "Current fixture read",
    parameters: Type.Object({ path: Type.String() }), execute: async () => { reads++; return { content: [{ type: "text", text: "current fixture body" }], details: {} }; } }], extensions: [toolClassification, (pi: ExtensionAPI) => {
    if (legacy) pi.registerTool({ name: "structured_readonly_command", label: "Legacy fixture", description: "Historical fixture contract",
      parameters: Type.Object({}), execute: async () => { calls++; return { content: [{ type: "text", text: "historical fixture result" }], details: {} }; } });
  }] });
  f.session.setActiveToolsByName(["codemode", "tool_search", "structured_readonly_command"]);
  const earlier = await f.run('await show((await tools.structured_readonly_command({})).ref);');
  assert.equal(earlier.result.isError, false, body(earlier.result.content));
  assert.equal(calls, 1);
  legacy = false;
  await f.session.reload();
  assert.equal(f.session.getAllTools().some(tool => tool.name === "structured_readonly_command"), false);
  const discovered = await f.run('text(ALL_TOOLS); await show((await tools.tool_search({query:"structured_readonly_command",exact:true})).ref);');
  assert.equal(discovered.result.isError, false, body(discovered.result.content));
  assert.match(body(discovered.result.content), /No inactive tools matched/);
  assert.match(body(discovered.result.content), /Do not repeat.*catalog changes/);
  assert.match(JSON.stringify(discovered.requests[0]), /historical fixture result/, "original history must remain available");
  const prefix = f.session.agent.state.systemPrompt + "\n" + f.session.agent.state.tools.find(tool => tool.name === "codemode")!.description;
  assert.doesNotMatch(prefix, /structured_readonly_command/);
  const recovered = await f.run('text(await describeTools(["structured_readonly_command"])); const b=await batch([{tool:"read",args:{path:"current.txt"}},{tool:"read",args:{path:"current.txt"}}]);text(b.summary);');
  assert.equal(recovered.result.isError, false, body(recovered.result.content));
  assert.match(body(recovered.result.content), /TOOL_UNAVAILABLE.*(?:lookup|search) once/);
  assert.match(body(recovered.result.content), /"completed":2,"failed":0/);
  assert.equal(f.session.agent.state.systemPrompt + "\n" + f.session.agent.state.tools.find(tool => tool.name === "codemode")!.description, prefix);
  assert.equal(calls, 1, "historical calls must never be replayed");
  assert.equal(reads, 2);
});
