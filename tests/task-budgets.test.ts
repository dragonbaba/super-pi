import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskBudgetLedger, parseTaskBudgets, parseTaskBudgetCommand, emptyBudgetUsage, BUDGET_ENTRY } from "../packages/extensions/subagent/budgets.ts";
import { alphaModelRuntime, alphaSession } from "./helpers/alpha-session.ts";
import { alphaMessage, finalStream } from "./helpers/alpha-stream.ts";

const reported = { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, cost: { total: 0.25 } };
function fixture(limits = "{}", restored: any[] = []) {
	const entries = restored;
	const ledger = new TaskBudgetLedger(parseTaskBudgets(limits), { appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } } as any);
	const ctx: any = { sessionManager: { getSessionId: () => "parent", getEntries: () => entries } };
	ledger.configure(ctx); return { ledger, entries, ctx };
}
test("budget defaults are unlimited; invalid keys, numbers and oversized configuration are rejected", () => {
	assert.deepEqual(parseTaskBudgets("{}"), { sessionTurns: 0, sessionTokens: 0, childTurns: 0, childTokens: 0 });
	for (const input of ["null", "[]", '{"sessionTurns":-1}', '{"childTurns":1.5}', '{"childTokens":1000000001}', '{"unknown":2}', " ".repeat(4097)]) assert.throws(() => parseTaskBudgets(input));
});
test("budget commands bound input and reject ambiguous or invalid partial changes", () => {
	assert.deepEqual(parseTaskBudgetCommand(""), { action: "status" });
	assert.deepEqual(parseTaskBudgetCommand("help"), { action: "help" });
	assert.deepEqual(parseTaskBudgetCommand(" reset "), { action: "reset" });
	assert.deepEqual(parseTaskBudgetCommand("set childTurns 20 childTokens 100000"), { action: "set", changes: { childTurns: 20, childTokens: 100000 } });
	assert.deepEqual(parseTaskBudgetCommand("set sessionTurns 0"), { action: "set", changes: { sessionTurns: 0 } });
	for (const input of ["set", "set childTurns", "set childTurns 1 childTurns 2", "set unknown 1", "set __proto__ 1", "set childTurns -1", "set childTurns 1.5", "set childTokens 1e5", "set childTokens 1000000001", "set childTurns 1000001", "set childTurns 1 extra", " ".repeat(513)]) assert.throws(() => parseTaskBudgetCommand(input));
});
test("budget settings preserve usage, merge saved fields and keep runtime unchanged after write failure", t => {
	const root = mkdtempSync(join(tmpdir(), "sp-budget-settings-")), file = join(root, "task-budgets.json");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { ledger, entries } = fixture();
	ledger.request(); ledger.settle(reported);
	writeFileSync(file, '{"sessionTokens":90}');
	ledger.setLimits({ sessionTurns: 1, childTurns: 20 }, file);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sessionTurns: 1, sessionTokens: 90, childTurns: 20, childTokens: 0 });
	assert.equal(ledger.usage.tokens, 10); assert.equal(entries.length, 2);
	assert.throws(() => ledger.request(), /1\/1/);
	ledger.setLimits({ sessionTurns: 0 }, file); ledger.request();
	const saved = readFileSync(file, "utf8"), limits = ledger.limits;
	assert.throws(() => ledger.setLimits({ childTokens: 10 }, file), /Stop all/);
	assert.equal(readFileSync(file, "utf8"), saved);
	ledger.settle(reported);
	// Fail after the temp file is written, before the old config is replaced.
	const fs = createRequire(import.meta.url)("node:fs");
	t.mock.method(fs, "renameSync", () => { throw new Error("fixture replace denied"); }); syncBuiltinESMExports();
	try { assert.throws(() => ledger.setLimits({ childTokens: 10 }, file), /fixture replace denied/); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.equal(readFileSync(file, "utf8"), saved);
	assert.equal(ledger.limits, limits); assert.equal(ledger.usage.turns, 2);
	writeFileSync(file, "corrupt"); assert.throws(() => ledger.setLimits({ childTurns: 3 }, file));
	assert.equal(readFileSync(file, "utf8"), "corrupt"); assert.equal(ledger.limits, limits);
	assert.deepEqual(readdirSync(root), ["task-budgets.json"], "no abandoned configuration temporaries");
});
test("parent and concurrent children share atomic reservations; usage settles once and overshoot blocks the next request", () => {
	const { ledger, entries } = fixture('{"sessionTurns":3,"sessionTokens":15,"childTurns":1}');
	const a = emptyBudgetUsage(), b = emptyBudgetUsage();
	ledger.request(); ledger.request(a); ledger.request(b);
	assert.throws(() => ledger.request(emptyBudgetUsage()), /3\/3/);
	ledger.settle(reported); ledger.settle(reported, a); ledger.settle(reported, b); ledger.settle(reported, b);
	assert.deepEqual(ledger.usage, { turns: 3, tokens: 30, cost: 0.75, pending: 0, unknown: false });
	assert.equal(entries.length, 6, "one reservation and one settlement write per request");
	const token = fixture('{"sessionTokens":5}').ledger; token.request(); token.settle(reported);
	assert.throws(() => token.request(), /10\/5/);
});
test("restored aggregate is not double charged; interrupted usage fails closed only for configured token limits", () => {
	const a = fixture('{"sessionTokens":100}'); a.ledger.request();
	const b = fixture('{"sessionTokens":100}', [...a.entries]);
	assert.equal(b.ledger.usage.turns, 1); assert.equal(b.ledger.usage.pending, 0); assert.equal(b.ledger.usage.unknown, true);
	assert.throws(() => b.ledger.request(), /usage is incomplete/);
	b.ledger.reset(); b.ledger.request(); b.ledger.settle(reported); assert.equal(b.ledger.usage.tokens, 10);
	const c = fixture(); c.ledger.request(); assert.throws(() => c.ledger.reset(), /Stop all/);
	c.ledger.settle(undefined); c.ledger.request(); c.ledger.settle(undefined); assert.equal(c.ledger.usage.turns, 2);
});
test("corrupt ledger and failed persistence deny provider dispatch", () => {
	const broken = fixture("{}", [{ type: "custom", customType: BUDGET_ENTRY, data: { turns: -1 } }]);
	assert.throws(() => broken.ledger.request(), /Invalid task budget ledger/);
	const ledger = new TaskBudgetLedger(parseTaskBudgets("{}"), { appendEntry() { throw new Error("disk unavailable"); } } as any);
	assert.throws(() => ledger.request(), /disk unavailable/); assert.throws(() => ledger.request(), /disk unavailable/);
});
test("production SDK admission blocks before the provider factory and never counts request previews", async () => {
	let calls = 0, ledger!: TaskBudgetLedger;
	const f = await alphaSession({ settings: { compaction: { enabled: false }, retry: { enabled: false } },
		runtime: alphaModelRuntime(() => { calls++; return finalStream(alphaMessage([{ type: "text", text: "done" }])); }),
		extensions: [(pi: any) => {
			ledger = new TaskBudgetLedger(parseTaskBudgets('{"sessionTurns":1}'), pi);
			pi.on("before_model_request", (_event: any, ctx: any) => { ledger.configure(ctx); ledger.request(); });
			pi.on("message_end", (event: any) => { if (event.message.role === "assistant") ledger.settle(event.message.usage); });
		}] });
	try {
		await f.mode.init(); assert.equal(calls, 0); assert.equal(ledger.usage.turns, 0);
		await f.session.buildProviderRequestPayload({ systemPrompt: "preview", messages: [] });
		assert.equal(ledger.usage.turns, 0, "request previews do not reserve turns");
		await f.session.prompt("first"); await f.session.prompt("second");
		assert.equal(calls, 1); assert.equal(ledger.usage.turns, 1);
		assert.match(JSON.stringify(f.session.messages.at(-1)), /turn budget reached: 1\/1/);
	} finally { await f.release(); }
});
