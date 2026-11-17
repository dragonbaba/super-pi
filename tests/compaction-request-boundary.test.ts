import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import { compactionEpochFixture, epochAssistant } from "./helpers/compaction-epoch-fixture.ts";

for (const fails of [false, true]) {
	test(`threshold compaction ${fails ? "failure stops continuation" : "precedes enabled request projection with a retained tail"}`, async t => {
		let summaries = 0, effects = 0, requests = 0;
		let failing = fails;
		let previewFailure: string | undefined;
		let f!: Awaited<ReturnType<typeof compactionEpochFixture>>;
		f = await compactionEpochFixture({ g2: true, budgetTokens: 1024,
			customTools: [{ name: "probe", label: "Probe", description: "One isolated effect", parameters: Type.Object({}),
				execute: async () => { effects++; return { content: [{ type: "text", text: "completed once" }], details: {} }; } }],
			extensions: [(pi: ExtensionAPI) => { pi.registerCompactionStrategy!({ id: "boundary-fixture", prepare: () => async (event, ctx) => {
				summaries++;
				if (failing) return { cancel: true, errorMessage: "fixture native compaction failed: network timeout" };
				try { assert.ok(await f.session.buildProviderRequestPayload({ systemPrompt: ctx.getSystemPrompt(), messages: f.session.agent.state.messages, auth: event.auth })); }
				catch (error) { previewFailure = String(error); throw error; }
				return { compaction: { summary: "new boundary checkpoint", firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore, retainedTail: event.preparation.retainedTail } };
			} }); }] });
		t.after(() => f.release());
		f.session.agent.streamFunction = (_model, context) => {
			const first = requests++ === 0;
			if (!first) assert.match(JSON.stringify(context.messages), /new boundary checkpoint/);
			const message = epochAssistant(first ? 512307 : 1024, Date.now() + 1000);
			message.content = first ? [{ type: "toolCall", id: "boundary-call", name: "codemode", arguments: { code: "await tools.probe({});" } }]
				: [{ type: "text", text: "finished" }];
			message.stopReason = first ? "toolUse" : "stop";
			const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
		};
		await f.session.prompt("Run the boundary fixture.");
		assert.equal(summaries, 1);
		assert.equal(previewFailure, undefined);
		assert.equal(effects, 1, "completed effects are not replayed");
		assert.equal(requests, fails ? 1 : 2, JSON.stringify(f.session.agent.state.messages.at(-1)));
		if (fails) {
			assert.match(JSON.stringify(f.session.agent.state.messages.at(-1)), /AUTO_COMPACTION_INCOMPLETE/);
			assert.doesNotMatch(JSON.stringify(f.session.agent.state.messages.at(-1)), /context-headroom/);
			assert.match(JSON.stringify(f.session.agent.state.messages.at(-1)), /fixture native compaction failed/);
			failing = false;
			await f.session.prompt("Resume after the compaction cause is fixed.");
			assert.equal(summaries, 2);
			assert.equal(effects, 1);
			assert.equal(requests, 2);
			assert.equal(f.session.getContextUsage()!.tokens, 1024);
		} else {
			assert.equal(f.session.getContextUsage()!.tokens, 1024);
		}
	});
}

test("a failed pre-prompt compaction preserves the new user input and makes no regular request", async t => {
	let attempts = 0, requests = 0;
	const f = await compactionEpochFixture({ g2: true, extensions: [(pi: ExtensionAPI) => {
		pi.registerCompactionStrategy!({ id: "preprompt-failure", prepare: () => () => { attempts++; return { cancel: true, errorMessage: "fixture preprompt failure" }; } });
	}] });
	t.after(() => f.release());
	f.sessionManager.appendMessage(epochAssistant(512307, Date.now() + 1000));
	f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	f.session.agent.streamFunction = () => { requests++; throw new Error("regular dispatch must remain blocked"); };
	await f.session.prompt("Keep this exact user instruction after compaction fails.");
	assert.equal(attempts, 1); assert.equal(requests, 0);
	assert.ok(f.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Keep this exact user instruction")));
	assert.match(JSON.stringify(f.session.messages.at(-1)), /AUTO_COMPACTION_INCOMPLETE.*fixture preprompt failure/);
});

test("an ordinary provider preview still enforces context headroom", async t => {
	const f = await compactionEpochFixture({ g2: true }); t.after(() => f.release());
	const message = epochAssistant(512307, Date.now() + 1000);
	message.content = [{ type: "toolCall", id: "ordinary-preview", name: "codemode", arguments: { code: "text(1);" } }]; message.stopReason = "toolUse";
	f.sessionManager.appendMessage(message);
	f.sessionManager.appendMessage({ role: "toolResult", toolCallId: "ordinary-preview", toolName: "codemode", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() + 1001 });
	f.session.agent.state.messages = f.sessionManager.buildSessionContext().messages;
	await assert.rejects(f.session.buildProviderRequestPayload({ systemPrompt: f.session.agent.state.systemPrompt, messages: f.session.messages }), /context-headroom/);
});
