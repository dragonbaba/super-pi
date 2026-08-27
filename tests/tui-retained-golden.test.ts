import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "../packages/ai/src/types.ts";
import { SkillInvocationMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts";
import { AssistantMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import {
	getMarkdownTheme,
	initTheme,
	setTheme,
} from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { Markdown } from "../packages/tui/src/components/markdown.ts";
import { RetainedContainer, type RetainedRenderContext } from "../packages/tui/src/components/retained-item.ts";
import { Spacer } from "../packages/tui/src/components/spacer.ts";
import { Text } from "../packages/tui/src/components/text.ts";
import { Container } from "../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "golden",
		model: "golden",
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

interface GoldenTree {
	container: Container;
	user: UserMessageComponent;
	assistant: AssistantMessageComponent;
	aborted: AssistantMessageComponent;
	error: AssistantMessageComponent;
	skill: SkillInvocationMessageComponent;
}

function createGoldenTree(retained: boolean, context: RetainedRenderContext): GoldenTree {
	const markdownTheme = getMarkdownTheme();
	const container = retained ? new RetainedContainer({ getContext: () => context }) : new Container();
	const user = new UserMessageComponent(
		"# ANSI/CJK/Unicode\n\n`\u001b[31mred\u001b[0m` 中文 😀 e\u0301\n\n- first\n- second",
		markdownTheme,
		1,
	);
	const assistant = new AssistantMessageComponent(
		assistantMessage([
			{ type: "thinking", thinking: "思考 😀 e\u0301\n\n第二行" },
			{ type: "text", text: "**完成** `\u001b[32mgreen\u001b[0m`\n\n多行 Markdown" },
		]),
		false,
		markdownTheme,
		"Thinking...",
		1,
	);
	const aborted = new AssistantMessageComponent(
		assistantMessage([{ type: "text", text: "partial 中文" }], "aborted", "Stopped by golden test"),
		false,
		markdownTheme,
		"Thinking...",
		1,
	);
	const error = new AssistantMessageComponent(
		assistantMessage([{ type: "text", text: "partial 😀" }], "error", "provider failed"),
		false,
		markdownTheme,
		"Thinking...",
		1,
	);
	const standaloneMarkdown = new Markdown("## Standalone\n\n中文 😀 e\u0301", 1, 0, markdownTheme);
	const skill = new SkillInvocationMessageComponent(
		{
			name: "golden-skill",
			location: "skills/golden/SKILL.md",
			content: "Instructions with **Markdown**, 中文 and 😀.",
			userMessage: undefined,
		},
		markdownTheme,
	);

	if (container instanceof RetainedContainer) {
		container.addRetainedChild(user, { id: "user", version: 1, completed: true });
		container.addRetainedChild(assistant, { id: "assistant", version: 1, completed: true });
		container.addRetainedChild(aborted, { id: "aborted", version: 1, completed: true });
		container.addRetainedChild(error, { id: "error", version: 1, completed: true });
	} else {
		container.addChild(user);
		container.addChild(assistant);
		container.addChild(aborted);
		container.addChild(error);
	}
	container.addChild(standaloneMarkdown);
	container.addChild(skill);
	return { container, user, assistant, aborted, error, skill };
}

test("production message rendering stays golden-equivalent across retained invalidations", () => {
	initTheme("dark");
	const referenceContext: RetainedRenderContext = {
		themeVersion: 1,
		rendererVersion: 1,
		expandVersion: 1,
		settingsVersion: 1,
	};
	const retainedContext = { ...referenceContext };
	const reference = createGoldenTree(false, referenceContext);
	const retained = createGoldenTree(true, retainedContext);
	assert.equal(retained.container.children[0], retained.user);
	assert.equal(retained.container.children[1], retained.assistant);
	assert.equal(retained.container.children[2], retained.aborted);
	assert.equal(retained.container.children[3], retained.error);
	const assertEquivalent = (width: number, step: string): void => {
		assert.deepEqual(retained.container.render(width), reference.container.render(width), step);
	};

	try {
		assertEquivalent(100, "first render");
		assertEquivalent(100, "repeat render");
		assertEquivalent(48, "width shrink");
		assertEquivalent(120, "width widen");

		assert.equal(setTheme("light").success, true);
		retainedContext.themeVersion++;
		reference.container.invalidate();
		retained.container.invalidate();
		assertEquivalent(100, "theme invalidation");

		retainedContext.rendererVersion++;
		assertEquivalent(100, "renderer version invalidation");

		for (const tree of [reference, retained]) tree.assistant.setHiddenThinkingLabel("Hidden reasoning 中文 😀");
		retainedContext.settingsVersion++;
		assertEquivalent(100, "hidden thinking label");

		for (const tree of [reference, retained]) tree.assistant.setHideThinkingBlock(true);
		retainedContext.expandVersion++;
		assertEquivalent(100, "hide thinking");
		for (const tree of [reference, retained]) tree.assistant.setHideThinkingBlock(false);
		retainedContext.expandVersion++;
		assertEquivalent(100, "show thinking");

		for (const tree of [reference, retained]) {
			tree.user.setOutputPad(2);
			tree.assistant.setOutputPad(2);
			tree.aborted.setOutputPad(2);
			tree.error.setOutputPad(2);
		}
		retainedContext.settingsVersion++;
		assertEquivalent(100, "output padding");

		for (const tree of [reference, retained]) tree.skill.setExpanded(true);
		retainedContext.expandVersion++;
		assertEquivalent(100, "expand");
		for (const tree of [reference, retained]) tree.skill.setExpanded(false);
		retainedContext.expandVersion++;
		assertEquivalent(100, "collapse");

		reference.container.invalidate();
		retained.container.invalidate();
		assertEquivalent(100, "explicit invalidate");

		const referenceTui = new TuiMainScreen(new FakeTerminal(100, 30), false);
		const retainedTui = new TuiMainScreen(new FakeTerminal(100, 30), false);
		referenceTui.addChild(reference.container);
		retainedTui.addChild(retained.container);
		referenceTui.showOverlay(new Markdown("Overlay 中文 😀", 1, 0, getMarkdownTheme()), { width: 30 });
		retainedTui.showOverlay(new Markdown("Overlay 中文 😀", 1, 0, getMarkdownTheme()), { width: 30 });
		referenceTui.renderNow();
		retainedTui.renderNow();
		assert.deepEqual(retainedTui.captureRenderState().previousLines, referenceTui.captureRenderState().previousLines);
	} finally {
		setTheme("dark");
	}
});

test("real streaming and status components keep index, splice, and dedup identities", () => {
	initTheme("dark");
	const transcript = new RetainedContainer();
	const streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
	const streamingState = transcript.addRetainedChild(streaming, { id: "streaming", version: 0 });
	assert.equal(transcript.children.indexOf(streaming), 0);

	const inserted = new Text("tool placeholder replacement", 0, 0);
	transcript.children.splice(transcript.children.indexOf(streaming), 0, inserted);
	assert.deepEqual(transcript.children, [inserted, streaming]);
	assert.equal(transcript.getRetainedItem(streaming), streamingState);

	const statusSpacer = new Spacer(1);
	const statusText = new Text("status one", 1, 0);
	transcript.addChild(statusSpacer);
	transcript.addChild(statusText);
	const last = transcript.children.at(-1);
	const secondLast = transcript.children.at(-2);
	assert.equal(last, statusText);
	assert.equal(secondLast, statusSpacer);
	statusText.setText("status two");
	assert.equal(transcript.children.at(-1), statusText);

	transcript.removeChild(streaming);
	assert.equal(streamingState.released, true);
	assert.equal(streamingState.component, undefined);
	assert.equal(transcript.getRetainedItem(streaming), undefined);
});
