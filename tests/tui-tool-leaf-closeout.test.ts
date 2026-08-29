import assert from "node:assert/strict";
import test from "node:test";
import { getStreamedToolArgumentOwnership, type KnownApi } from "@super-pi/ai/compat";
import { Agent } from "../packages/agent/src/agent.ts";
import { setCapabilities, Text, type Component, type TUI } from "@super-pi/tui";
import { stream as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import type { ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";

function createMetrics(): ToolExecutionAllocationMetrics {
	return {
		updateDisplayCalls: 0,
		callRendererCalls: 0,
		resultRendererCalls: 0,
		componentCreations: 0,
		renderContextObjects: 0,
		internalWrapperObjects: 0,
		imageScans: 0,
		argsSerializations: 0,
		toolArgsGenerationUpdates: 0,
		toolArgsReplacementUpdates: 0,
		toolArgsSemanticFallbackComparisons: 0,
		toolArgsMissingGenerationUpdates: 0,
		toolArgsFinalizations: 0,
	};
}

function createTui(): TUI {
	return { requestRender(): void {} } as TUI;
}

function createDefinition(
	renderCall: ToolDefinition<any, any>["renderCall"],
	renderResult?: ToolDefinition<any, any>["renderResult"],
): ToolDefinition<any, any> {
	return {
		name: "leaf-closeout",
		label: "Leaf closeout",
		description: "test",
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [], details: undefined }; },
		renderCall,
		renderResult,
	} as ToolDefinition<any, any>;
}

test("legacy same-reference mutations repaint generic and custom call views", () => {
	initTheme("dark");
	const genericArgs = { top: 1, nested: { value: 1 }, streamed: "a" };
	const generic = new ToolExecutionComponent("legacy-generic", "generic", genericArgs, {}, undefined, createTui(), process.cwd());
	genericArgs.top = 2;
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"top": 2/);
	genericArgs.nested.value = 3;
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"value": 3/);
	genericArgs.streamed += "b";
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"streamed": "ab"/);

	let customCalls = 0;
	const customArgs = { top: 1, nested: { value: 1 }, streamed: "a" };
	const custom = new ToolExecutionComponent(
		"legacy-custom",
		"custom",
		customArgs,
		{},
		createDefinition((args) => {
			customCalls++;
			const value = args as typeof customArgs;
			return new Text(`${value.top}:${value.nested.value}:${value.streamed}`, 0, 0);
		}),
		createTui(),
		process.cwd(),
	);
	customCalls = 0;
	customArgs.top = 2;
	custom.updateArgs(customArgs);
	assert.match(custom.render(80).join("\n"), /2:1:a/);
	customArgs.nested.value = 3;
	custom.updateArgs(customArgs);
	assert.match(custom.render(80).join("\n"), /2:3:a/);
	customArgs.streamed += "b";
	custom.updateArgs(customArgs);
	assert.equal(customCalls, 3);
	assert.match(custom.render(80).join("\n"), /2:3:ab/);
});

test("custom renderCall remains dynamic across result and context transitions", () => {
	initTheme("dark");
	let calls = 0;
	const contexts: Array<{ executionStarted: boolean; argsComplete: boolean; isPartial: boolean; expanded: boolean; showImages: boolean; isError: boolean; state: { resultSeen?: boolean } }> = [];
	const stateSeenAtCall: boolean[] = [];
	const definition = createDefinition(
		(_args, _theme, context) => {
			calls++;
			contexts.push(context);
			stateSeenAtCall.push(context.state.resultSeen === true);
			return new Text(
				`${context.executionStarted}:${context.argsComplete}:${context.isPartial}:${context.expanded}:${context.showImages}:${context.isError}:${context.state.resultSeen === true}`,
				0,
				0,
			);
		},
		(_result, _options, _theme, context) => {
			context.state.resultSeen = true;
			return new Text("result", 0, 0);
		},
	);
	const component = new ToolExecutionComponent("dynamic-custom", "dynamic", {}, {}, definition, createTui(), process.cwd());
	calls = 0;
	contexts.length = 0;
	stateSeenAtCall.length = 0;
	component.updateResult({ content: [{ type: "text", text: "partial" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "final" }] }, false, false);
	component.updateResult({ content: [{ type: "text", text: "error" }] }, false, true);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.setExpanded(true);
	component.setShowImages(false);
	component.invalidate();
	assert.equal(calls, 8);
	assert.equal(stateSeenAtCall[1], true, "result renderer state is visible to the next call render");
	assert.match(component.render(80).join("\n"), /true:true:false:true:false:true:true/);
});

test("custom renderCall args-only caching requires explicit opt-in", () => {
	initTheme("dark");
	let calls = 0;
	const definition = createDefinition(() => {
		calls++;
		return new Text("stable", 0, 0);
	});
	definition.renderCallStability = "args-only";
	const component = new ToolExecutionComponent("stable-custom", "stable", {}, {}, definition, createTui(), process.cwd());
	calls = 0;
	component.updateResult({ content: [{ type: "text", text: "partial" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "final" }] }, false, false);
	assert.equal(calls, 0);
	component.invalidate();
	assert.equal(calls, 1, "explicit invalidation still dirties an args-only renderer");
});

test("replacement ownership skips same-content call rebuilds but repaints changed content", () => {
	initTheme("dark");
	let calls = 0;
	const definition = createDefinition((args) => {
		calls++;
		return new Text(JSON.stringify(args), 0, 0);
	});
	const component = new ToolExecutionComponent("replacement", "replacement", { value: 1 }, {}, definition, createTui(), process.cwd());
	calls = 0;
	component.updateArgs({ value: 1 }, undefined, "replacement-object");
	assert.equal(calls, 0);
	component.updateArgs({ value: 2 }, undefined, "replacement-object");
	assert.equal(calls, 1);
	assert.match(component.render(80).join("\n"), /"value":2/);
});

test("built-in result-only updates preserve the call side", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const component = new ToolExecutionComponent(
		"read",
		"read-1",
		{ path: "README.md" },
		{ allocationMetrics: metrics },
		undefined,
		createTui(),
		process.cwd(),
	);
	metrics.callRendererCalls = 0;
	component.updateResult({ content: [{ type: "text", text: "one" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "two" }] }, false, false);
	assert.equal(metrics.callRendererCalls, 0);
});

test("mutation finalization repaints without a missing-generation diagnostic", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const args = { nested: { value: 1 } };
	const component = new ToolExecutionComponent("mutation", "mutation", args, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
	args.nested.value = 2;
	component.updateArgs(args, "delta-1", "mutation-with-generation");
	args.nested.value = 3;
	(component.updateArgs as unknown as (args: unknown, generation: undefined, ownership: "mutation-with-generation", finalized: boolean) => void)(
		args,
		undefined,
		"mutation-with-generation",
		true,
	);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(component.render(80).join("\n"), /"value": 3/);
});

test("image shrink releases converted tail entries and rejects stale ordinal data", async () => {
	initTheme("dark");
	const previous = { images: null, trueColor: false, hyperlinks: false } as const;
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const component = new ToolExecutionComponent("images", "images", {}, { showImages: true }, undefined, createTui(), process.cwd());
		component.updateResult({ content: [
			{ type: "image", data: "first", mimeType: "image/png" },
			{ type: "image", data: "second", mimeType: "image/png" },
		] }, true, false);
		const state = component as unknown as {
			convertedImages: Map<number, { data: string; mimeType: string }>;
			pendingImageSourceData: Array<string | undefined>;
		};
		state.convertedImages.set(0, { data: "converted-first", mimeType: "image/png" });
		state.convertedImages.set(1, { data: "converted-second", mimeType: "image/png" });
		component.updateResult({ content: [{ type: "image", data: "first", mimeType: "image/png" }] }, true, false);
		assert.equal(state.convertedImages.has(0), true);
		assert.equal(state.convertedImages.has(1), false);
		assert.equal(state.pendingImageSourceData.length, 1);
		component.updateResult({ content: [
			{ type: "image", data: "first", mimeType: "image/png" },
			{ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" },
		] }, true, false);
		component.updateResult({ content: [{ type: "image", data: "first", mimeType: "image/png" }] }, true, false);
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		assert.equal(state.convertedImages.has(1), false, "late conversion cannot repopulate a removed ordinal");
		component.updateResult({ content: [] }, true, false);
		assert.equal(state.convertedImages.size, 0);
		assert.equal(state.pendingImageSourceData.length, 0);
	} finally {
		setCapabilities(previous);
	}
});

test("known adapter ownership matrix has dynamic host behavior without missing metadata", () => {
	initTheme("dark");
	const mutationApis: readonly KnownApi[] = [
		"anthropic-messages",
		"bedrock-converse-stream",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"openai-completions",
		"mistral-conversations",
	];
	const replacementApis: readonly KnownApi[] = ["pi-messages", "google-generative-ai", "google-vertex"];
	for (const api of mutationApis) {
		const metrics = createMetrics();
		const args = { nested: { value: 1 } };
		const component = new ToolExecutionComponent(api, api, args, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
		args.nested.value = 2;
		component.updateArgs(args, `generation:${api}:1`, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsGenerationUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationUpdates, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		assert.match(component.render(80).join("\n"), /"value": 2/, api);
	}
	for (const api of replacementApis) {
		const metrics = createMetrics();
		const component = new ToolExecutionComponent(api, api, { nested: { value: 1 } }, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
		component.updateArgs({ nested: { value: 2 } }, undefined, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsReplacementUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationUpdates, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		assert.match(component.render(80).join("\n"), /"value": 2/, api);
	}
});

test("mutation adapter start delta delta end sequence repaints finalization without a missing generation", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const tui = createTui();
	const args = { nested: { value: 0 } };
	const tool = new ToolExecutionComponent(
		"streamed",
		"tool-1",
		args,
		{ allocationMetrics: metrics },
		undefined,
		tui,
		process.cwd(),
	);
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-1", tool]]),
		streamedToolIds: new Set(["tool-1"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const deliver = (type: "toolcall_start" | "toolcall_delta" | "toolcall_end", generation?: string): void => {
		const toolCall = { type: "toolCall", id: "tool-1", name: "streamed", arguments: args } as Record<string, unknown>;
		if (generation !== undefined) toolCall.partialArgs = generation;
		const message = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "test",
			content: [toolCall],
			timestamp: 0,
		};
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: type === "toolcall_delta"
				? { type, contentIndex: 0, delta: generation, partial: message }
				: type === "toolcall_end"
					? { type, contentIndex: 0, toolCall, partial: message }
					: { type, contentIndex: 0, partial: message },
		});
	};
	deliver("toolcall_start", "");
	args.nested.value = 1;
	deliver("toolcall_delta", "{\"nested\":");
	args.nested.value = 2;
	deliver("toolcall_delta", "{\"nested\":{\"value\":2}}");
	args.nested.value = 3;
	deliver("toolcall_end");
	assert.equal(metrics.toolArgsGenerationUpdates, 3);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(tool.render(80).join("\n"), /"value": 3/);
});

test("tool finalization is scoped to its content index and does not repaint sibling tools", () => {
	initTheme("dark");
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	const tui = createTui();
	const argsA = { value: "a" };
	const argsB = { value: "b" };
	const toolA = new ToolExecutionComponent("a", "tool-a", argsA, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", argsB, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const content = [
		{ type: "toolCall", id: "tool-a", name: "a", arguments: argsA },
		{ type: "toolCall", id: "tool-b", name: "b", arguments: argsB, partialArgs: "b:1" },
	];
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content,
		timestamp: 0,
	};
	(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: message },
	});
	assert.equal(metricsA.updateDisplayCalls, 2);
	assert.equal(metricsB.updateDisplayCalls, 2, "B receives its generation but must not be finalized");
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 0);

	for (let update = 2; update <= 20; update++) {
		argsB.value = `b:${update}`;
		content[1]!.partialArgs = `b:${update}`;
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: String(update), partial: message },
		});
	}
	assert.equal(metricsA.updateDisplayCalls, 2, "finished A must not rebuild for B deltas");
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsB.updateDisplayCalls, 21);
	delete content[1]!.partialArgs;
	(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: content[1], partial: message },
	});
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolB.render(80).join("\n"), /b:20/);
});

test("Agent keeps interleaved tool updates on bounded per-tool latest lanes", async () => {
	initTheme("dark");
	const events: string[] = [];
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	const tui = createTui();
	const toolA = new ToolExecutionComponent("a", "tool-a", {}, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", {}, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const agent = new Agent({ streamFn: (() => { throw new Error("unused"); }) as never });
	(agent as unknown as { activeRun: unknown }).activeRun = {
		promise: Promise.resolve(),
		resolve(): void {},
		abortController: new AbortController(),
	};
	agent.subscribeObserver((event) => {
		if (event.type === "message_update") {
			events.push(event.assistantMessageEvent.type);
			(mode as unknown as { handleEvent(event: unknown): void }).handleEvent(event);
		}
	}, { minIntervalMs: 60_000 });
	const processEvent = (event: unknown): Promise<void> =>
		(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents(event);
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content: [
			{ type: "toolCall", id: "tool-a", name: "a", arguments: {} },
			{ type: "toolCall", id: "tool-b", name: "b", arguments: { value: "b:1" }, partialArgs: "b:1" },
		],
		timestamp: 0,
	};
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message },
	});
	message.content[1]!.partialArgs = "b:2";
	message.content[1]!.arguments.value = "b:2";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "2", partial: message },
	});
	message.content[1]!.partialArgs = "b:3";
	message.content[1]!.arguments.value = "b:3";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "3", partial: message },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.deepEqual(events, ["toolcall_end", "toolcall_delta"]);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	assert.equal(agent.eventDeliveryStats.maxPendingKeys, 2);
	assert.equal(agent.eventDeliveryStats.coalesced, 1);
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsB.toolArgsFinalizations, 0);
	assert.equal(metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolB.render(80).join("\n"), /b:3/);
	delete message.content[1]!.partialArgs;
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: message.content[1], partial: message },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 1);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	assert.equal((agent as unknown as { toolMessageLatestKeys: Map<string, string> }).toolMessageLatestKeys.size, 0);
});

test("Anthropic wire start delta delta end sequence satisfies the mutation ownership contract", async () => {
	initTheme("dark");
	const rawEvents: Array<[string, Record<string, unknown>]> = [
		["message_start", { type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"nested\":" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"value\":3}}" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
		["message_stop", { type: "message_stop" }],
	];
	let body = "";
	for (const [event, data] of rawEvents) body += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const client = { messages: { create: () => ({ asResponse: async () => response }) } };
	const model = {
		id: "test", name: "test", api: "anthropic-messages", provider: "anthropic",
		baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
	};
	const metrics = createMetrics();
	const tui = createTui();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools,
		streamedToolIds: new Set(["call-1"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	let tool: ToolExecutionComponent | undefined;
	for await (const event of streamAnthropic(
		model as never,
		{ systemPrompt: "", messages: [], tools: [] },
		{ client } as never,
	)) {
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") continue;
		const block = event.partial.content[event.contentIndex];
		assert.equal(block?.type, "toolCall");
		if (!tool) {
			tool = new ToolExecutionComponent("lookup", "call-1", block.arguments, { allocationMetrics: metrics }, undefined, tui, process.cwd());
			pendingTools.set("call-1", tool);
		}
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message: event.partial,
			assistantMessageEvent: event,
		});
	}
	assert.ok(tool);
	assert.equal(metrics.toolArgsGenerationUpdates, 3);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(tool.render(80).join("\n"), /"value": 3/);
});
