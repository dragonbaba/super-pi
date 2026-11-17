import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import { compactionEpochFixture, epochAssistant, EPOCH_MODEL } from "./helpers/compaction-epoch-fixture.ts";

for (const change of ["percentage", "model"] as const) {
	test(`materialized loop guard permits one fresh compaction after ${change} changes`, async t => {
		let attempts = 0;
		const f = await compactionEpochFixture({ extensions: [(pi: ExtensionAPI) => {
			pi.registerCompactionStrategy!({ id: "new-policy", prepare: () => event => { attempts++; return { compaction: {
				summary: "small new-policy checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, retainedTail: [],
			} }; } });
		}] });
		t.after(() => f.release()); await f.session.bindExtensions({});
		const old = epochAssistant(0, 1); old.content = [{ type: "text", text: "x".repeat(1800000) }];
		const kept = f.sessionManager.appendMessage(old);
		f.sessionManager.appendCompaction("large old-policy checkpoint", kept, 490000, { contextAccounting: { schemaVersion: 1,
			owner: { provider: EPOCH_MODEL.provider, model: EPOCH_MODEL.id }, materializedTokensAfter: 425000, thresholdTokens: 425000 } }, true, undefined, [old]);
		if (change === "percentage") await f.session.setAutoCompactionPercentage(10);
		else f.session.agent.state.model = { ...EPOCH_MODEL, provider: "other-provider", id: "other-model", contextWindow: 128000 };
		const blocked = { ...epochAssistant(0, Date.now()), provider: f.session.model!.provider, model: f.session.model!.id, stopReason: "error" as const,
			errorMessage: "Request preparation blocked: context-headroom fixture" };
		f.sessionManager.appendMessage(blocked); f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
		await (f.session as any)._checkCompaction(blocked, false);
		assert.equal(attempts, 1);
		await (f.session as any)._checkCompaction(blocked, false);
		assert.equal(attempts, 1, "the fresh policy cannot cause an immediate repeat loop");
	});
}
