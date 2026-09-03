import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELEASE_COMPONENT_RENDER_CACHE, type TUI } from "@super-pi/tui";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentation,
	type ToolResultPresentationContent,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

interface DiscoveryState {
	readonly cursor: string;
	readonly artifactId?: string;
	readonly originalEstimatedTokens: number;
	readonly modelEstimatedTokens: number;
}

interface PresentationAwareComponent {
	setToolResultPresentation(toolCallId: string, presentation: ToolResultPresentation): string | undefined;
	clearToolResultPresentation(toolCallId: string, identity?: string): void;
	getToolResultPresentationDiscovery(toolCallId: string): DiscoveryState | undefined;
}

function presentationAware(component: object): PresentationAwareComponent {
	return component as PresentationAwareComponent;
}

function createTui(): TUI {
	return { requestRender(): void {} } as TUI;
}

function toolResult(toolCallId: string, content: ToolResultPresentationContent[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

test("small V1 ToolResult UI remains byte-for-byte unchanged", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "small-result" }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-small")!;
	const presentation = owner.create(content, "small")!;
	assert.equal(presentation.version, 1);
	const component = new ToolExecutionComponent("fixture", "small", {}, {}, undefined, createTui(), process.cwd());
	component.updateResult({ content });
	const before = component.render(80);
	assert.equal(presentationAware(component).setToolResultPresentation("small", presentation), undefined);
	assert.deepEqual(component.render(80), before);
	assert.equal(presentationAware(component).getToolResultPresentationDiscovery("small"), undefined);
	owner.release();
	owner.dispose();
});

test("bounded text and image results expose compact discovery without rendering handles", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "large-result-line\n".repeat(2_000) },
		{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
	];
	const message = toolResult("large", content);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-large")!;
	const presentation = owner.create(content, message.toolCallId)!;
	assert.equal(presentation.version, 2);
	const component = new ToolExecutionComponent(
		"fixture",
		message.toolCallId,
		{},
		{ showImages: false },
		undefined,
		createTui(),
		process.cwd(),
	);
	component.updateResult({ content });
	const identity = presentationAware(component).setToolResultPresentation(message.toolCallId, presentation);
	assert.ok(identity);
	const discovery = presentationAware(component).getToolResultPresentationDiscovery(message.toolCallId);
	assert.ok(discovery?.artifactId);

	const collapsed = component.render(44).join("\n");
	assert.match(collapsed, /Model received a bounded view/);
	assert.match(collapsed, /Ctrl\+O.*full result/);
	assert.doesNotMatch(collapsed, /tr1\.|tra1\./);

	const chunk = owner.readContinuation(discovery.cursor, [message], 128);
	assert.ok(chunk.content.length > 0);
	assert.ok(chunk.estimatedTokens > 0 && chunk.estimatedTokens <= 128);
	const artifact = owner.readArtifact(discovery.artifactId, [message]);
	assert.equal(artifact.content, content);

	component.setExpanded(true);
	const expanded = component.render(100).join("\n");
	assert.match(expanded, /Full canonical result is shown/);
	assert.match(expanded, /Continuation: available/);
	assert.match(expanded, /Session artifact: available/);
	assert.doesNotMatch(expanded, new RegExp(discovery.cursor.replaceAll(".", "\\.")));
	assert.doesNotMatch(expanded, new RegExp(discovery.artifactId.replaceAll(".", "\\.")));

	initTheme("light");
	component.invalidate();
	assert.match(component.render(61).join("\n"), /Full canonical result is shown/);
	component[RELEASE_COMPONENT_RENDER_CACHE]();
	assert.equal(presentationAware(component).getToolResultPresentationDiscovery(message.toolCallId), undefined);
	owner.release();
	owner.dispose();
});

test("grouped read rows use the same bounded-result semantics", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "grouped-read\n".repeat(2_000) }];
	const message = toolResult("read-large", content);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-read-group")!;
	const presentation = owner.create(content, message.toolCallId)!;
	assert.equal(presentation.version, 2);
	const group = new ReadToolGroupComponent();
	group.updateArgs(message.toolCallId, { path: "large.txt" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	assert.ok(presentationAware(group).setToolResultPresentation(message.toolCallId, presentation));
	assert.match(group.render(52).join("\n"), /Model received a bounded view/);
	group.setExpanded(true);
	assert.match(group.render(90).join("\n"), /Full canonical result is shown/);
	presentationAware(group).clearToolResultPresentation(message.toolCallId);
	assert.doesNotMatch(group.render(90).join("\n"), /Model received a bounded view/);
	owner.release();
	owner.dispose();
});

test("interactive live and rebuild paths consume only the internal sidecar with a hard cap", () => {
	const interactive = readFileSync(
		new URL("../packages/coding-agent/src/modes/interactive/interactive-mode.ts", import.meta.url),
		"utf8",
	);
	const session = readFileSync(
		new URL("../packages/coding-agent/src/core/agent-session.ts", import.meta.url),
		"utf8",
	);
	assert.match(interactive, /event\.toolResultPresentation/);
	assert.match(interactive, /getToolResultPresentationForUi/);
	assert.match(interactive, /MAX_TOOL_RESULT_DISCOVERIES\s*=\s*128/);
	assert.match(interactive, /clearToolResultDiscoveries/);
	assert.match(session, /getToolResultPresentationForUi/);
	assert.match(session, /toolResultPresentationEnabled/);
});
