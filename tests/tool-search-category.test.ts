import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import toolClassification from "../packages/tool-classification/src/index.ts";
import { searchFixture } from "./helpers/tool-search-fixture.ts";
import { body, sessionFixture } from "./codemode-recovery/fixture.ts";

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

test("production activation changes the request prefix once; an exhausted category does not cause another change", async t => {
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
  const after = prefix(); assert.ok(after !== before, "a legitimate catalog activation changes provider input");
  const next = (await f.run('await show((await tools.tool_search({query:"memory action add replace remove",limit:1})).ref);')).result;
  assert.equal(next.isError, false, body(next.content));
  assert.doesNotMatch(body(next.content), /Activated conditional tools: browser_exec/);
  assert.equal(prefix(), after, "no unrelated activation or avoidable prompt-prefix change");
});
