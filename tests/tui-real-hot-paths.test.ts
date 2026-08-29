import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AssistantMessage } from "@super-pi/ai/compat";
import {
	AssistantMessageComponent,
	type AssistantMessageAllocationMetrics,
} from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { MarkdownTransformer } from "../packages/coding-agent/src/core/extensions/types.ts";
import type { Component } from "../packages/tui/src/tui.ts";

initTheme("dark");

test("AssistantMessageComponent reuses bounded streaming slots and private child storage", () => {
	const metrics: AssistantMessageAllocationMetrics = {
		updateContentCalls: 0,
		contentScans: 0,
		slotRecordObjects: 0,
		markdownInstances: 0,
		spacerInstances: 0,
		textInstances: 0,
		currentSpacers: 0,
		spacerHwm: 0,
	};
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [], metrics);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "stream" }],
		timestamp: 0,
	} as AssistantMessage;
	component.updateContent(message, true);
	const state = component as unknown as {
		contentContainer: { children: Component[] };
		streamingMarkdownSlots: Map<number, unknown>;
		nextStreamingMarkdownSlots: Map<number, unknown>;
		streamingSpacers: Component[];
	};
	const children = state.contentContainer.children;
	const slotMaps = new Set([state.streamingMarkdownSlots, state.nextStreamingMarkdownSlots]);
	metrics.slotRecordObjects = 0;
	metrics.markdownInstances = 0;
	metrics.spacerInstances = 0;
	for (let index = 0; index < 100_000; index++) {
		component.updateContent(message, true);
		slotMaps.add(state.streamingMarkdownSlots);
		slotMaps.add(state.nextStreamingMarkdownSlots);
	}
	assert.equal(state.contentContainer.children, children);
	assert.equal(slotMaps.size, 2);
	assert.equal(metrics.slotRecordObjects, 0);
	assert.equal(metrics.markdownInstances, 0);
	assert.equal(metrics.spacerInstances, 0);
	assert.equal(state.streamingSpacers.length, 1);
});

test("AssistantMessageComponent releases historical streaming Spacer references after shrink and final", () => {
	const metrics: AssistantMessageAllocationMetrics = {
		updateContentCalls: 0,
		contentScans: 0,
		slotRecordObjects: 0,
		markdownInstances: 0,
		spacerInstances: 0,
		textInstances: 0,
		currentSpacers: 0,
		spacerHwm: 0,
	};
	const candidate = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [], metrics);
	const state = candidate as unknown as {
		contentContainer: { children: Component[] };
		streamingSpacers: Component[];
	};
	const messageForSpacerCount = (count: number, stopReason: AssistantMessage["stopReason"] = "pending"): AssistantMessage => {
		const content: AssistantMessage["content"] = [];
		if (count > 0) {
			for (let index = 1; index < count; index++) {
				content.push({ type: "thinking", thinking: `thinking-${index}` });
				content.push({ type: "text", text: `text-${index}` });
			}
			if (count === 1) content.push({ type: "text", text: "single" });
		}
		return { role: "assistant", content, stopReason, timestamp: 0 } as AssistantMessage;
	};
	const assertGolden = (message: AssistantMessage, streaming: boolean): void => {
		candidate.updateContent(message, streaming);
		const reference = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1, []);
		assert.deepEqual(candidate.render(80), reference.render(80));
	};

	assertGolden(messageForSpacerCount(1), true);
	assert.equal(state.streamingSpacers.length, 1);
	assertGolden(messageForSpacerCount(1_000), true);
	assert.equal(state.streamingSpacers.length, 1_000);
	const releasedTail = state.streamingSpacers[999];
	assert.ok(releasedTail);
	assertGolden(messageForSpacerCount(2), true);
	assert.equal(state.streamingSpacers.length, 2);
	assert.equal(state.streamingSpacers.includes(releasedTail), false);
	assert.equal(state.contentContainer.children.includes(releasedTail), false);
	assertGolden(messageForSpacerCount(500), true);
	assert.equal(state.streamingSpacers.length, 500);
	assertGolden(messageForSpacerCount(1), true);
	assert.equal(state.streamingSpacers.length, 1);
	state.contentContainer.children.length = 0;
	candidate.invalidate();
	assert.equal(state.streamingSpacers.length, 1);
	assertGolden(messageForSpacerCount(0, "stop"), false);
	assert.equal(state.streamingSpacers.length, 0);
	assert.equal(state.contentContainer.children.includes(releasedTail), false);
	assert.equal(metrics.currentSpacers, 0);
	assert.equal(metrics.spacerHwm, 1_000);
});

test("AssistantMessageComponent remains golden for many thinking runs and newline boundaries", () => {
	const alternatingContent: AssistantMessage["content"] = [];
	for (let index = 0; index < 10_000; index++) {
		if (index & 1) alternatingContent.push({ type: "text", text: `text-${index}\n\n` });
		else alternatingContent.push({ type: "thinking", thinking: `thinking-${index}\n\n` });
	}
	const contents: AssistantMessage["content"][] = [
		alternatingContent,
		[{ type: "text", text: "\n\n\n" }],
		[{ type: "text", text: "inline\n\n\n" }],
		[{ type: "thinking", thinking: "first" }, { type: "thinking", thinking: "\n\n" }, { type: "text", text: "tail\n" }],
	];
	const candidate = new AssistantMessageComponent();
	for (const content of contents) {
		const message = { role: "assistant", content, stopReason: "pending", timestamp: 0 } as AssistantMessage;
		candidate.updateContent(message, true);
		const reference = new AssistantMessageComponent(message);
		assert.deepEqual(candidate.render(72), reference.render(72));
	}
});

test("AssistantMessageComponent bounded slot reuse stays golden across presentation and final-state transitions", () => {
	const baseTheme = getMarkdownTheme();
	const alternateTheme = {
		...baseTheme,
		heading: (text: string): string => baseTheme.heading(`alt:${text}`),
	};
	const noTransformers: readonly MarkdownTransformer[] = [];
	const alternateTransformers: readonly MarkdownTransformer[] = [
		(markdown): string => markdown.replaceAll("TRANSFORM", "transformed"),
	];
	let activeTheme = baseTheme;
	let activeTransformers = noTransformers;
	let hideThinking = false;
	let outputPad = 1;
	const candidate = new AssistantMessageComponent(
		undefined,
		hideThinking,
		activeTheme,
		"Thinking...",
		outputPad,
		activeTransformers,
	);
	const state = candidate as unknown as {
		contentContainer: { children: Component[] };
		streamingMarkdownSlots: Map<number, unknown>;
		nextStreamingMarkdownSlots: Map<number, unknown>;
	};
	const childrenIdentity = state.contentContainer.children;
	const mapIdentities = new Set([state.streamingMarkdownSlots, state.nextStreamingMarkdownSlots]);
	let evictedRecord: unknown;

	const message = (
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"] = "pending",
		errorMessage?: string,
	): AssistantMessage => ({ role: "assistant", content, stopReason, errorMessage, timestamp: 0 } as AssistantMessage);
	const assertStep = (next: AssistantMessage, streaming: boolean): void => {
		candidate.updateContent(next, streaming);
		const reference = new AssistantMessageComponent(
			undefined,
			hideThinking,
			activeTheme,
			"Thinking...",
			outputPad,
			activeTransformers,
		);
		reference.updateContent(next, streaming);
		assert.deepEqual(candidate.render(52), reference.render(52));
		assert.equal(state.contentContainer.children, childrenIdentity);
		mapIdentities.add(state.streamingMarkdownSlots);
		mapIdentities.add(state.nextStreamingMarkdownSlots);
		assert.equal(mapIdentities.size, 2);
		assert.ok(state.streamingMarkdownSlots.size <= 4);
		assert.ok(state.nextStreamingMarkdownSlots.size <= 4);
	};

	assertStep(message([{ type: "text", text: "one" }]), true);
	assertStep(message([{ type: "thinking", thinking: "reasoning" }]), true);
	assertStep(message([{ type: "text", text: "two" }]), true);
	assertStep(message([
		{ type: "text", text: "before" },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
		{ type: "text", text: "after" },
	]), true);
	assertStep(message([{ type: "text", text: "after tool" }]), true);
	assertStep(message([
		{ type: "text", text: "slot 1" },
		{ type: "text", text: "slot 2" },
		{ type: "text", text: "slot 3" },
		{ type: "text", text: "slot 4" },
	]), true);
	evictedRecord = state.streamingMarkdownSlots.get(2);
	assert.ok(evictedRecord);
	assertStep(message([{ type: "text", text: "single" }]), true);
	assert.equal([...state.streamingMarkdownSlots.values(), ...state.nextStreamingMarkdownSlots.values()].includes(evictedRecord), false);

	outputPad = 2;
	candidate.setOutputPad(outputPad);
	assertStep(message([{ type: "text", text: "pad changed" }]), true);
	activeTheme = alternateTheme;
	candidate.setMarkdownTheme(activeTheme);
	assertStep(message([{ type: "text", text: "# heading" }]), true);
	assert.match(candidate.render(52).join("\n"), /alt:heading/);
	activeTransformers = alternateTransformers;
	candidate.setMarkdownTransformers(activeTransformers);
	assertStep(message([{ type: "text", text: "TRANSFORM" }]), true);
	assert.match(candidate.render(52).join("\n"), /transformed/);
	hideThinking = true;
	candidate.setHideThinkingBlock(true);
	assertStep(message([{ type: "thinking", thinking: "hidden detail" }]), true);
	hideThinking = false;
	candidate.setHideThinkingBlock(false);
	assertStep(message([{ type: "thinking", thinking: "shown detail" }]), true);
	assertStep(message([{ type: "text", text: "partial" }], "aborted", "aborted by test"), false);
	assertStep(message([{ type: "text", text: "partial" }], "error", "failed by test"), false);
	assertStep(message([{ type: "text", text: "final" }], "stop"), false);
	assert.equal(state.streamingMarkdownSlots.size, 0);
	assert.equal(state.nextStreamingMarkdownSlots.size, 0);
});

test("Assistant and Markdown source invariants exclude per-update maps and callback arrays", () => {
	const assistantSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/assistant-message.ts",
		"utf8",
	);
	const markdownSource = readFileSync("packages/tui/src/components/markdown.ts", "utf8");
	assert.doesNotMatch(assistantSource, /message\.content\.some\(/);
	assert.doesNotMatch(assistantSource, /slice\(i \+ 1\)\.some\(/);
	assert.match(assistantSource, /this\.contentContainer\.children\.length = 0/);
	assert.match(assistantSource, /private streamingMarkdownSlots = new Map/);
	assert.match(assistantSource, /private nextStreamingMarkdownSlots = new Map/);
	assert.equal((assistantSource.match(/private (?:next)?[Ss]treamingMarkdownSlots = new Map/g) ?? []).length, 2);
	const updateContent = assistantSource.slice(
		assistantSource.indexOf("\tupdateContent("),
		assistantSource.indexOf("\n\tprivate acquireStreamingSpacer", assistantSource.indexOf("\tupdateContent(")),
	);
	assert.doesNotMatch(updateContent, /new Map|\bMap\s*\(/);
	assert.doesNotMatch(assistantSource, /streamingMapAllocations/);
	assert.doesNotMatch(markdownSource, /split\("\\n"\)\.map\(/);
	assert.match(markdownSource, /private readonly defaultInlineStyleContext/);
});

test("paced Assistant benchmark uses only the context-aware scheduler fast path", () => {
	const source = readFileSync("scripts/bench/tui-paced-real-leaf.ts", "utf8");
	assert.match(source, /scheduleWithContext\(/);
	assert.match(source, /legacyScheduleCalls\+\+/);
	assert.match(source, /paced scheduler must use scheduleWithContext/);
	assert.match(source, /legacyScheduleCalls: scheduler\.legacyScheduleCalls/);
	assert.match(source, /schedulerCallbackIdentities: scheduler\.callbackIdentities/);
});
