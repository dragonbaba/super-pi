import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { ThinkingLevel } from "@super-pi/agent-core";
import { createAssistantMessageEventStream } from "@super-pi/ai";
import { generateBranchSummary } from "../../packages/coding-agent/src/core/compaction/branch-summarization.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { ALPHA_MODEL, alphaHeadless, alphaModelRuntime } from "../helpers/alpha-session.ts";
import { streamSimple as streamChat } from "../../packages/ai/src/api/openai-completions.ts";
import { streamSimple as streamGoogle } from "../../packages/ai/src/api/google-generative-ai.ts";
import { streamSimple as streamVertex } from "../../packages/ai/src/api/google-vertex.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type { Model } from "../../packages/ai/src/types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function reply(reason: "stop" | "error" | "aborted" = "stop", errorMessage?: string) {
	const stream = createAssistantMessageEventStream();
	const message = { role: "assistant" as const, api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id,
		content: [{ type: "text" as const, text: "Offline branch summary" }], timestamp: 1, usage, stopReason: reason, errorMessage };
	if (reason === "stop") stream.push({ type: "done", reason, message });
	else stream.push({ type: "error", reason, error: message });
	return stream;
}
function entries() {
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "user", content: "Summarize this branch", timestamp: 0 });
	return manager.getEntries();
}

for (const [reasoning, level, expected] of [
	[true, "high", "high"], [true, "low", "low"], [true, "off", undefined], [true, undefined, undefined], [false, "high", undefined],
] as const) test(`branch summary reasoning=${reasoning}, level=${level}`, async () => {
	let calls = 0;
	const result = await generateBranchSummary(entries(), { model: { ...ALPHA_MODEL, reasoning }, thinkingLevel: level,
		signal: new AbortController().signal, streamFn: (_model, _context, options) => {
			calls++; assert.equal(options?.reasoning, expected); assert.equal(options?.maxTokens, 2048);
			assert.equal(options?.toolChoice, "none"); assert.equal(options?.cacheRetention, "none"); return reply();
		}, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
	assert.equal(result.error, undefined); assert.match(result.summary!, /Offline branch summary/); assert.equal(calls, 1);
});

test("branch summary transient retry retains one reasoning/options snapshot", async () => {
	const seen: unknown[] = [], controller = new AbortController();
	const options = { model: { ...ALPHA_MODEL, reasoning: true }, thinkingLevel: "high" as ThinkingLevel, signal: controller.signal,
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, streamFn: (_model: any, _context: any, request: any) => {
			seen.push(request); options.thinkingLevel = "low";
			return seen.length === 1 ? reply("error", "503 service unavailable") : reply();
		} };
	const result = await generateBranchSummary(entries(), options);
	assert.equal(result.error, undefined); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
	assert.equal((seen[0] as any).reasoning, "high"); assert.equal((seen[0] as any).maxTokens, 2048);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const [enabled, level, expected] of [[true, "high", "low"], [true, "off", "none"], [false, "high", undefined]] as const) {
	test(`branch summary keeps existing provider capability mapping: enabled=${enabled}, level=${level}`, async () => {
		let wire: any, calls = 0;
		const capabilities = { ...conservativeModelCapabilities() };
		if (enabled) capabilities.reasoning = { mode: "levels", levels: ["off", "low"] };
		const model: Model<"openai-completions"> = { ...ALPHA_MODEL, api: "openai-completions", reasoning: enabled, capabilities,
			thinkingLevelMap: { off: "none", low: "low" }, compat: { supportsReasoningEffort: true, thinkingFormat: "openai", maxTokensField: "max_tokens" } };
		const result = await generateBranchSummary(entries(), { model, thinkingLevel: level, apiKey: "offline", signal: new AbortController().signal,
			streamFn: (requestModel, context, options) => streamChat(requestModel as Model<"openai-completions">, context, { ...options,
				fetch: async (_url, init) => {
					calls++; wire = JSON.parse(init!.body as string);
					return new Response('data: {"id":"fixture","choices":[{"delta":{"content":"summary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
				} }), retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
		assert.equal(result.error, undefined); assert.equal(calls, 1);
		assert.equal(wire.reasoning_effort, expected); assert.equal(wire.max_tokens, 2048);
	});
}

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	for (const [level, budget, modelMax, expected] of [
		["medium", 8192, 32768, 1024], ["high", 8192, 32768, 1024],
		["medium", 8192, 1536, 512], ["medium", 512, 32768, 512], ["medium", -1, 32768, -1],
	] as const) test(`branch summary ${api} fits ${level}/${budget} thinking in model cap ${modelMax}`, async () => {
		let payload: any, budgets: unknown, calls = 0;
		const model = { ...ALPHA_MODEL, api, id: "gemini-2.5-pro", reasoning: true, maxTokens: modelMax,
			thinkingBudgetMap: { medium: budget }, capabilities: { ...conservativeModelCapabilities(),
				reasoning: { mode: "budget" as const, levels: ["off", "medium"] as const } } };
		const result = await generateBranchSummary(entries(), { model, thinkingLevel: level, apiKey: "offline", signal: new AbortController().signal,
			streamFn: (requestModel, context, options) => {
				calls++; assert.equal(options?.reasoning, level); assert.equal(options?.maxTokens, 2048);
				budgets = options?.thinkingBudgets;
				const sender = api === "google-generative-ai" ? streamGoogle : streamVertex;
				return sender(requestModel as never, context, { ...options, project: "fixture", location: "us-central1",
					onPayload(value: unknown) { payload = value; throw Error("captured-summary-payload"); } } as never);
			}, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
		assert.ok(payload, result.error); assert.match(result.error!, /captured-summary-payload/); assert.equal(calls, 1);
		assert.deepEqual(budgets, budget > 1024 ? { medium: expected } : undefined);
		assert.equal(payload.config.thinkingConfig.thinkingBudget, expected);
		assert.equal(payload.config.maxOutputTokens, Math.min(2048, modelMax));
	});
	test(`branch summary ${api} keeps the explicit budget failure when no thinking space remains`, async () => {
		let calls = 0, sent = false;
		const model = { ...ALPHA_MODEL, api, id: "gemini-2.5-pro", reasoning: true, maxTokens: 1024,
			thinkingBudgetMap: { medium: 8192 }, capabilities: { ...conservativeModelCapabilities(),
				reasoning: { mode: "budget" as const, levels: ["off", "medium"] as const } } };
		await assert.rejects(generateBranchSummary(entries(), { model, thinkingLevel: "medium", apiKey: "offline", signal: new AbortController().signal,
			streamFn: (requestModel, context, options) => {
				calls++; assert.equal(options?.thinkingBudgets, undefined);
				return (api === "google-generative-ai" ? streamGoogle : streamVertex)(requestModel as never, context, { ...options,
					onPayload() { sent = true; throw Error("unexpected payload"); } });
			}, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } }), /output-reservation/);
		assert.equal(calls, 1); assert.equal(sent, false);
	});
}

test("branch summary abort settles the request and removes its listener", async () => {
	const controller = new AbortController(); let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
	const task = generateBranchSummary(entries(), { model: { ...ALPHA_MODEL, reasoning: true }, thinkingLevel: "high", signal: controller.signal,
		streamFn: (_model, _context, options) => {
			assert.equal(options?.reasoning, "high");
			const stream = createAssistantMessageEventStream();
			options!.signal!.addEventListener("abort", () => {
				const message = { role: "assistant" as const, api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id,
					content: [], timestamp: 1, usage, stopReason: "aborted" as const };
				stream.push({ type: "error", reason: "aborted", error: message });
			}, { once: true });
			enter(); return stream;
		}, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
	await entered; controller.abort(); assert.deepEqual(await task, { aborted: true });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("actual tree summaries inherit the current session thinking level after changes", async () => {
	const seen: { reasoning?: string; maxTokens?: number }[] = [];
	const runtime = alphaModelRuntime((_model, context, options) => {
		if (context.systemPrompt?.includes("summar")) seen.push({ reasoning: options?.reasoning, maxTokens: options?.maxTokens });
		return reply();
	});
	const f = await alphaHeadless(runtime, [
		{ role: "user", content: "root", timestamp: 0 }, { role: "user", content: "branch", timestamp: 1 },
	]);
	try {
		f.session.agent.state.model = { ...ALPHA_MODEL, reasoning: true };
		const target = f.session.sessionManager.getEntries()[0].id;
		for (const level of ["low", "high"] as const) {
			f.session.setThinkingLevel(level);
			assert.equal(f.session.thinkingLevel, level);
			f.session.sessionManager.appendMessage({ role: "user", content: `branch-${level}`, timestamp: 2 });
			const result = await f.session.navigateTree(target, { summarize: true });
			assert.equal(result.cancelled, false);
		}
		assert.deepEqual(seen, [{ reasoning: "low", maxTokens: 2048 }, { reasoning: "high", maxTokens: 2048 }]);
	} finally { await f.release(); }
});
