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
function stopAfterLength(turn: { message: AssistantMessage }): boolean { return turn.message.stopReason === "length"; }
function cancelRetry(session: { abortRetry(): void }): void { session.abortRetry(); }
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
function truncatedToolReply(): Response {
	const chunk = { id: "offline-truncated-tool", object: "chat.completion.chunk", created: 1, model: model.id,
		choices: [{ index: 0, delta: { content: SENTINEL, tool_calls: [{ index: 0, id: "abandoned-call", type: "function",
			function: { name: "inspect_effect", arguments: "{}" } }] }, finish_reason: "length" }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
			completion_tokens_details: { reasoning_tokens: 4 } } };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}
type Scenario = "success" | "summary-error" | "summary-abort" | "retry-error" | "retry-length" | "retry-abort" | "ordinary-length" | "post-entry" | "extension-tail" | "extension-cloned-tail" | "admission-error" | "admission-abort" | "retry-tool" | "retry-tool-threshold" | "retry-tool-threshold-hook" | "truncated-tool" | "initial-hook-timeout" | "threshold-hook-retry-error" | "threshold-hook-retry-abort" | "auto-retry" | "auto-retry-truncated-tool" | "auto-retry-exhausted" | "auto-retry-cancel";

async function fixture(scenario: Scenario) {
	const root = mkdtempSync(join(tmpdir(), "pi087-length-"));
	const effectPath = join(root, "completed-effect.txt");
	writeFileSync(effectPath, "1"); // A completed synthetic side effect recorded in the seed history.
	let thresholdHookCalls = 0;
	const thresholdScenario = scenario.startsWith("retry-tool-threshold") || scenario.startsWith("threshold-hook-");
	const hookTimeoutScenario = scenario === "retry-tool-threshold-hook" || scenario.startsWith("threshold-hook-") || scenario === "initial-hook-timeout";
	const autoRetryScenario = scenario.startsWith("auto-retry");
	const truncatedToolScenario = scenario === "truncated-tool" || scenario === "extension-cloned-tail" || scenario === "auto-retry-truncated-tool";
	const settings = SettingsManager.inMemory({ compaction: { enabled: true,
		keepRecentTokens: thresholdScenario ? 2000 : 1024,
		reserveTokens: thresholdScenario ? 125000 : 128 },
		// Leave enabled unspecified for the production default; shorten only fixture backoff.
		retry: autoRetryScenario ? { baseDelayMs: scenario === "auto-retry-cancel" ? 5000 : 1,
			maxRetries: scenario === "auto-retry-exhausted" ? 1 : undefined } : { enabled: false } });
	const extensionScenario = scenario === "extension-tail" || scenario === "extension-cloned-tail" || hookTimeoutScenario;
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: !extensionScenario, extensionFactories: extensionScenario ? [(pi: any) => {
			if (scenario === "extension-tail") pi.on("session_before_compact", (event: any) => ({ compaction: {
				summary: "Extension checkpoint without a retained tail.",
				firstKeptEntryId: event.branchEntries.find((entry: any) => entry.type === "message" &&
					entry.message.role === "user" && String(entry.message.content).startsWith("old history 6 ")).id,
				tokensBefore: event.preparation.tokensBefore,
			} }));
			if (scenario === "extension-cloned-tail") pi.on("session_before_compact", (event: any) => {
				let failedAssistant: any;
				let failedToolResult: any;
				for (const entry of manager?.getEntries() ?? []) {
					if (entry.type !== "message") continue;
					if (entry.message.role === "assistant" && entry.message.stopReason === "length" &&
						JSON.stringify(entry.message.content).includes(SENTINEL)) failedAssistant = entry.message;
					if (entry.message.role === "toolResult" && entry.message.toolCallId === "abandoned-call") failedToolResult = entry.message;
				}
				const firstKeptEntryId = event.branchEntries.find((entry: any) => entry.type === "message" &&
					entry.message.role === "user" && String(entry.message.content).startsWith("old history 6 ")).id;
				const retainedTail: any[] = [];
				let foundFirstKept = false;
				for (const entry of event.branchEntries) {
					if (entry.id === firstKeptEntryId) foundFirstKept = true;
					if (foundFirstKept && entry.type === "message") retainedTail.push(entry.message);
				}
				assert.ok(failedAssistant, "the fixture must inject the abandoned assistant clone");
				assert.ok(failedToolResult, "the fixture must inject its truncated result clone");
				retainedTail.push(JSON.parse(JSON.stringify(failedAssistant)), structuredClone(failedToolResult));
				retainedTail.push({ ...structuredClone(failedAssistant), content: [{ type: "text", text: "LEGIT_LENGTH_SAME_METADATA" }] });
				retainedTail.push({ role: "user", content: "Continue the admitted extension tail.", timestamp: 2 });
				return { compaction: {
					summary: "Extension checkpoint with cloned failed messages.",
					firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore, retainedTail,
				} };
			});
			if (hookTimeoutScenario) pi.on("session_compact", (event: any) => {
				if ((scenario === "initial-hook-timeout" || event.reason === "threshold") && thresholdHookCalls++ === 0) return new Promise(() => {});
			});
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
	const sessionEvents: string[] = [];
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
						assert.ok(summaries.length <= (thresholdScenario ? 3 : 2), "summary requests remain bounded");
						if (scenario === "summary-error") return new Response('{"error":{"message":"synthetic summary failure"}}', { status: 400 });
						if (scenario === "summary-abort") session!.abortCompaction();
						return reply("Complete synthetic checkpoint. The recorded effect already happened.");
					}
					wires.push(wire);
					assert.ok(wires.length <= 7, "ordinary requests remain bounded");
					if (wires.length === 1) {
						if (truncatedToolScenario) return truncatedToolReply();
						return reply(SENTINEL, "length", scenario === "ordinary-length" ? 1024 : 10);
					}
					if (wires.length === 2) {
						if (autoRetryScenario) return reply("RETRY_FAILED_FRAGMENT", "network_error");
						if (scenario === "retry-tool") return toolReply();
						if (thresholdScenario) return toolReply();
						if (scenario === "retry-error") return reply("RETRY_FAILED_FRAGMENT", "network_error");
						if (scenario === "retry-length") return reply("RETRY_LENGTH_FRAGMENT", "length");
						if (scenario === "retry-abort") { void session!.abort(); return reply("RETRY_ABORTED_FRAGMENT"); }
					}
					if (wires.length === 3 && scenario === "threshold-hook-retry-error") return reply("RETRY_FAILED_FRAGMENT", "network_error");
					if (wires.length === 3 && scenario === "auto-retry-exhausted") return reply("RETRY_FAILED_FRAGMENT", "network_error");
					if (wires.length === 3 && scenario === "threshold-hook-retry-abort") { void session!.abort(); return reply("RETRY_ABORTED_FRAGMENT"); }
					return reply("Recovery complete.");
				} });
		},
	} as unknown as ModelRuntime;
	async function open() {
		session = (await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
			sessionManager: manager!, resourceLoader: resources, extensionRunnerOptions: hookTimeoutScenario
			? { hookTimeouts: { lifecycle: { timeoutMs: 5, onTimeout: "fail-closed" } } } : undefined,
			tools: ["record_effect", "inspect_effect"], customTools: [{
				name: "record_effect", label: "Effect", description: "Synthetic effect", parameters: Type.Object({}),
				execute: async () => { writeFileSync(effectPath, String(Number(readFileSync(effectPath, "utf8")) + 1));
					return { content: [{ type: "text" as const, text: "EFFECT_ALREADY_COMPLETED" }], details: {} }; },
			}, {
				name: "inspect_effect", label: "Inspect effect", description: "Read completed synthetic effect", parameters: Type.Object({}),
				execute: async () => { inspections++; return { content: [{ type: "text" as const,
					text: thresholdScenario ? "synthetic ".repeat(400) : readFileSync(effectPath, "utf8") }], details: {} }; },
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
		if (thresholdScenario || hookTimeoutScenario) session.subscribe(event => {
			if (event.type === "compaction_end") sessionEvents.push(`${event.reason}:${!!event.result}:${event.errorMessage ?? ""}`);
		});
		if (truncatedToolScenario) session.agent.shouldStopAfterTurn = stopAfterLength;
		if (autoRetryScenario) session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				sessionEvents.push(`retry:start:${event.attempt}:${!!(session as any)._pendingLengthRecovery}`);
				if (scenario === "auto-retry-cancel") setTimeout(cancelRetry, 0, session!);
			}
			if (event.type === "auto_retry_end") sessionEvents.push(`retry:end:${event.success}:${event.attempt}`);
		});
		if (scenario.startsWith("admission-")) session.subscribe(event => {
			if (event.type === "compaction_end" && event.result && event.willRetry) {
				if (scenario === "admission-abort") session!.abortCompaction();
				else throw new Error("synthetic critical admission failure");
			}
		}, { criticalCompactionEnd: true });
	}
	await open();
	return {
		get session() { return session!; }, get manager() { return manager!; }, get inspections() { return inspections; }, wires, summaries, sessionEvents,
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
		assertNoAbandonedToolResult(wire: any) {
			assert.equal(wire.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "abandoned-call"), false,
				"a truncated call cannot leave an orphan tool result");
		},
		assertRawTruncatedToolResult() {
			const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
			assert.ok(entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant" &&
				entry.message.content.some((content: any) => content.type === "toolCall" && content.id === "abandoned-call")));
			assert.ok(entries.some((entry: any) => entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolCallId === "abandoned-call"));
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

test("length recovery filters cloned retained-tail copies", async t => {
	const f = await fixture("extension-cloned-tail");
	try {
		await f.session.prompt("Recover with cloned failed messages in the extension tail.");
		assert.equal(f.wires.length, 2);
		f.assertWire(f.wires[1], true);
		f.assertNoAbandonedToolResult(f.wires[1]);
		assert.match(JSON.stringify(f.wires[1]), /LEGIT_LENGTH_SAME_METADATA/);
		f.assertDurable();
		f.assertRawTruncatedToolResult();
		assert.equal(f.inspections, 0);
		await f.reopen();
		await f.session.prompt("Resume after cloned-tail recovery.");
		f.assertWire(f.wires.at(-1), true);
		f.assertNoAbandonedToolResult(f.wires.at(-1));
		assert.match(JSON.stringify(f.wires.at(-1)), /LEGIT_LENGTH_SAME_METADATA/);
		f.assertUsage();
		assert.equal((f.session as any)._pendingLengthRecovery, undefined);
		t.diagnostic("ordinary=3, summary=0; cloned assistant and tool-result identities omitted before and after disk reopen");
	} finally { f.close(); }
});

test("length recovery waits for the real tool continuation before persisting omission", async t => {
	const f = await fixture("retry-tool");
	try {
		await f.session.prompt("Recover, inspect the completed effect, then finish.");
		assert.equal(f.wires.length, 3);
		f.assertWire(f.wires[1], true);
		f.assertWire(f.wires[2], true);
		f.assertUsage();
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

test("length recovery keeps omission through an intervening threshold compaction", async t => {
	const f = await fixture("retry-tool-threshold");
	try {
		await f.session.prompt("Recover through a threshold compaction before finishing.");
		t.diagnostic(`threshold wires=${f.wires.length}, summaries=${f.summaries.length}, events=${f.sessionEvents.join("|")}`);
		assert.equal(f.wires.length, 3);
		assert.ok(f.sessionEvents.includes("threshold:true:"), "real threshold compaction ran before final stop");
		f.assertWire(f.wires[1], true);
		f.assertWire(f.wires[2], true);
		f.assertUsage();
		assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 3);
		assert.equal((f.session as any)._pendingLengthRecovery, undefined);
		await f.reopen();
		await f.session.prompt("Disk resumed after the intervening compaction.");
		f.assertWire(f.wires[3], true);
		f.assertUsage();
		t.diagnostic("ordinary=4, summary=2; pending omission followed a prepareNextTurnWithContext threshold compaction");
	} finally { f.close(); }
});

test("length recovery advances its boundary before a threshold hook timeout", async t => {
	const f = await fixture("retry-tool-threshold-hook");
	try {
		await f.session.prompt("Recover after a threshold hook timeout.");
		t.diagnostic(`hook-timeout wires=${f.wires.length}, summaries=${f.summaries.length}, events=${f.sessionEvents.join("|")}`);
		assert.ok(f.sessionEvents.some(event => event.startsWith("threshold:")));
		assert.equal(f.wires.length, 3);
		assert.equal(f.summaries.length, 2);
		f.assertWire(f.wires[2], true);
		f.assertDurable();
		await f.reopen();
		await f.session.prompt("Complete recovery after the hook timeout.");
		f.assertWire(f.wires.at(-1), true);
		f.assertUsage();
		assert.equal((f.session as any)._pendingLengthRecovery, undefined);
		t.diagnostic("threshold hook failed after append; later continuation settled the newest checkpoint without replay");
	} finally { f.close(); }
});

for (const scenario of ["auto-retry", "auto-retry-truncated-tool", "auto-retry-exhausted", "auto-retry-cancel"] as const) {
	test(`length recovery automatic retry boundary: ${scenario}`, async t => {
		const f = await fixture(scenario);
		try {
			assert.equal(f.session.autoRetryEnabled, true, "exercise the default enabled retry policy");
			await f.session.prompt("Recover through a transient provider failure.");
			const success = scenario === "auto-retry" || scenario === "auto-retry-truncated-tool";
			const ordinary = scenario === "auto-retry-cancel" ? 2 : 3;
			assert.equal(f.wires.length, ordinary);
			assert.equal(f.summaries.length, 1, "automatic retry must not add summary requests");
			for (let index = 1; index < f.wires.length; index++) {
				f.assertWire(f.wires[index], true);
				f.assertNoAbandonedToolResult(f.wires[index]);
				assert.doesNotMatch(JSON.stringify(f.wires[index]), /RETRY_FAILED_FRAGMENT/);
			}
			assert.deepEqual(f.sessionEvents, ["retry:start:1:true", `retry:end:${success}:1`]);
			assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, success ? 2 : 1);
			assert.equal((f.session as any)._pendingLengthRecovery, undefined);
			assert.equal(f.session.isRetrying, false);
			assert.equal(f.session.retryAttempt, 0);
			assert.equal(f.manager.getEntries().filter(e => e.type === "message" && e.message.role === "assistant" &&
				e.message.stopReason === "error").length, scenario === "auto-retry-exhausted" ? 2 : 1,
				"transient failed attempts remain in raw history");
			f.assertDurable(); f.assertUsage();
			if (scenario === "auto-retry-truncated-tool") f.assertRawTruncatedToolResult();
			assert.equal(f.inspections, 0);
			await f.reopen();
			await f.session.setModel({ ...model, id: "auto-retry-resumed-model" });
			await f.session.prompt("Inspect the durable automatic retry outcome.");
			assert.equal(f.wires.length, ordinary + 1);
			assert.equal(f.summaries.length, 1);
			f.assertWire(f.wires.at(-1), success);
			assert.doesNotMatch(JSON.stringify(f.wires.at(-1)), /RETRY_FAILED_FRAGMENT/);
			if (success) f.assertNoAbandonedToolResult(f.wires.at(-1));
			f.assertDurable(); f.assertUsage();
			t.diagnostic(`ordinary=${f.wires.length}, summary=1; one retry scheduled, success=${success}, disk outcome and release checked`);
		} finally { f.close(); }
	});
}

test("length recovery removes truncated tool calls and their synthetic results", async t => {
	const f = await fixture("truncated-tool");
	try {
		await f.session.prompt("Recover a truncated tool call.");
		assert.equal(f.wires.length, 2);
		f.assertWire(f.wires[1], true);
		f.assertNoAbandonedToolResult(f.wires[1]);
		assert.equal(f.inspections, 0);
		f.assertDurable();
		f.assertRawTruncatedToolResult();
		t.diagnostic("ordinary=2, summary=1; truncated assistant call and synthetic result removed from retry context");
	} finally { f.close(); }
});

for (const scenario of ["initial-hook-timeout", "threshold-hook-retry-error", "threshold-hook-retry-abort"] as const) {
	test(`length recovery post-save hook failure boundary: ${scenario}`, async t => {
		const f = await fixture(scenario);
		try {
			await f.session.prompt("Recover with a post-save hook timeout.");
			const initial = scenario === "initial-hook-timeout";
			assert.equal(f.wires.length, initial ? 1 : 3);
			assert.equal(f.summaries.length, initial ? 1 : 2);
			assert.ok(f.sessionEvents.some(event => event.includes('hook "session_compact"') && event.includes("timed out")));
			assert.equal((f.session as any)._pendingLengthRecovery, undefined);
			assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, initial ? 1 : 2,
				"failed recovery must not append a successful omission checkpoint");
			if (!initial) f.assertWire(f.wires[2], true);
			f.assertDurable(); f.assertUsage();
			assert.equal(f.inspections, initial ? 0 : 1);
			await f.reopen();
			await f.session.setModel({ ...model, id: "post-save-failure-model" });
			await f.session.prompt("Inspect the unsuperseded fallback after disk reopen.");
			f.assertWire(f.wires.at(-1), false);
			assert.doesNotMatch(JSON.stringify(f.wires.at(-1)), /RETRY_FAILED_FRAGMENT|RETRY_ABORTED_FRAGMENT/);
			f.assertDurable(); f.assertUsage();
			t.diagnostic(`ordinary=${f.wires.length}, summary=${f.summaries.length}; no successful omission on hook/recovery failure, pending identity released`);
		} finally { f.close(); }
	});
}

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
