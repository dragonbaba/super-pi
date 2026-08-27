import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

interface MethodTarget {
	path: string;
	className: string;
	methodName: string;
}

const HOT_METHODS: readonly MethodTarget[] = [
	{ path: "packages/tui/src/terminal.ts", className: "ProcessTerminal", methodName: "writeFrame" },
	{ path: "packages/tui/src/terminal.ts", className: "ProcessTerminal", methodName: "startFrameWrite" },
	{ path: "packages/tui/src/terminal-frame-queue.ts", className: "TerminalFrameQueue", methodName: "submit" },
	{ path: "packages/tui/src/terminal-frame-queue.ts", className: "TerminalFrameQueue", methodName: "start" },
	{ path: "packages/tui/src/terminal-frame-queue.ts", className: "TerminalFrameQueue", methodName: "finish" },
	{ path: "packages/tui/src/terminal-frame-queue.ts", className: "TerminalFrameQueue", methodName: "flush" },
	{ path: "packages/tui/src/tui.ts", className: "TuiBase", methodName: "writeTerminalFrame" },
	{ path: "packages/tui/src/tui.ts", className: "TuiBase", methodName: "requestRender" },
	{ path: "packages/tui/src/tui.ts", className: "TuiBase", methodName: "scheduleRender" },
	{ path: "packages/coding-agent/src/core/agent-session.ts", className: "AgentSession", methodName: "_emit" },
] as const;

const LOW_FREQUENCY_ALLOCATION_EXEMPTIONS = [
	"TuiBase.awaitTerminalBoundary",
	"TuiBase.finishStopAfterFrames",
	"TuiMainScreen.writeRenderDebugLog",
	"AgentSession._emitAgentEnd",
] as const;

const RENDER_SUBMIT_METHODS: readonly MethodTarget[] = [
	{ path: "packages/tui/src/tui-main-screen.ts", className: "TuiMainScreen", methodName: "doRender" },
	{ path: "packages/tui/src/tui-main-screen.ts", className: "TuiMainScreen", methodName: "renderVisibleDocument" },
	{ path: "packages/tui/src/tui-main-screen.ts", className: "TuiMainScreen", methodName: "renderFullFrame" },
	{ path: "packages/tui/src/tui-alt-screen.ts", className: "TuiAltScreen", methodName: "doRender" },
] as const;

function parse(path: string): ts.SourceFile {
	return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function methodNamed(source: ts.SourceFile, className: string, methodName: string): ts.MethodDeclaration {
	let result: ts.MethodDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (
			ts.isClassDeclaration(node) &&
			node.name?.text === className
		) {
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(source) === methodName) result = member;
			}
		}
		if (!result) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(result, `${className}.${methodName} must exist`);
	return result;
}

function collectForbiddenHotNodes(method: ts.MethodDeclaration, source: ts.SourceFile): string[] {
	const violations: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
			violations.push(`inline closure at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isNewExpression(node) && node.expression.getText(source) === "Promise") {
			violations.push(`Promise executor at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isNewExpression(node) && node.expression.getText(source) === "AbortController") {
			violations.push(`AbortController at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isNewExpression(node) && node.expression.getText(source) === "String") {
			violations.push(`new String at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (
			ts.isNewExpression(node) &&
			(node.expression.getText(source) === "Set" || node.expression.getText(source) === "Map")
		) {
			violations.push(`${node.expression.getText(source)} at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
			violations.push(`object/array spread at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const call = node.expression.name.text;
			if (
				(call === "then" || call === "catch" || call === "finally") &&
				node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
			) {
				violations.push(`inline ${call} chain at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
			}
			const owner = node.expression.expression.getText(source);
			if (
				(call === "setTimeout" || call === "nextTick") &&
				node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
			) {
				violations.push(`inline ${call} callback at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
			}
			if (
				(owner === "Buffer" && call === "from") ||
				(owner === "JSON" && call === "stringify") ||
				((owner === "data" || owner === "frame") && call === "slice")
			) {
				violations.push(`${owner}.${call} at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
			}
		}
		if (ts.isCallExpression(node) && node.expression.getText(source) === "String") {
			const argument = node.arguments[0]?.getText(source);
			if (argument === "data" || argument === "frame") {
				violations.push(`String(${argument}) at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
			}
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.getText(source) === "setTimeout" || node.expression.getText(source) === "queueMicrotask") &&
			node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
		) {
			violations.push(`inline ${node.expression.getText(source)} callback at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (ts.isTemplateExpression(node) && /\b(?:data|frame)\b/.test(node.getText(source))) {
			violations.push(`frame template at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
			((node.left.getText(source) === '""' && /^(?:data|frame)$/.test(node.right.getText(source))) ||
				(node.right.getText(source) === '""' && /^(?:data|frame)$/.test(node.left.getText(source))))
		) {
			violations.push(`empty-string frame coercion at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
		}
		ts.forEachChild(node, visit);
	}
	if (method.body) visit(method.body);
	return violations;
}

test("terminal frame hot methods contain no per-frame closures, Promise executors, or AbortControllers", () => {
	for (const target of HOT_METHODS) {
		const source = parse(target.path);
		const method = methodNamed(source, target.className, target.methodName);
		assert.deepEqual(
			collectForbiddenHotNodes(method, source),
			[],
			`${target.className}.${target.methodName} must be allocation-stable`,
		);
	}
	assert.deepEqual(LOW_FREQUENCY_ALLOCATION_EXEMPTIONS, [
		"TuiBase.awaitTerminalBoundary",
		"TuiBase.finishStopAfterFrames",
		"TuiMainScreen.writeRenderDebugLog",
		"AgentSession._emitAgentEnd",
	]);
});

test("frame submit calls use primitive arguments and do not copy full frame strings", () => {
	const paths = [
		"packages/tui/src/tui-main-screen.ts",
		"packages/tui/src/tui-alt-screen.ts",
		"packages/tui/src/tui.ts",
	];
	for (const path of paths) {
		const source = parse(path);
		const violations: string[] = [];
		function visit(node: ts.Node): void {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				(node.expression.name.text === "writeTerminalFrame" || node.expression.name.text === "submit")
			) {
				for (const argument of node.arguments) {
					if (ts.isObjectLiteralExpression(argument) || ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
						violations.push(`${path}:${source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1}`);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		assert.deepEqual(violations, [], `${path} frame submission must use primitive slots`);
	}

	const productionFrameSources = [
		readFileSync("packages/tui/src/terminal.ts", "utf8"),
		readFileSync("packages/tui/src/terminal-frame-queue.ts", "utf8"),
		readFileSync("packages/tui/src/tui.ts", "utf8"),
	].join("\n");
	assert.doesNotMatch(productionFrameSources, /writeFrame\(data,\s*\{\s*signal\s*\}\)/);
	assert.doesNotMatch(productionFrameSources, /new String\(|Buffer\.from\(frame|JSON\.stringify\(frame|String\(frame/);
});

test("Main and Alt render-submit methods satisfy the complete frame hot-path contract", () => {
	for (const target of RENDER_SUBMIT_METHODS) {
		const source = parse(target.path);
		const method = methodNamed(source, target.className, target.methodName);
		assert.deepEqual(
			collectForbiddenHotNodes(method, source),
			[],
			`${target.className}.${target.methodName} must satisfy frame allocation and string gates`,
		);
	}
});

test("frame allocation instrumentation exposes numeric zero-allocation gates", () => {
	const source = readFileSync("packages/tui/src/render-instrumentation.ts", "utf8");
	for (const field of [
		"frameStringsGenerated",
		"frameStringUtf8BytesGenerated",
		"fullSizeFrameCopies",
		"maximumFrameUtf8Bytes",
		"activeFrameUtf8Bytes",
		"pendingFrameUtf8Bytes",
		"framePromisesCreated",
		"frameAbortControllersCreated",
		"frameWrapperObjectsCreated",
	]) {
		assert.match(source, new RegExp(`\\b${field}: number`), `${field} must be a numeric metric`);
	}
});

test("InteractiveMode built-in session delivery is synchronous on message and tool updates", () => {
	const source = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.doesNotMatch(source, /session\.subscribe\(async\s*\(/);
	assert.doesNotMatch(source, /private async handleEvent\(/);
	assert.doesNotMatch(source, /tool_execution_update[\s\S]{0,700}\{\s*\.\.\.event\.partialResult/);
	assert.match(source, /case "agent_end"[\s\S]{0,1400}return this\.[A-Za-z]+/);
});
