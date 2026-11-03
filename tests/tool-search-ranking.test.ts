import assert from "node:assert/strict";
import test from "node:test";
import { searchFixture } from "./helpers/tool-search-fixture.ts";

for (const [query, description] of [["café", "cafe\u0301 menu"], ["cafe\u0301", "café menu"]]) test(`canonical Unicode equivalence: ${JSON.stringify(query)}`, async () => {
	const f = searchFixture([{ name: "z_menu", description }]);
	assert.deepEqual((await f.search(query)).details.added, ["z_menu"]);
});
for (const [query, description] of [["搜索数据库", "搜索 SQL 数据库中的记录"], ["検索ファイル", "ファイルを検索する"]]) test(`word boundaries without spaces: ${query}`, async () => {
	const f = searchFixture([{ name: "z_search", description }]);
	assert.deepEqual((await f.search(query)).details.added, ["z_search"]);
});
test("name matches break equal coverage ties; full coverage outranks a partial name", async () => {
	const f = searchFixture([
		{ name: "a_misc", description: "export a report" },
		{ name: "z_report_export", description: "produce output" },
		{ name: "a_report", description: "show results" },
	]);
	assert.deepEqual((await f.search("report export")).details.added, ["z_report_export", "a_misc", "a_report"]);
});
test("duplicate words cannot overweight partial coverage", async () => {
	const tools = [{ name: "a_export", description: "exports data" }, { name: "z_all", description: "export report archive" }];
	const f = searchFixture(tools);
	const first = await f.search("export report archive"); f.setActive(["tool_search"]);
	const second = await f.search("export export export report archive");
	assert.deepEqual(second.details.matches, first.details.matches);
	assert.equal(second.details.added[0], "z_all");
});
test("exact complete tool name dominates; ties remain deterministic", async () => {
	const f = searchFixture([{ name: "z_exact_name", description: "" }, { name: "a_other", description: "z exact name" }, { name: "b_other", description: "z exact name" }]);
	assert.deepEqual((await f.search("  Z_EXACT_NAME  ")).details.added, ["z_exact_name", "a_other", "b_other"]);
});
test("Unicode marks without a precomposed form stay part of the term", async () => {
	const f = searchFixture([{ name: "a_plain", description: "q tools" }, { name: "z_marked", description: "q\u0301 tools" }]);
	assert.deepEqual((await f.search("q\u0301")).details.added, ["z_marked"]);
});
test("catalog filters and activation rejection remain authoritative", async () => {
	const f = searchFixture([
		{ name: "hidden", description: "export", available: false }, { name: "active", description: "export" },
		{ name: "goal_complete", description: "export" }, { name: "plan_mode_question", description: "export" },
		{ name: "inspect_image", description: "export" }, { name: "allowed", description: "export" }, { name: "rejected", description: "export" },
	]);
	f.setActive(["tool_search", "active"]); f.setAllowed(name => name !== "rejected");
	const result = await f.search("export", 12);
	assert.deepEqual(result.details.matches.map((m: any) => m.name), ["allowed", "rejected"]);
	assert.deepEqual(result.details.added, ["allowed"]); assert.deepEqual(result.details.rejected, ["rejected"]);
	assert.deepEqual(f.counters, { catalogReads: 1, activationCalls: 1 });
});
test("browser routing and pending approval remain isolated", async () => {
	const f = searchFixture([{ name: "browser_exec", description: "web search" }, { name: "chrome_devtools_list_pages", description: "web search local preview" }]);
	assert.deepEqual((await f.search("web search")).details.added, ["browser_exec"]);
	f.setActive(["tool_search"]);
	assert.deepEqual((await f.search("本地页面预览")).details.added, ["chrome_devtools_list_pages"]);
	f.setActive(["tool_search"]);
	f.emit("tool_execution_end", { toolName: "browser_exec", isError: true, result: { content: [{ type: "text", text: "[BROWSER_EXEC_PERMISSION_REQUIRED] fixture" }] } });
	const before = f.counters.activationCalls;
	assert.equal((await f.search("browser_debug")).details.blocked, "browser_approval");
	assert.equal(f.counters.activationCalls, before);
});
test("each explicit search observes current catalog and an empty query cannot activate tools", async () => {
	const f = searchFixture([{ name: "one", description: "lookup" }]);
	assert.deepEqual((await f.search("lookup")).details.added, ["one"]);
	f.setCatalog([{ name: "two", description: "lookup" }]); f.setActive(["tool_search"]);
	assert.deepEqual((await f.search("lookup")).details.added, ["two"]);
	const before = f.counters.activationCalls;
	assert.deepEqual((await f.search(" --- ")).details.added, []); assert.equal(f.counters.activationCalls, before);
});
