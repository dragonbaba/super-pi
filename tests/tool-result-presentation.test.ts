import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, TextContent } from "../packages/ai/src/types.ts";
import { sessionEntryToContextMessages } from "../packages/coding-agent/src/core/session-manager.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	getToolResultModelContent,
	getToolResultUiContent,
	TOOL_RESULT_PRESENTATION_VERSION,
	type ToolResultPresentationContent,
	type ToolResultPresentationV1,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

test("presentation owns independent outer arrays while reusing blocks and strings", () => {
	const text = "x".repeat(10 * 1024 * 1024);
	const imageData = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo9PQ==";
	const textBlock: TextContent = { type: "text", text };
	const imageBlock: ImageContent = { type: "image", data: imageData, mimeType: "image/png" };
	const modelContent: ToolResultPresentationContent[] = [textBlock, imageBlock];
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, counters })!;

	const presentation = owner.create(modelContent)!;
	assert.equal(presentation.version, TOOL_RESULT_PRESENTATION_VERSION);
	assert.equal(presentation.modelContent, modelContent);
	assert.notEqual(presentation.uiContent, modelContent);
	assert.equal(presentation.modelContent[0], presentation.uiContent?.[0]);
	assert.equal(presentation.modelContent[1], presentation.uiContent?.[1]);
	assert.equal((presentation.uiContent?.[0] as TextContent).text, text);
	assert.equal((presentation.uiContent?.[0] as TextContent).text === text, true);
	assert.equal((presentation.uiContent?.[1] as ImageContent).data, imageData);
	assert.equal((presentation.uiContent?.[1] as ImageContent).data === imageData, true);

	(presentation.uiContent as ToolResultPresentationContent[]).pop();
	assert.equal(presentation.modelContent.length, 2);
	assert.equal(counters.presentationObjectsCreated, 1);
	assert.equal(counters.uiOuterArraysCreated, 1);
	assert.equal(counters.modelOuterArraysReused, 1);
	assert.equal(counters.presentationOuterArrayReferences, 2);
	assert.equal(counters.contentBlockReferencesReused, 2);
	assert.equal(counters.textStringReferencesReused, 1);
	assert.equal(counters.imageDataReferencesReused, 1);
	assert.equal(counters.maximumTextCodeUnits, text.length);
	assert.equal(counters.maximumImageDataCodeUnits, imageData.length);
	assert.equal(counters.activeDispatchPresentationScopes, 1);
	assert.equal(counters.dispatchPresentationScopesHighWaterMark, 1);
	owner.release();
	assert.equal(counters.activeDispatchPresentationScopes, 0);
	assert.equal(counters.completedDispatchPresentationScopes, 1);
	owner.dispose();
	assert.equal(presentation.modelContent, modelContent);
	assert.equal(presentation.uiContent?.[0], textBlock);
});

test("disabled owner performs no presentation or array work", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: false, counters });
	assert.equal(owner, undefined);
	assert.deepEqual(counters, createToolResultPresentationCounters());
});

test("unknown or malformed versions conservatively fall back to legacy content", () => {
	const fallback: ToolResultPresentationContent[] = [{ type: "text", text: "legacy" }];
	const unknown = {
		version: 2,
		modelContent: [{ type: "text", text: "unknown model" }],
		uiContent: [{ type: "text", text: "unknown ui" }],
	};
	assert.equal(getToolResultModelContent(unknown, fallback), fallback);
	assert.equal(getToolResultUiContent(unknown, fallback), fallback);
	assert.equal(getToolResultModelContent({ version: 1, modelContent: null }, fallback), fallback);
	assert.equal(getToolResultUiContent({ version: 1, modelContent: [], uiContent: null }, fallback), fallback);
	const modelOnly = { version: 1, modelContent: fallback };
	assert.equal(getToolResultModelContent(modelOnly, []), fallback);
	assert.equal(getToolResultUiContent(modelOnly, []), fallback);

	const owner = createToolResultPresentationOwner({ enabled: true })!;
	const presentation = owner.create(fallback)!;
	assert.equal(getToolResultModelContent(presentation, fallback), presentation.modelContent);
	assert.equal(getToolResultUiContent(presentation, fallback), presentation.uiContent);
	owner.release();
	owner.dispose();
});

test("legacy session tool results remain provider-readable without presentation data", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "legacy session result" }];
	const messages = sessionEntryToContextMessages({
		type: "message",
		id: "legacy-entry",
		parentId: null,
		timestamp: "2026-08-30T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "legacy-call",
			toolName: "read",
			content,
			isError: false,
			timestamp: 1,
		},
	});
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.role, "toolResult");
	assert.equal(messages[0]?.role === "toolResult" ? messages[0].content : undefined, content);
});

test("parallel 2/4/8 dispatch scopes have bounded HWM and exact release", () => {
	for (const scopeCount of [2, 4, 8]) {
		const counters = createToolResultPresentationCounters();
		const owner = createToolResultPresentationOwner({ enabled: true, counters })!;
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `parallel-${scopeCount}` }];
		const listenerRetainedPresentations: ToolResultPresentationV1[] = [];
		for (let scope = 0; scope < scopeCount; scope++) {
			listenerRetainedPresentations.push(owner.create(content)!);
		}
		assert.equal(counters.activeDispatchPresentationScopes, scopeCount);
		assert.equal(counters.dispatchPresentationScopesHighWaterMark, scopeCount);
		owner.dispose();
		assert.equal(counters.activeDispatchPresentationScopes, scopeCount);
		assert.equal(counters.completedDispatchPresentationScopes, 0);
		assert.equal(owner.create(content), undefined);
		for (let scope = 0; scope < scopeCount; scope++) owner.release();
		assert.equal(counters.activeDispatchPresentationScopes, 0);
		assert.equal(counters.completedDispatchPresentationScopes, scopeCount);
		assert.equal(counters.releaseWithoutActiveScope, 0);
		assert.equal(listenerRetainedPresentations.length, scopeCount);
		assert.equal(listenerRetainedPresentations[scopeCount - 1]?.modelContent, content);
	}
});
