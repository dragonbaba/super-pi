import assert from "node:assert/strict";
import test from "node:test";
import { TaskBudgetLedger, parseTaskBudgets, emptyBudgetUsage, BUDGET_ENTRY } from "../packages/extensions/subagent/budgets.ts";
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
