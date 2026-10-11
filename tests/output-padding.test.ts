import assert from "node:assert/strict";
import test from "node:test";
import { Box, Container, RELEASE_COMPONENT_RENDER_CACHE, RetainedContainer, Text, type Component, type TUI } from "@super-pi/tui";
import { createToolHtmlRenderer } from "../packages/coding-agent/src/core/export-html/tool-renderer.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import type { ToolRenderers } from "../packages/coding-agent/src/core/extensions/types.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../packages/coding-agent/src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts";
import { ReadToolGroupComponent, ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../packages/coding-agent/src/utils/ansi.ts";

initTheme("dark");
const ui = { requestRender() {} } as TUI;
type Padded = Component & { setOutputPad(pad: number): void; [RELEASE_COMPONENT_RENDER_CACHE]?(): void };
function lines(component: Component, width = 100): string[] {
	return component.render(width).map(line => stripAnsi(line).trimEnd()).filter(line => /[\p{L}\p{N}$]/u.test(line));
}
function tool(name: string, pad: number, renderers?: ToolRenderers): ToolExecutionComponent {
	const row = new ToolExecutionComponent(name, name, {}, { outputPad: pad }, renderers, ui, process.cwd());
	row.updateResult({ content: [{ type: "text", text: "result" }], isError: name === "edit" });
	return row;
}

test("transcript leaves honor initial padding and reversible expanded padding changes", t => {
	const factories: Array<[string, () => Padded]> = [
		["generic", () => tool("missing", 0)],
		["builtin", () => tool("read", 0)],
		["self edit", () => tool("edit", 0)],
		["codemode", () => tool("codemode", 0)],
		["compaction", () => new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 }, undefined, 0)],
		["branch", () => new BranchSummaryMessageComponent({ role: "branchSummary", summary: "summary", fromId: "from", timestamp: 0 }, undefined, 0)],
		["skill", () => new SkillInvocationMessageComponent({ name: "skill", content: "body", location: "fixture", userMessage: undefined }, undefined, 0)],
		["custom fallback", () => new CustomMessageComponent({ role: "custom", customType: "fixture", content: "body", display: true, timestamp: 0 }, undefined, undefined, 0)],
		["entry error", () => new CustomEntryComponent({ type: "custom", id: "entry", parentId: null, timestamp: "fixture", customType: "fixture", data: {} }, () => { throw new Error("fixture"); }, 0)],
		["command", () => {
			const row = new BashExecutionComponent("pwd", ui, false, 0);
			row.appendOutput("result"); row.setComplete(1, false); return row;
		}],
	];
	for (const [name, create] of factories) {
		const row = create(); t.after(() => row[RELEASE_COMPONENT_RENDER_CACHE]?.());
		for (const expanded of [false, true]) {
			(row as Padded & { setExpanded(value: boolean): void }).setExpanded(expanded);
			const zero = lines(row); assert.ok(zero.length, name); assert.match(zero[0], /^\S/, name);
			row.setOutputPad(1); assert.deepEqual(lines(row), zero.map(line => ` ${line}`), `${name}: ${expanded}`);
			row.setOutputPad(0); assert.deepEqual(lines(row), zero, `${name}: restore`);
		}
	}
});

test("grouped reads retain relative indentation when base padding changes", t => {
	const row = new ReadToolGroupComponent(false, 60, undefined, 0);
	t.after(() => row[RELEASE_COMPONENT_RENDER_CACHE]());
	for (const id of ["a", "b"]) {
		row.updateArgs(id, { path: id }); row.updateResult(id, { content: [{ type: "text", text: "result" }] });
	}
	row.setExpanded(true);
	const zero = lines(row); assert.match(zero[0], /^\S/);
	row.setOutputPad(1); assert.deepEqual(lines(row), zero.map(line => ` ${line}`));
});

test("self renderers receive padding and args-only calls refresh on a setting change", t => {
	const renderers: ToolRenderers = { renderShell: "self", renderCallStability: "args-only",
		renderCall(_args, _theme, context) { return new Text("call", context.outputPad, 0); },
		renderResult(_result, _options, _theme, context) { return new Text("result", context.outputPad, 0); } };
	const row = tool("custom", 0, renderers); t.after(() => row[RELEASE_COMPONENT_RENDER_CACHE]());
	assert.deepEqual(lines(row), ["call", "result"]);
	row.setOutputPad(1); assert.deepEqual(lines(row), [" call", " result"]);
	const html = createToolHtmlRenderer({ getToolRenderers: () => renderers, theme, cwd: process.cwd() });
	assert.match(html.renderCall("export", "custom", {})!, / call/);
});

test("Box/Text padding invalidates wrapping caches and repeated same padding is a no-op", () => {
	const text = new Text("1234", 0, 0), box = new Box(0, 0); box.addChild(new Text("1234", 0, 0));
	for (const component of [text, box]) {
		assert.equal(component.render(5).length, 1);
		component.setPaddingX(1); assert.equal(component.render(5).length, 2);
		const cached = component.render(5); component.setPaddingX(1); assert.equal(component.render(5), cached);
		component.setPaddingX(0); assert.equal(component.render(5).length, 1);
	}
});

test("settings update retained and pending rows in place while an execution is active", t => {
	const context = { themeVersion: 0, settingsVersion: 0, expandVersion: 0, rendererVersion: 0 };
	const chat = new RetainedContainer({ getContext: () => context }), pending = new Container();
	const row = tool("missing", 1), command = new BashExecutionComponent("pwd", ui, false, 1);
	t.after(() => { command.setComplete(0, true); command[RELEASE_COMPONENT_RENDER_CACHE](); chat.clear(); });
	chat.addRetainedChild(row, { id: "tool", version: 1, completed: true }); pending.addChild(command);
	const before = lines(chat);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { outputPad: 1, chatContainer: chat,
		pendingMessagesContainer: pending, transcriptRenderContext: context, ui,
		rebuildChatFromMessages() { throw new Error("must preserve active rows"); } }) as { applyOutputPad(pad: number): void };
	mode.applyOutputPad(0);
	assert.deepEqual(lines(chat), before.map(line => line.slice(1)));
	assert.match(lines(command)[0], /^\$/); assert.equal(chat.children[0], row); assert.equal(pending.children[0], command);
	assert.equal(context.settingsVersion, 1);
});

test("production live factories and history restoration pass the configured padding", t => {
	const session = { settingsManager: SettingsManager.inMemory({ outputPad: 0 }), sessionManager: SessionManager.inMemory(),
		getToolDefinition() {}, getToolRenderers() {}, extensionRunner: { getMessageRenderer() {} } };
	const chat = new RetainedContainer(); t.after(() => chat.clear());
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { runtimeHost: { session }, outputPad: 0,
		chatContainer: chat, pendingTools: new Map(), streamedToolIds: new Set(), deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(), nextTranscriptItemNumber: 0, toolOutputExpanded: false, ui,
		getMarkdownTransformers() { return []; } }) as {
		createTrackedToolComponent(name: string, id: string, args: unknown, placeholder?: undefined, group?: boolean): Component;
		renderSessionItems(items: unknown[]): void;
	};
	for (const name of ["missing", "read"]) {
		const row = mode.createTrackedToolComponent(name, `live-${name}`, { path: "fixture" }, undefined, true);
		assert.match(lines(row)[0], /^\S/, `live ${name}`);
	}
	mode.renderSessionItems([
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "history", arguments: { path: "fixture" } }], stopReason: "toolUse" },
		{ role: "toolResult", toolName: "read", toolCallId: "history", content: [{ type: "text", text: "result" }], isError: false },
		{ role: "bashExecution", command: "pwd", output: "result", exitCode: 0, cancelled: false },
		{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 },
		{ role: "branchSummary", summary: "summary", fromId: "from", timestamp: 0 },
		{ role: "user", content: '<skill name="fixture" location="fixture">body</skill>', timestamp: 0 },
	]);
	for (const row of chat.children) {
		const rendered = lines(row);
		if (rendered.length) assert.match(rendered[0], /^\S/, row.constructor.name);
	}
});
