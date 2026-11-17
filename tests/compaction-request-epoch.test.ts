import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateContextTokens, withHistoricalContextUsage } from "../packages/ai/src/utils/estimate.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { convertToLlm, convertToLlmWithUsageEpoch } from "../packages/coding-agent/src/core/messages.ts";
import { compactionEpochFixture, epochAssistant } from "./helpers/compaction-epoch-fixture.ts";

for (const legacy of [false, true]) {
	test(`request estimation ignores retained future-clock usage, legacy=${legacy}`, () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "original task", timestamp: 0 });
		const old = epochAssistant(512307, Date.now() + 3600000), raw = JSON.stringify(old);
		const kept = manager.appendMessage(old);
		manager.appendCompaction("new summary", kept, 512568, {}, true, undefined, legacy ? undefined : [old]);
		const context = manager.buildSessionContext().messages;
		const retained = context.find(message => message.role === "assistant")!;
		assert.notEqual(retained, old);
		assert.equal(JSON.stringify(retained), raw, "metadata cannot alter content, reasoning, billing or JSON wire shape");
		assert.equal(JSON.stringify(old), raw, "the archived response remains unchanged");
		assert.equal((retained as any).usage, old.usage);
		assert.equal(withHistoricalContextUsage(retained as any), retained, "marking an owned view is idempotent");
		const estimate = estimateContextTokens({ messages: convertToLlm(context) });
		assert.equal(estimate.lastUsageIndex, null);
		assert.ok(estimate.tokens < 1000);
		const current = epochAssistant(1024, Date.now() + 3600001); manager.appendMessage(current);
		assert.equal(estimateContextTokens({ messages: convertToLlm(manager.buildSessionContext().messages) }).tokens, 1024);
	});
}

test("JSON-copying context hooks cannot revive usage from a prior compaction epoch", async t => {
	const f = await compactionEpochFixture(); t.after(() => f.release());
	const copied = JSON.parse(JSON.stringify(f.session.messages));
	const raw = JSON.stringify(copied);
	const projected = convertToLlmWithUsageEpoch(copied, f.session.getRequestUsageEpoch(copied));
	assert.equal(JSON.stringify(projected), JSON.stringify(convertToLlm(JSON.parse(raw))));
	assert.equal(estimateContextTokens({ messages: projected }).lastUsageIndex, null);
	const current = epochAssistant(1024, Date.now() + 3600000);
	f.sessionManager.appendMessage(current); f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	assert.equal(estimateContextTokens({ messages: convertToLlmWithUsageEpoch(f.session.messages, f.session.getRequestUsageEpoch(f.session.messages)) }).tokens, 1024);
	assert.equal(f.session.getContextUsage()!.tokens, 1024);
});

test("later copied or foreign usage cannot override the exact committed response", async t => {
	const f = await compactionEpochFixture(); t.after(() => f.release());
	const current = epochAssistant(1024, Date.now() + 3600000);
	f.sessionManager.appendMessage(current); f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	const copied = epochAssistant(512307, current.timestamp + 1);
	const raw = [...f.session.messages, copied];
	const projected = convertToLlmWithUsageEpoch(raw, f.session.getRequestUsageEpoch(raw));
	const estimate = estimateContextTokens({ messages: projected });
	assert.equal(estimate.usageTokens, 1024);
	assert.ok(estimate.tokens < 2000);
	assert.equal(JSON.stringify(projected), JSON.stringify(convertToLlm(raw)));
});

test("verified current usage survives historical future clocks but not a replaced canonical prefix", async t => {
	const f = await compactionEpochFixture(); t.after(() => f.release());
	const old = epochAssistant(512307, Date.now() + 3600000), kept = f.sessionManager.appendMessage(old);
	f.sessionManager.appendCompaction("clock-skew checkpoint", kept, 512307, {}, true, undefined, [old]);
	const current = epochAssistant(400000, 1000); f.sessionManager.appendMessage(current);
	f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	const raw = f.session.messages, projected = convertToLlmWithUsageEpoch(raw, f.session.getRequestUsageEpoch(raw));
	assert.equal(estimateContextTokens({ messages: projected }).usageTokens, 400000);
	const replaced = [{ role: "user" as const, content: "A fresh inserted instruction.", timestamp: Date.now() + 7200000 }, ...raw];
	assert.equal(f.session.getRequestUsageEpoch(replaced), null);
	assert.equal(estimateContextTokens({ messages: convertToLlmWithUsageEpoch(replaced, f.session.getRequestUsageEpoch(replaced)) }).lastUsageIndex, null);
});
