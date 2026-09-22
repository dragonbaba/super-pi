import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import type { AssistantMessage, Model } from "../packages/ai/src/types.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { getUsageCostBreakdown } from "../packages/coding-agent/src/core/usage-totals.ts";

const SENTINEL = "ABANDONED_LENGTH_SENTINEL";
const model: Model<"openai-completions"> = {
	id: "offline-length", name: "Offline length", provider: "fixture", api: "openai-completions",
	baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
};
function reply(text: string, finish = "stop", output = 10): Response {
	const chunk = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id,
		choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
		usage: { prompt_tokens: 100, completion_tokens: output, total_tokens: 100 + output,
			completion_tokens_details: { reasoning_tokens: 4 } } };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}
function toolReply(): Response {
	const chunk = { id: "offline-tool", object: "chat.completion.chunk", created: 1, model: model.id,
		choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "recovery-inspect", type: "function",
			function: { name: "inspect_effect", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}
type Scenario = "success" | "summary-error" | "summary-abort" | "retry-error" | "retry-length" | "retry-abort" | "ordinary-length" | "post-entry" | "extension-tail" | "admission-error" | "admission-abort" | "retry-tool";

async function fixture(scenario: Scenario) {
	const root = mkdtempSync(join(tmpdir(), "pi087-length-"));
	const effectPath = join(root, "completed-effect.txt");
	writeFileSync(effectPath, "1"); // A completed synthetic side effect recorded in the seed history.
	const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1024, reserveTokens: 128 },
		retry: { enabled: false } });
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: scenario !== "extension-tail", extensionFactories: scenario === "extension-tail" ? [(pi: any) => {
			pi.on("session_before_compact", (event: any) => ({ compaction: {
				summary: "Extension checkpoint without a retained tail.",
				firstKeptEntryId: event.branchEntries.find((entry: any) => entry.type === "message" &&
					entry.message.role === "user" && String(entry.message.content).startsWith("old history 6 ")).id,
				tokensBefore: event.preparation.tokensBefore,
			} }));
		}] : [], noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true,
		systemPrompt: "Synthetic fixed length recovery policy." });
	await resources.reload();
	let manager: SessionManager | undefined = SessionManager.create(root, join(root, "sessions"));
	const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
		role: "assistant", api: model.api, model: model.id, provider: model.provider, stopReason,
		content: [{ type: "text", text }], timestamp: 1,
		usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
			cost: { input: 0.00002, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00003 } },
	});
	for (let i = 0; i < 8; i++) {
		manager.appendMessage({ role: "user", content: `old history ${i} ${"synthetic ".repeat(500)}`, timestamp: 1 });
		manager.appendMessage(assistant("Old answer."));
	}
	manager.appendMessage({ role: "user", content: "Already authorized synthetic effect.", timestamp: 1 });
	manager.appendMessage({ ...assistant("", "toolUse"),
		content: [{ type: "toolCall", id: "effect-1", name: "record_effect", arguments: {} }] });
	manager.appendMessage({ role: "toolResult", toolName: "record_effect", toolCallId: "effect-1",
		content: [{ type: "text", text: "EFFECT_ALREADY_COMPLETED" }], isError: false, timestamp: 1 });
	manager.appendMessage(assistant("Recorded effect acknowledged."));
	const file = manager.getSessionFile()!;
	const wires: any[] = [];
	const summaries: any[] = [];
	let inspections = 0;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const runtime = {
		hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
		getAuth: async () => undefined, isUsingOAuth: () => false, getModel: () => model,
		registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
		streamSimple: (m: any, context: any, options: any) => {
			const summary = context.systemPrompt?.includes("summar") === true;
			return streamSimple(m, context, { ...options, apiKey: "offline-fixture", maxRetries: 0,
				fetch: async (_input, init) => {
					const wire = JSON.parse(String(init?.body));
					if (summary) {
						summaries.push(wire);
						assert.ok(summaries.length <= 2, "summary requests remain bounded");
						if (scenario === "summary-error") return new Response('{"error":{"message":"synthetic summary failure"}}', { status: 400 });
						if (scenario === "summary-abort") session!.abortCompaction();
						return reply("Complete synthetic checkpoint. The recorded effect already happened.");
					}
					wires.push(wire);
					assert.ok(wires.length <= 7, "ordinary requests remain bounded");
					if (wires.length === 1) return reply(SENTINEL, "length", scenario === "ordinary-length" ? 1024 : 10);
					if (wires.length === 2) {
						if (scenario === "retry-tool") return toolReply();
						if (scenario === "retry-error") return reply("RETRY_FAILED_FRAGMENT", "network_error");
						if (scenario === "retry-length") return reply("RETRY_LENGTH_FRAGMENT", "length");
						if (scenario === "retry-abort") { void session!.abort(); return reply("RETRY_ABORTED_FRAGMENT"); }
					}
					return reply("Recovery complete.");
				} });
		},
	} as unknown as ModelRuntime;
	async function open() {
		session = (await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
			sessionManager: manager!, resourceLoader: resources, tools: ["record_effect", "inspect_effect"], customTools: [{
				name: "record_effect", label: "Effect", description: "Synthetic effect", parameters: Type.Object({}),
				execute: async () => { writeFileSync(effectPath, String(Number(readFileSync(effectPath, "utf8")) + 1));
					return { content: [{ type: "text" as const, text: "EFFECT_ALREADY_COMPLETED" }], details: {} }; },
			}, {
				name: "inspect_effect", label: "Inspect effect", description: "Read completed synthetic effect", parameters: Type.Object({}),
				execute: async () => { inspections++; return { content: [{ type: "text" as const, text: readFileSync(effectPath, "utf8") }], details: {} }; },
			}] })).session;
		if (scenario === "post-entry") {
			let appended = false;
			session.subscribe(event => {
				if (!appended && event.type === "agent_end" && wires.length === 1) {
					manager!.appendCustomEntry("late-agent-end-marker", { synthetic: true });
					appended = true;
				}
			});
		}
		if (scenario.startsWith("admission-")) session.subscribe(event => {
			if (event.type === "compaction_end" && event.result && event.willRetry) {
				if (scenario === "admission-abort") session!.abortCompaction();
				else throw new Error("synthetic critical admission failure");
			}
		}, { criticalCompactionEnd: true });
	}
	await open();
	return {
		get session() { return session!; }, get manager() { return manager!; }, get inspections() { return inspections; }, wires, summaries,
		async reopen(branch?: string) {
			session!.dispose(); session = undefined; manager = undefined;
			manager = SessionManager.open(file); // A new manager parsed from actual JSONL; no in-memory reuse.
			if (branch) manager.branch(branch);
			await open();
		},
		assertWire(wire: any, omitted: boolean) {
			assert.equal(JSON.stringify(wire).includes(SENTINEL), !omitted, "exact abandoned attempt projection");
			assert.match(JSON.stringify(wire.messages), /Synthetic fixed length recovery policy/);
			assert.ok(wire.tools.some((tool: any) => tool.function.name === "record_effect"));
			assert.ok(wire.messages.some((m: any) => m.tool_calls?.some((c: any) => c.id === "effect-1")));
			assert.ok(wire.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "effect-1" && m.content.includes("EFFECT_ALREADY_COMPLETED")));
		},
		assertDurable() {
			const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
			const abandoned = entries.find(e => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes(SENTINEL));
			assert.equal(abandoned.message.stopReason, "length");
			assert.equal(abandoned.message.usage.output, scenario === "ordinary-length" ? 1024 : 10);
			assert.equal(abandoned.message.usage.reasoning, 4);
			assert.equal(abandoned.message.usage.totalTokens, scenario === "ordinary-length" ? 1124 : 110);
			assert.ok(abandoned.message.usage.cost.total > 0);
			assert.equal(readFileSync(effectPath, "utf8"), "1", "completed effects never replay");
			return abandoned.id as string;
		},
		assertUsage() {
			const entries = manager!.getEntries();
			const assistants = entries.filter(e => e.type === "message" && e.message.role === "assistant");
			const paidSummaries = entries.filter(e => e.type === "compaction" && e.usage);
			assert.equal(paidSummaries.length, summaries.length, "each paid summary is counted once");
			const input = assistants.reduce((sum, e: any) => sum + e.message.usage.input, 0) + summaries.length * 100;
			const output = assistants.reduce((sum, e: any) => sum + e.message.usage.output, 0) + summaries.length * 10;
			const stats = session!.getSessionStats();
			assert.equal(stats.tokens.input, input);
			assert.equal(stats.tokens.output, output);
			assert.equal(stats.tokens.total, input + output, "reasoning already included in output is not added twice");
			const breakdown = getUsageCostBreakdown(entries);
			assert.equal(breakdown.reduce((sum, item) => sum + item.tokens, 0), input + output);
			assert.ok(Math.abs(stats.cost - (input / 1e6 + output * 2 / 1e6)) < 1e-10);
		},
		close() { session?.dispose(); session = undefined; manager = undefined; rmSync(root, { recursive: true, force: true }); },
	};
}

test("length → compaction → retry keeps omission across next wire, disk reopen and recovered branch/model switch", async t => {
	const f = await fixture("success");
	try {
		await f.session.prompt("Continue the synthetic task.");
		assert.equal(f.wires.length, 2); assert.equal(f.summaries.length, 1);
		f.assertUsage();
		assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 2);
		assert.equal((f.session as any)._pendingLengthRecovery, undefined);
		await t.test("A: immediate recovery wire", () => f.assertWire(f.wires[1], true));
		const recoveredBranch = f.manager.getLeafId()!;
		const abandonedEntry = f.assertDurable();
		await f.session.prompt("Next ordinary turn.");
		await t.test("B: next ordinary wire", () => f.assertWire(f.wires[2], true));
		await f.reopen();
		await f.session.prompt("Disk resumed turn.");
		await t.test("C: fresh JSONL manager wire", () => f.assertWire(f.wires[3], true));
		await f.reopen(recoveredBranch);
		await f.session.setModel({ ...model, id: "switched-model" });
		await f.session.prompt("Recovered branch with a new model.");
		await t.test("D: recovered branch and switched model wire", () => { f.assertWire(f.wires[4], true); assert.equal(f.wires[4].model, "switched-model"); });
		await f.reopen(abandonedEntry);
		await f.session.setModel({ ...model, id: "pre-recovery-branch-model" });
		await f.session.prompt("Earlier branch has no future omission decision.");
		f.assertWire(f.wires[5], false);
		f.assertDurable();
		f.assertUsage();
		assert.equal(f.wires.length, 6); assert.equal(f.summaries.length, 1);
		t.diagnostic("ordinary=6, summary=1; A/B/C/D plus pre-recovery branch, raw usage and completed effect checked");
	} finally { f.close(); }
});

for (const scenario of ["post-entry", "extension-tail"] as const) {
	test(`length recovery persistence regression: ${scenario}`, async t => {
		const f = await fixture(scenario);
		try {
			await f.session.prompt("Continue the synthetic task.");
			assert.equal(f.wires.length, 2);
			f.assertWire(f.wires[1], true);
			f.assertDurable();
			await f.reopen();
			await f.session.prompt("Resume after the recovery checkpoint.");
			f.assertWire(f.wires.at(-1), true);
			if (scenario === "extension-tail") assert.match(JSON.stringify(f.wires.at(-1)), /old history 6 /,
				"the extension's firstKeptEntryId remains authoritative");
			f.assertUsage();
			assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 2);
			assert.equal((f.session as any)._pendingLengthRecovery, undefined);
			assert.equal(f.wires.length, 3);
			assert.equal(f.summaries.length, scenario === "extension-tail" ? 0 : 1);
			t.diagnostic(`ordinary=${f.wires.length}, summary=${f.summaries.length}; exact omission and usage after disk reopen`);
		} finally { f.close(); }
	});
}

test("length recovery waits for the real tool continuation before persisting omission", async t => {
	const f = await fixture("retry-tool");
	try {
		await f.session.prompt("Recover, inspect the completed effect, then finish.");
		assert.equal(f.wires.length, 3);
		f.assertWire(f.wires[1], true);
		f.assertWire(f.wires[2], true);
		assert.equal(f.inspections, 1);
		assert.ok(f.manager.getBranch().some(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "toolUse"));
		assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 2,
			"the successful final stop adds the omission checkpoint after toolUse");
		assert.equal((f.session as any)._pendingLengthRecovery, undefined);
		await f.reopen();
		await f.session.prompt("Disk resumed after recovery through a tool.");
		f.assertWire(f.wires[3], true);
		assert.match(JSON.stringify(f.wires[3]), /recovery-inspect/);
		assert.equal(f.inspections, 1, "neither the completed effect nor the recovery inspection replays");
		f.assertDurable(); f.assertUsage();
		assert.equal(f.wires.length, 4); assert.equal(f.summaries.length, 1);
		t.diagnostic("ordinary=4, summary=1; toolUse, tool result, final stop, disk reopen and one inspection verified");
	} finally { f.close(); }
});

for (const scenario of ["summary-error", "summary-abort", "retry-error", "retry-length", "retry-abort", "ordinary-length", "admission-error", "admission-abort"] as const) {
	test(`length recovery negative boundary: ${scenario}`, async t => {
		const f = await fixture(scenario);
		try {
			await f.session.prompt("Continue the synthetic task.");
			const retry = scenario.startsWith("retry-");
			assert.equal(f.wires.length, retry ? 2 : 1);
			assert.equal(f.summaries.length, scenario === "ordinary-length" ? 0 : 1);
			f.assertDurable();
			assert.equal((f.session as any)._pendingLengthRecovery, undefined, "settled failure releases recovery identity");
			await f.reopen();
			// A new model avoids independently starting a new recovery of the same old attempt.
			await f.session.setModel({ ...model, id: "negative-boundary-model" });
			await f.session.prompt("Inspect the unsuperseded history.");
			const omissionApplied = false;
			const resumedWire = f.wires.at(-1);
			f.assertWire(resumedWire, omissionApplied);
			if (scenario === "retry-length") {
				assert.match(JSON.stringify(resumedWire), /RETRY_LENGTH_FRAGMENT/,
					"a later length response that was not compacted remains in context");
			} else if (scenario.startsWith("retry-")) {
				assert.doesNotMatch(JSON.stringify(resumedWire), /RETRY_FAILED_FRAGMENT|RETRY_ABORTED_FRAGMENT/,
					"a later error or abort remains filtered by the existing recovery boundary");
			}
			f.assertDurable();
			assert.equal(f.session.isCompacting, false);
			assert.equal(f.session.agent.state.isStreaming, false);
			t.diagnostic(`ordinary=${f.wires.length}, summary=${f.summaries.length}; original length preserved after disk reopen`);
		} finally { f.close(); }
	});
}
