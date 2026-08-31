import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE_PATH = "packages/coding-agent/src/core/tool-result-presentation.ts";
const AGENT_SESSION_SOURCE_PATH = "packages/coding-agent/src/core/agent-session.ts";
const SDK_SOURCE_PATH = "packages/coding-agent/src/core/sdk.ts";
const BENCHMARK_SOURCE_PATH = "scripts/bench/tool-result-budgeted-model-view.ts";

test("presentation core forbids large-result hot-path allocation regressions", () => {
	const source = readFileSync(SOURCE_PATH, "utf8");
	const ast = ts.createSourceFile(SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let arrows = 0;
	let functionExpressions = 0;
	let promiseConstructions = 0;
	let abortControllerConstructions = 0;
	let mapConstructions = 0;
	let setConstructions = 0;
	let objectSpreadAssignments = 0;
	let forbiddenCalls = 0;
	const forbiddenMethods = new Set(["split", "map", "filter", "flatMap", "join", "slice"]);

	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node)) arrows++;
		if (ts.isFunctionExpression(node)) functionExpressions++;
		if (ts.isSpreadAssignment(node)) objectSpreadAssignments++;
		if (ts.isNewExpression(node)) {
			const name = node.expression.getText(ast);
			if (name === "Promise") promiseConstructions++;
			if (name === "AbortController") abortControllerConstructions++;
			if (name === "Map") mapConstructions++;
			if (name === "Set" || name === "WeakMap" || name === "WeakSet") setConstructions++;
		}
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (ts.isPropertyAccessExpression(expression) && forbiddenMethods.has(expression.name.text)) forbiddenCalls++;
			const name = expression.getText(ast);
			if (
				name === "Array.from" ||
				name === "Buffer.from" ||
				name === "JSON.stringify" ||
				name === "String"
			) forbiddenCalls++;
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.equal(arrows, 0, "sourceInvariantArrowFunctions");
	assert.equal(functionExpressions, 0, "sourceInvariantFunctionExpressions");
	assert.equal(promiseConstructions, 0, "sourceInvariantPromiseConstructions");
	assert.equal(abortControllerConstructions, 0, "sourceInvariantAbortControllerConstructions");
	assert.equal(mapConstructions, 1, "sourceInvariantOneSessionLocalProjectionRecordMap");
	assert.equal(setConstructions, 0, "sourceInvariantSetOrGlobalWeakMapConstructions");
	assert.equal(objectSpreadAssignments, 0, "sourceInvariantObjectSpreadAssignments");
	assert.equal(forbiddenCalls, 0, "sourceInvariantFullStringCopiesOrLineArrays");
	assert.equal(source.includes("new String"), false);
	assert.equal(source.includes("ObjectPool"), false);
	assert.equal(source.includes("new Map<string, ProjectionRecord>()"), true);
	assert.equal(source.includes("globalThis"), false, "sourceInvariantNoGlobalProjectionRegistry");
	assert.equal(source.includes("validatedMessages: WeakRef<object>"), true);
	assert.equal(source.includes("validatedMessages === messages"), false);
	assert.equal(source.includes("new Uint32Array(MAX_TERMINAL_SEQUENCE_INTERVALS * 3)"), true);
	assert.equal(source.includes("startsWith(NOTICE_PREFIX + CURSOR_PREFIX)"), false, "sourceInvariantNoUserNoticeTextDiscovery");
	assert.equal(source.includes("Promise.all"), false);
	assert.equal(source.includes("...modelContent"), false);
	assert.equal(source.includes("comparePositions({"), false, "sourceInvariantPerBlockPositionObjects");
});

test("AgentSession isolates the session event and pairs release with a stable owner", () => {
	const source = readFileSync(AGENT_SESSION_SOURCE_PATH, "utf8");
	assert.equal(source.includes("const presentationOwner = this._toolResultPresentation;"), true);
	assert.equal(source.includes("const sessionEvent: Extract<AgentSessionEvent, { type: \"message_end\" }>"), true);
	assert.equal(source.includes("message: event.message"), true);
	assert.equal(source.includes("this._emit(sessionEvent);"), true);
	assert.equal(source.includes("presentationOwner.release();"), true);
	assert.equal(source.includes("this._toolResultPresentation.release()"), false);
	assert.equal(source.includes("Object.assign(event"), false);
	assert.equal(source.includes("Object.defineProperty(event"), false);
	assert.equal(source.includes("event.toolResultPresentation ="), false);
	assert.equal(source.includes("presentationOwner.create(event.message.content, event.message.toolCallId)"), true);
	assert.equal(
		source.match(/this\._toolResultPresentation\?\.clearProjectionRecords\(\);/g)?.length,
		3,
		"sourceInvariantPermanentSessionContextReplacementsClearProjectionRecords",
	);
});

test("SDK binds projection to full source before applying image policy without exposing UI sidecars", () => {
	const source = readFileSync(SDK_SOURCE_PATH, "utf8");
	assert.equal(source.includes("toolResultPresentationOwner?.projectMessagesForModel("), true);
	assert.equal(source.includes("blockImages ? replaceBlockedImages : undefined"), true);
	assert.equal(source.includes("replaceBlockedImagesInMessages(projected)"), true);
	assert.equal(source.includes("enforcePostImagePolicyBudgets"), false);
	assert.equal(source.includes("projectMessagesForModel(imageFiltered)"), false);
	assert.equal(source.includes("toolResultPresentationOwner,"), true);
	assert.equal(source.includes("uiContent"), false);
	assert.equal(source.includes("toolResultPresentation:"), false);
});

test("budgeted model-view benchmark retains the Candidate Gate fixtures and lifecycle evidence", () => {
	const source = readFileSync(BENCHMARK_SOURCE_PATH, "utf8");
	assert.match(source, /const WARMUP_RUNS = 5;/);
	assert.match(source, /const MEASURED_RUNS = 20;/);
	assert.match(source, /samplingInterval: 1024/);
	assert.match(source, /"tiny"/);
	assert.match(source, /"64-kib"/);
	assert.match(source, /"1-mib"/);
	assert.match(source, /"10-mib"/);
	assert.match(source, /"multi-block"/);
	assert.match(source, /"text-plus-image"/);
	assert.match(source, /"ansi-grapheme-adversarial"/);
	assert.match(source, /measureProduction\(inspector, productionRoot, "absent"\)/);
	assert.match(source, /measureProduction\(inspector, productionRoot, "disabled"\)/);
	assert.match(source, /measureProduction\(inspector, productionRoot, "enabled"\)/);
	assert.match(source, /new WeakRef\(presentation\)/);
	assert.match(source, /new WeakRef\(presentation\.modelContent as object\)/);
	assert.match(source, /new WeakRef\(presentation\.uiContent as object\)/);
	assert.match(source, /\[measureParallelScopes\(2\), measureParallelScopes\(4\), measureParallelScopes\(8\)\]/);
	assert.match(source, /measureHistoricalProjection\(inspector, 1\)/);
	assert.match(source, /measureHistoricalProjection\(inspector, 10\)/);
	assert.match(source, /measureHistoricalProjection\(inspector, 100\)/);
	assert.match(source, /measureHistoricalProjection\(inspector, 129\)/);
	assert.match(source, /measureHistoricalProjection\(inspector, 256\)/);
	assert.match(source, /measureRetainedCodeCapacity\(inspector\)/);
	assert.match(source, /measureBlockImagePolicy\(inspector, productionRoot\)/);
	assert.match(source, /measureContinuationChain\(inspector\)/);
	assert.match(source, /measureEvictedContinuation\(inspector\)/);
	assert.match(source, /measureResumedHistoryLookup\(\)/);
	assert.match(source, /"ansi-prefix-1-mib"/);
	assert.match(source, /"ansi-prefix-10-mib"/);
	assert.match(source, /"ansi-small-block-plus-10-mib"/);
	assert.match(source, /"dense-ansi-log"/);
	assert.match(source, /"cjk-1-mib-utf8"/);
	assert.match(source, /"cjk-10-mib-utf8"/);
	assert.match(source, /"combining-256"/);
	assert.match(source, /"zwj-flag-keycap-tag"/);
	assert.match(source, /retainedSourceOuterArrayWeakReferences/);
	assert.match(source, /retainedValidationMessagesOuterArrayWeakReferences/);
	assert.match(source, /heapUsedDelta/);
	assert.match(source, /externalDelta/);
	assert.match(source, /arrayBuffersDelta/);
	assert.match(source, /sourceInvariantFullStringCopies: 0/);
	assert.match(source, /sourceInvariantFullResultSerializations: 0/);
	assert.match(source, /sourceInvariantTemporaryLineArrays: 0/);
	assert.match(source, /sourceInvariantObjectPools: 0/);
});
