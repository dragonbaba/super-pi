import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const OWNER_PATH = "packages/coding-agent/src/core/tool-result-presentation.ts";
const LOOP_PATH = "packages/agent/src/agent-loop.ts";
const SDK_PATH = "packages/coding-agent/src/core/sdk.ts";
const BENCH_PATH = "scripts/bench/tool-result-contextual-budget.ts";

function methodText(sourcePath: string, className: string, methodName: string): string {
	const source = readFileSync(sourcePath, "utf8");
	const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let result = "";
	function visit(node: ts.Node): void {
		if (ts.isClassDeclaration(node) && node.name?.text === className) {
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(ast) === methodName) result = member.getText(ast);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.notEqual(result, "", `${className}.${methodName} was not found`);
	return result;
}

function functionText(sourcePath: string, functionName: string): string {
	const source = readFileSync(sourcePath, "utf8");
	const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let result = "";
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) result = node.getText(ast);
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.notEqual(result, "", `${functionName} was not found`);
	return result;
}

test("contextual coordinator has no full-result copy, serialization, per-result async state, or callback transforms", () => {
	const source = methodText(OWNER_PATH, "ToolResultPresentationOwner", "projectMessagesWithinContextualBudget");
	for (const forbidden of [
		"JSON.stringify",
		"structuredClone",
		"Buffer.from",
		"new Promise",
		"new AbortController",
		"new Map",
		"new Set",
		"ObjectPool",
		".slice(",
		".map(",
		".filter(",
		".flatMap(",
		".every(",
	]) assert.equal(source.includes(forbidden), false, forbidden);
	assert.match(source, /activeContextualCoordinators--/);
	assert.match(source, /finally/);
});

test("agent loop and SDK pass the request envelope without allocating a context wrapper", () => {
	const loop = readFileSync(LOOP_PATH, "utf8");
	const sdk = readFileSync(SDK_PATH, "utf8");
	assert.match(loop, /config\.convertToLlm\(messages, context\.systemPrompt, context\.tools, config\.model\)/);
	assert.match(
		sdk,
		/toolResultPresentationOwner\?\.projectMessagesForModel\(\s*converted,\s*blockImages \? replaceBlockedImages : undefined,\s*systemPrompt,\s*tools,\s*conversionModel\?\.contextWindow,\s*conversionModel\?\.maxTokens/u,
	);
	assert.match(sdk, /convertToLlmWithBlockImages\(messages, systemPrompt, tools, model\)/);
	assert.equal(sdk.includes("ToolResultBudgetContext"), false);
	assert.equal(sdk.includes("LlmConversionContext"), false);
});

test("context estimator scans trailing messages and selected tools without collection transforms", () => {
	const estimatePath = "packages/ai/src/utils/estimate.ts";
	const source = [
		functionText(estimatePath, "estimateContextTokensFromParts"),
		functionText(estimatePath, "estimateAddedToolsTokens"),
		functionText(estimatePath, "wasToolAddedAfterUsage"),
	].join("\n");
	for (const forbidden of ["new Set", ".slice(", ".map(", ".filter(", ".flatMap(", "Array.from("]) {
		assert.equal(source.includes(forbidden), false, forbidden);
	}
});

test("contextual benchmark stamps exact revision, profiles 1/2/4/8 results, and records lifecycle gates", () => {
	const source = readFileSync(BENCH_PATH, "utf8");
	assert.match(source, /benchmark: "tool-result-contextual-budget"/);
	assert.match(source, /commit: git\(\["rev-parse", "HEAD"\]\)/);
	assert.match(source, /worktreeStatus: git\(\["status", "--short"\]\)/);
	assert.match(source, /await measureFixture\(inspector, 1, TEN_MIB_TEXT\)/);
	assert.match(source, /await measureFixture\(inspector, 2, RESULT_TEXT\)/);
	assert.match(source, /await measureFixture\(inspector, 4, RESULT_TEXT\)/);
	assert.match(source, /await measureFixture\(inspector, 8, RESULT_TEXT\)/);
	assert.match(source, /HeapProfiler\.startSampling/);
	assert.match(source, /new WeakRef\(providerMessages\)/);
	assert.match(source, /controlledGcSlopeBytesPerCycle/);
	assert.match(source, /fullResultCopies: 0/);
	assert.match(source, /fullResultSerializations: 0/);
});
