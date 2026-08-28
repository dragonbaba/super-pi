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
	{ path: "packages/tui/src/tui.ts", className: "TuiBase", methodName: "compositeOverlays" },
	{ path: "packages/tui/src/terminal.ts", className: "ProcessTerminal", methodName: "setProgress" },
	{ path: "packages/tui/src/terminal.ts", className: "ProcessTerminal", methodName: "startProgressWrite" },
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

test("ProcessTerminal drainInput uses stable cycle callbacks without polling closures", () => {
	const path = "packages/tui/src/terminal.ts";
	const source = parse(path);
	const drainInput = methodNamed(source, "ProcessTerminal", "drainInput");
	const scheduleTimer = methodNamed(source, "ProcessTerminal", "scheduleDrainInputTimer");
	let inlineClosures = 0;
	let whileLoops = 0;
	let promiseExecutors = 0;
	let stablePromiseExecutors = 0;
	let inlineTimerCallbacks = 0;
	let stableTimerCallbacks = 0;
	let generationTimerArguments = 0;
	const inspect = (node: ts.Node): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) inlineClosures++;
		if (ts.isWhileStatement(node) || ts.isDoStatement(node)) whileLoops++;
		if (ts.isNewExpression(node) && node.expression.getText(source) === "Promise") {
			promiseExecutors++;
			if (node.arguments?.[0]?.getText(source) === "this.captureDrainInputResolve") stablePromiseExecutors++;
		}
		if (ts.isCallExpression(node) && node.expression.getText(source) === "setTimeout") {
			const callback = node.arguments[0];
			if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) inlineTimerCallbacks++;
			if (callback?.getText(source) === "this.onDrainInputTimer") stableTimerCallbacks++;
			if (node.arguments[2]?.getText(source) === "generation") generationTimerArguments++;
		}
		ts.forEachChild(node, inspect);
	};
	inspect(drainInput);
	inspect(scheduleTimer);
	assert.equal(inlineClosures, 0);
	assert.equal(whileLoops, 0);
	assert.equal(promiseExecutors, 1);
	assert.equal(stablePromiseExecutors, 1);
	assert.equal(inlineTimerCallbacks, 0);
	assert.equal(stableTimerCallbacks, 1);
	assert.equal(generationTimerArguments, 1);
	assert.doesNotMatch(drainInput.getText(source), /async\s+drainInput/);
	assert.doesNotMatch(drainInput.getText(source), /await\s+/);
	assert.match(drainInput.getText(source), /validateDrainDuration\("maxMs", maxMs\)/);
	assert.match(drainInput.getText(source), /validateDrainDuration\("idleMs", idleMs\)/);
	assert.match(drainInput.getText(source), /generation = \+\+this\.drainGeneration/);
	assert.doesNotMatch(`${drainInput.getText(source)}\n${scheduleTimer.getText(source)}`, /Date\.now\(\)/);
});

test("ProcessTerminal input setup and keyboard fragment scheduling use stable callbacks", () => {
	const path = "packages/tui/src/terminal.ts";
	const text = readFileSync(path, "utf8");
	const source = parse(path);
	const setup = methodNamed(source, "ProcessTerminal", "setupStdinBuffer");
	const schedule = methodNamed(source, "ProcessTerminal", "scheduleKeyboardProtocolNegotiationBufferFlush");
	let inlineClosures = 0;
	let inlineTimerCallbacks = 0;
	let stableTimerCallbacks = 0;
	const inspect = (node: ts.Node): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) inlineClosures++;
		if (ts.isCallExpression(node) && node.expression.getText(source) === "setTimeout") {
			const callback = node.arguments[0];
			if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) inlineTimerCallbacks++;
			if (callback?.getText(source) === "this.onKeyboardProtocolNegotiationBufferFlush") stableTimerCallbacks++;
		}
		ts.forEachChild(node, inspect);
	};
	inspect(setup);
	inspect(schedule);
	assert.equal(inlineClosures, 0);
	assert.equal(inlineTimerCallbacks, 0);
	assert.equal(stableTimerCallbacks, 1);
	assert.match(setup.getText(source), /this\.stdinBuffer\.on\("data", this\.onStdinBufferData\)/);
	assert.match(setup.getText(source), /this\.stdinBuffer\.on\("paste", this\.onStdinBufferPaste\)/);
	assert.doesNotMatch(text, /private writeLogPath\s*=\s*\(\(\)\s*=>/);
	assert.match(text, /private writeLogPath\s*=\s*resolveTerminalWriteLogPath\(\)/);
});

test("terminal lifecycle installs stable input and resize forwarding callbacks", () => {
	const terminalPath = "packages/tui/src/terminal.ts";
	const terminalSource = parse(terminalPath);
	const processStart = methodNamed(terminalSource, "ProcessTerminal", "start");
	const tuiPath = "packages/tui/src/tui.ts";
	const tuiSource = parse(tuiPath);
	const tuiStart = methodNamed(tuiSource, "TuiBase", "start");
	let inlineClosures = 0;
	const inspect = (node: ts.Node): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) inlineClosures++;
		ts.forEachChild(node, inspect);
	};
	inspect(processStart);
	inspect(tuiStart);
	assert.equal(inlineClosures, 0);
	assert.match(tuiStart.getText(tuiSource), /this\.terminal\.start\(this\.onTerminalInput, this\.onTerminalResize\)/);
	assert.doesNotMatch(tuiStart.getText(tuiSource), /this\.terminal\.start\(\s*\(/);
});

test("Windows VT restart reuses one lazily resolved native helper", () => {
	const terminalPath = "packages/tui/src/terminal.ts";
	const terminalText = readFileSync(terminalPath, "utf8");
	const terminalSource = parse(terminalPath);
	const enableWindows = methodNamed(terminalSource, "ProcessTerminal", "enableWindowsVTInput");
	const nativeText = readFileSync("packages/tui/src/native-modifiers.ts", "utf8");
	assert.equal(enableWindows.getText(terminalSource).match(/enableNativeWindowsVirtualTerminalInput\(\)/g)?.length, 1);
	assert.doesNotMatch(enableWindows.getText(terminalSource), /fileURLToPath|path\.join|candidates|createRequire|\[\s*path\./);
	assert.doesNotMatch(terminalText, /const candidates\s*=\s*\[/);
	assert.match(nativeText, /if \(nativeModifiersHelper !== undefined\) return nativeModifiersHelper \?\? undefined/);
	assert.doesNotMatch(nativeText, /const candidates\s*=\s*\[/);
});

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

test("stop-pending terminal input admission is an ordered primitive-only branch", () => {
	const source = parse("packages/tui/src/tui.ts");
	const method = methodNamed(source, "TuiBase", "handleTerminalInput");
	const statements = method.body?.statements;
	assert.ok(statements);
	assert.match(statements[0]!.getText(source), /^if \(this\.consumeOsc11BackgroundResponse\(data\)\)/);
	assert.match(statements[1]!.getText(source), /^if \(this\.consumeTerminalColorSchemeReport\(data\)\)/);
	const admissionGuard = statements[2]!;
	assert.equal(admissionGuard.getText(source), "if (this.stopping || this.stopped) {\n\t\t\treturn;\n\t\t}");

	const forbidden: string[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isNewExpression(node) ||
			ts.isObjectLiteralExpression(node) ||
			ts.isArrayLiteralExpression(node) ||
			ts.isRegularExpressionLiteral(node) ||
			ts.isTemplateExpression(node)
		) {
			forbidden.push(ts.SyntaxKind[node.kind]);
		}
		ts.forEachChild(node, visit);
	}
	visit(admissionGuard);
	assert.deepEqual(forbidden, []);
	let listenerLoop: ts.ForOfStatement | undefined;
	function findListenerLoop(node: ts.Node): void {
		if (ts.isForOfStatement(node) && node.expression.getText(source) === "this.inputListeners") {
			listenerLoop = node;
			return;
		}
		ts.forEachChild(node, findListenerLoop);
	}
	findListenerLoop(method);
	assert.ok(listenerLoop);
	assert.ok(ts.isBlock(listenerLoop.statement));
	const listenerStatements = listenerLoop.statement.statements;
	assert.equal(listenerStatements[0]?.getText(source), "const result = listener(current);");
	const listenerAdmissionGuard = listenerStatements[1]!;
	assert.equal(
		listenerAdmissionGuard.getText(source),
		"if (this.stopping || this.stopped) {\n\t\t\t\t\treturn;\n\t\t\t\t}",
	);
	assert.match(listenerStatements[2]?.getText(source) ?? "", /^if \(result\?\.consume\)/);
	assert.match(listenerStatements[3]?.getText(source) ?? "", /^if \(result\?\.data !== undefined\)/);
	forbidden.length = 0;
	visit(listenerAdmissionGuard);
	assert.deepEqual(forbidden, []);

	const body = method.getText(source);
	assert.match(body, /data = current;\s*}\s*if \(this\.stopping \|\| this\.stopped\) \{\s*return;\s*}/);
	assert.match(
		body,
		/focusedComponent\.handleInput\(data\);\s*if \(this\.stopping \|\| this\.stopped\) \{\s*return;\s*}\s*\/\/ Keyboard input/,
	);
});

test("mode switch validates renderer identity and lifecycle generation after stop", () => {
	const source = parse("packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const switchMethod = methodNamed(source, "InteractiveMode", "switchTuiMode");
	const switchBody = switchMethod.getText(source);
	const stopBoundary = switchBody.indexOf("await previousUi.stop({ preserveScreen: true });");
	const identityGuard = switchBody.indexOf(
		"if (this.renderer !== previousUi || this.tuiLifecycleGeneration !== lifecycleGeneration)",
	);
	const firstCleanup = switchBody.indexOf("previousUi.setFocus(null);");
	const childrenSnapshot = switchBody.indexOf("const components = [...previousUi.children];");
	const focusSnapshot = switchBody.indexOf("const focus = previousUi.getFocusedComponent();");
	const terminalSnapshot = switchBody.indexOf("const terminal = previousUi.terminal;");
	const renderStateSnapshot = switchBody.indexOf("previousUi.captureRenderState();");
	assert.ok(stopBoundary >= 0);
	assert.ok(identityGuard > stopBoundary);
	assert.ok(childrenSnapshot > identityGuard);
	assert.ok(focusSnapshot > identityGuard);
	assert.ok(terminalSnapshot > identityGuard);
	assert.ok(renderStateSnapshot > identityGuard);
	assert.ok(firstCleanup > identityGuard);
	assert.match(switchBody, /const lifecycleGeneration = this\.tuiLifecycleGeneration;/);
	assert.doesNotMatch(
		switchBody.slice(0, identityGuard),
		/\.\.\.previousUi\.children|getFocusedComponent|getShowHardwareCursor|getClearOnShrink|captureRenderState/,
	);

	const stopMethod = methodNamed(source, "InteractiveMode", "stop");
	assert.equal(stopMethod.body?.statements[0]?.getText(source), "this.tuiLifecycleGeneration++;");
	const shutdownMethod = methodNamed(source, "InteractiveMode", "shutdown");
	assert.match(
		shutdownMethod.getText(source),
		/this\.isShuttingDown = true;\s*this\.tuiLifecycleGeneration\+\+;/,
	);
});

test("terminal lifecycle entry points have primitive admission or post-stop ownership checks", () => {
	const source = parse("packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const sourceText = source.getText();
	const ctrlZ = methodNamed(source, "InteractiveMode", "handleCtrlZ").getText(source);
	const externalEditor = methodNamed(source, "InteractiveMode", "handleOpenExternalEditor").getText(source);
	const stopInteractive = methodNamed(source, "InteractiveMode", "stopInteractiveTui").getText(source);
	const stop = methodNamed(source, "InteractiveMode", "stop").getText(source);
	const shutdown = methodNamed(source, "InteractiveMode", "shutdown").getText(source);

	const ctrlZStop = ctrlZ.indexOf("await this.ui.stop();");
	const externalEditorStop = externalEditor.indexOf("await this.ui.stop();");
	assert.ok(ctrlZStop > 0);
	assert.ok(externalEditorStop > 0);
	assert.doesNotMatch(ctrlZ.slice(0, ctrlZStop), /\bawait\b/);
	assert.doesNotMatch(externalEditor.slice(0, externalEditorStop), /\bawait\b/);
	assert.equal(sourceText.match(/this\.handleCtrlZ\(\)/g)?.length, 1);
	assert.equal(sourceText.match(/this\.handleOpenExternalEditor\(\)/g)?.length, 1);
	assert.match(sourceText, /defaultEditor\.onAction\("app\.suspend", this\.handleSuspendAction\)/);
	assert.match(sourceText, /defaultEditor\.onAction\("app\.editor\.external", this\.handleExternalEditorAction\)/);
	assert.match(stopInteractive, /await this\.switchTuiMode\("regular", false, false\)/);
	assert.match(stop, /this\.tuiLifecycleGeneration\+\+;[\s\S]*await this\.stopInteractiveTui/);
	assert.match(shutdown, /this\.tuiLifecycleGeneration\+\+;[\s\S]*await this\.ui\.terminal\.drainInput/);
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
