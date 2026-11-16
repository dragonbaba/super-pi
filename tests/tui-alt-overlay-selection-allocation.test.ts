import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { compositeTuiLine, type Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { extractAnsiCode, highlightTerminalColumns, sliceByColumn, visibleWidth } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class StableLines implements Component {
	readonly lines: string[];
	renderCalls = 0;

	constructor(line: string) {
		this.lines = [line];
	}

	render(): string[] {
		this.renderCalls++;
		return this.lines;
	}

	invalidate(): void {}
}

function legacyHighlight(text: string): string {
	let result = "\x1b[7m";
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			result += text[index];
			index++;
			continue;
		}
		result += ansi.code;
		if (ansi.code.endsWith("m")) result += "\x1b[7m";
		index += ansi.length;
	}
	return result + "\x1b[27m";
}

function legacySelectedLine(line: string, start: number, end: number, width: number): string {
	const before = sliceByColumn(line, 0, start, true);
	const selected = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, width - end), true);
	return before + legacyHighlight(selected) + after;
}

function findMethod(source: ts.SourceFile, className: string, methodName: string): ts.MethodDeclaration {
	let found: ts.MethodDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isClassDeclaration(node) && node.name?.text === className) {
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(source) === methodName) found = member;
			}
		}
		if (!found) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(found, `${className}.${methodName}`);
	return found;
}

function findFunction(source: ts.SourceFile, functionName: string): ts.FunctionDeclaration {
	let found: ts.FunctionDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) found = node;
		if (!found) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(found, functionName);
	return found;
}

test("Alt overlay and selection frame leaves avoid wrapper and collection allocations", () => {
	const tuiPath = "packages/tui/src/tui.ts";
	const altPath = "packages/tui/src/tui-alt-screen.ts";
	const utilsPath = "packages/tui/src/utils.ts";
	const tui = ts.createSourceFile(tuiPath, readFileSync(tuiPath, "utf8"), ts.ScriptTarget.Latest, true);
	const alt = ts.createSourceFile(altPath, readFileSync(altPath, "utf8"), ts.ScriptTarget.Latest, true);
	const utils = ts.createSourceFile(utilsPath, readFileSync(utilsPath, "utf8"), ts.ScriptTarget.Latest, true);
	const targets: Array<{ node: ts.Node; source: ts.SourceFile }> = [
		{ node: findMethod(tui, "TuiBase", "compositeOverlays"), source: tui },
		{ node: findMethod(tui, "TuiBase", "resolveFakeCursorLine"), source: tui },
		{ node: findFunction(tui, "renderFakeCursor"), source: tui },
		{ node: findMethod(tui, "TuiBase", "compositeLineAt"), source: tui },
		{ node: findMethod(alt, "TuiAltScreen", "applySelection"), source: alt },
		{ node: findMethod(alt, "TuiAltScreen", "resolveSelectionBounds"), source: alt },
		{ node: findMethod(alt, "TuiAltScreen", "resolveSelectionColumns"), source: alt },
		{ node: findFunction(utils, "highlightTerminalColumns"), source: utils },
		{ node: findFunction(utils, "sliceColumns"), source: utils },
		{ node: findFunction(utils, "sliceByColumn"), source: utils },
		{ node: findFunction(utils, "sliceWithWidthInto"), source: utils },
		{ node: findFunction(utils, "findTerminalSequenceEnd"), source: utils },
		{ node: findFunction(utils, "isSimpleTerminalAsciiRun"), source: utils },
		{ node: findFunction(utils, "terminalAsciiFragment"), source: utils },
	];
	const violations: string[] = [];
	for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
		const target = targets[targetIndex]!;
		function visit(node: ts.Node): void {
			const line = target.source.getLineAndCharacterOfPosition(node.getStart(target.source)).line + 1;
			if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) violations.push(`closure:${line}`);
			if (ts.isObjectLiteralExpression(node)) violations.push(`object:${line}`);
			if (ts.isArrayLiteralExpression(node)) violations.push(`array:${line}`);
			if (ts.isRegularExpressionLiteral(node)) violations.push(`regex:${line}`);
			if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) violations.push(`spread:${line}`);
			if (ts.isNewExpression(node)) {
				const name = node.expression.getText(target.source);
				if (name === "Promise" || name === "AbortController" || name === "Map" || name === "Set" || name === "String" || name === "RegExp") {
					violations.push(`new ${name}:${line}`);
				}
			}
			if (ts.isCallExpression(node)) {
				const call = node.expression.getText(target.source);
				if (call === "String" || call === "RegExp") violations.push(`${call}:${line}`);
				if (/\.(?:map|filter|flatMap|reduce|slice|bind)$/.test(call) || call === "Array.from") {
					violations.push(`${call}:${line}`);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(target.node);
	}
	assert.deepEqual(violations, []);
});

test("single-pass selection composition is byte-equivalent for ANSI and Unicode lines", () => {
	for (const fixture of [
		{ line: "plain-ascii", start: 1, end: 7, width: 11 },
		{ line: "\x1b[31mred-中😀e\u0301-tail\x1b[0m", start: 2, end: 9, width: 15 },
		{ line: "a\x1b[1mbold\x1b[0m-z", start: 1, end: 5, width: 8 },
		{ line: "中😀e\u0301-wide", start: 0, end: 5, width: 10 },
	] as const) {
		assert.equal(
			highlightTerminalColumns(fixture.line, fixture.start, fixture.end, fixture.width),
			legacySelectedLine(fixture.line, fixture.start, fixture.end, fixture.width),
			fixture.line,
		);
	}
});

test("single-pass selection composition matches legacy slicing across every cell boundary", () => {
	const lines = [
		"ordinary text with spaces",
		"\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m",
		"中文字符",
		"emoji-👨‍👩‍👧‍👦-😀",
		"combining-e\u0301-o\u0308",
		"\x1b]8;;https://example.com\x07linked-中😀\x1b]8;;\x07-tail",
		"\tA\tplain tail",
		"\x1b[31mplain\ttext\x1b[0m padded tail",
		"\u0600 a\u0301\t中 padded tail",
	] as const;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex]!;
		const width = visibleWidth(line);
		for (let start = 0; start < width; start++) {
			for (let end = start + 1; end <= width; end++) {
				assert.equal(
					highlightTerminalColumns(line, start, end, width),
					legacySelectedLine(line, start, end, width),
					`${lineIndex}:${start}-${end}`,
				);
			}
		}
	}
});

test("ASCII overlay and selection loops collect ranges before materializing bounded fragments", () => {
	const source = ts.createSourceFile("utils.ts", readFileSync("packages/tui/src/utils.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	for (const name of ["extractSegmentsInto", "highlightTerminalColumns"]) {
		const target = findFunction(source, name);
		function inspect(node: ts.Node): void {
			if (ts.isForStatement(node) && node.initializer?.getText(source).includes("textIndex")) {
				function inspectLoop(child: ts.Node): void {
					if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
						&& ["before", "selected", "after"].includes(child.left.getText(source))) violations.push(`${name}:${child.getText(source)}`);
					ts.forEachChild(child, inspectLoop);
				}
				inspectLoop(node.statement);
			} else ts.forEachChild(node, inspect);
		}
		inspect(target);
	}
	assert.deepEqual(violations, []);
});

test("ASCII overlay fragments release direct and pre-sliced oversized sources across the next call", () => {
	const script = `
		import { extractSegments } from './packages/tui/src/utils.ts';
		import { setImmediate as tick } from 'node:timers/promises';
		async function collect() { for (let index = 0; index < 4; index++) { await tick(); globalThis.gc(); } }
		function result(sliced) {
			const source = 'a'.repeat(16 * 1024 * 1024 - 1) + 'z';
			return sliced ? extractSegments(source.substring(0, 120), 80, 100, 20, true) : extractSegments(source, 4, 8, 64, true);
		}
		for (const sliced of [false, true]) {
			await collect(); const before = process.memoryUsage().heapUsed;
			const selected = result(sliced); await collect();
			console.log(JSON.stringify({ sliced, next: false, delta: process.memoryUsage().heapUsed - before, before: selected.before, after: selected.after }));
			extractSegments('next frame', 4, 6, 4, true); await collect();
			console.log(JSON.stringify({ sliced, next: true, delta: process.memoryUsage().heapUsed - before, before: selected.before, after: selected.after }));
		}
	`;
	const run = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: process.cwd(), windowsHide: true, encoding: "utf8", env: process.env });
	assert.equal(run.status, 0, run.stderr);
	const reports = run.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
	assert.equal(reports.length, 4);
	for (const report of reports) {
		assert.equal(report.before, "a".repeat(report.sliced ? 80 : 4));
		assert.equal(report.after, "a".repeat(report.sliced ? 20 : 64));
		assert.ok(report.delta < 4 * 1024 * 1024, `sliced=${report.sliced} next=${report.next} retained source backing: ${report.delta} bytes`);
	}
});

test("timing-only frame benchmark reports unavailable allocation data without omitting frames", () => {
	const run = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/tui-frame-allocations.ts", "--items", "10", "--frames", "4", "--warmup", "1", "--timing-only"], {
		cwd: process.cwd(), windowsHide: true, encoding: "utf8", env: process.env,
	});
	assert.equal(run.status, 0, run.stderr);
	const report = JSON.parse(run.stdout);
	assert.equal(report.allocationSamplingEnabled, false);
	assert.equal(report.metrics.sampledAllocationBytes, null);
	assert.equal(report.metrics.sampledAllocationBytesPerFrame, null);
	assert.equal(report.topAllocationSites, null);
	assert.equal(report.metrics.frameStringsGenerated, 4);
	assert.equal(report.metrics.fullSizeFrameCopies, 0);
	assert.ok(report.metrics.processPeakRssBytes > 0);
	assert.ok(report.metrics.cpuUserMicroseconds >= 0);
	assert.ok(report.metrics.cpuSystemMicroseconds >= 0);
});

class OverlayCompositionHarness extends TuiAltScreen {
	compose(lines: string[], width: number, height: number): string[] {
		return this.compositeOverlays(lines, width, height);
	}
}

test("overlay scratch composition stays byte-equivalent and clears references on success and throw", () => {
	const terminal = new FakeTerminal(40, 6);
	const tui = new OverlayCompositionHarness(terminal, false, undefined, { mouse: false });
	tui.showOverlay(new StableLines("\x1b[33m浮层😀e\u0301\x1b[0m"), { width: 12, row: 2, col: 4 });
	const base = [
		"zero",
		"one",
		"\x1b[31mbase-中文-and-tail\x1b[0m",
		"three",
		"four",
		"five",
	];
	const expected = base.slice();
	expected[2] = compositeTuiLine(expected[2]!, "\x1b[33m浮层😀e\u0301\x1b[0m", 4, 12, 40);
	assert.deepEqual(tui.compose(base.slice(), 40, 6), expected);
	assert.deepEqual(tui.getAltCompositionRetainedReferenceCounts(), {
		overlayLineReferences: 0,
		selectionPointReferences: 0,
	});

	const throwing = new OverlayCompositionHarness(new FakeTerminal(40, 6), false, undefined, { mouse: false });
	throwing.showOverlay({
		render(): string[] { throw new Error("overlay render failure"); },
		invalidate(): void {},
	}, { width: 12, row: 1, col: 1 });
	assert.throws(() => throwing.compose(base.slice(), 40, 6), /overlay render failure/);
	assert.deepEqual(throwing.getAltCompositionRetainedReferenceCounts(), {
		overlayLineReferences: 0,
		selectionPointReferences: 0,
	});
});

async function renderProductionControl(itemCount: number, control: "overlay" | "selection") {
	const terminal = new FakeTerminal(120, 40);
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < itemCount; index++) {
		transcript.addRetainedChild(new StableLines(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new StableLines("\x1b[32mactive-中😀e\u0301\x1b[0m");
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const scroll = new ScrollView(transcript, { follow: "end", primary: true });
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(scroll);
	tui.setRenderInstrumentation(instrumentation);
	tui.start();
	tui.renderNow();
	await tui.flushTerminalFrames();
	if (control === "overlay") {
		tui.showOverlay(new StableLines("overlay-one-中😀e\u0301"), { width: 24, row: 2, col: 3 });
		tui.showOverlay(new StableLines("overlay-two"), { width: 18, row: 4, col: 7 });
	} else {
		const internals = tui as unknown as {
			selectionAnchor?: { row: number; col: number; scrollView: ScrollView };
			selectionFocus?: { row: number; col: number; boundary?: boolean; scrollView: ScrollView };
		};
		internals.selectionAnchor = { row: itemCount - 2, col: 0, scrollView: scroll };
		internals.selectionFocus = { row: itemCount, col: 8, boundary: true, scrollView: scroll };
	}
	instrumentation.reset();
	active.advanceVersion();
	tui.renderNow();
	await tui.flushTerminalFrames();
	const metrics = instrumentation.snapshot();
	const refs = tui.getAltCompositionRetainedReferenceCounts();
	await tui.stop({ preserveScreen: true });
	const stoppedRefs = tui.getAltCompositionRetainedReferenceCounts();
	return { metrics, refs, stoppedRefs, terminalBytes: terminal.bytesWritten };
}

test("production Alt overlay and selection work stays viewport-bounded and clears scratch", async () => {
	for (const control of ["overlay", "selection"] as const) {
		const fiveThousand = await renderProductionControl(5_000, control);
		const fiftyThousand = await renderProductionControl(50_000, control);
		assert.equal(fiveThousand.metrics.completedItemRenders, 0);
		assert.equal(fiftyThousand.metrics.completedItemRenders, 0);
		assert.equal(fiveThousand.metrics.fullHistoryFallbacks, 0);
		assert.equal(fiftyThousand.metrics.fullHistoryFallbacks, 0);
		assert.equal(fiveThousand.metrics.viewportItemVisits, fiftyThousand.metrics.viewportItemVisits);
		assert.equal(fiveThousand.metrics.altLayoutFullViewportArrayCopies, 0);
		assert.equal(fiftyThousand.metrics.altLayoutFullViewportArrayCopies, 0);
		assert.deepEqual(fiveThousand.refs, { overlayLineReferences: 0, selectionPointReferences: 0 });
		assert.deepEqual(fiftyThousand.refs, { overlayLineReferences: 0, selectionPointReferences: 0 });
		assert.deepEqual(fiveThousand.stoppedRefs, { overlayLineReferences: 0, selectionPointReferences: 0 });
		assert.deepEqual(fiftyThousand.stoppedRefs, { overlayLineReferences: 0, selectionPointReferences: 0 });
		assert.ok(fiveThousand.terminalBytes > 0);
		assert.ok(fiftyThousand.terminalBytes > 0);
		if (control === "overlay") {
			assert.equal(fiveThousand.metrics.overlayRenders, 2, JSON.stringify(fiveThousand.metrics));
			assert.equal(fiveThousand.metrics.overlayComposedLines, 2);
			assert.equal(fiftyThousand.metrics.overlayComposedLines, 2);
		} else {
			assert.equal(fiveThousand.metrics.selectionRowsVisited, 3);
			assert.equal(fiveThousand.metrics.selectionComposedLines, 3);
			assert.equal(fiftyThousand.metrics.selectionRowsVisited, 3);
			assert.equal(fiftyThousand.metrics.selectionComposedLines, 3);
		}
	}
});

test("Alt overlay-selection benchmark exposes production controls and truthful counters", () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
	assert.equal(
		packageJson.scripts["bench:tui-alt-overlay-selection"],
		"node --expose-gc --experimental-strip-types ./scripts/bench/tui-frame-allocations.ts --fixture production-alt",
	);
	const benchmark = readFileSync("scripts/bench/tui-frame-allocations.ts", "utf8");
	for (const control of ["overlay-multiple", "selection-multi", "cursor-ime", "mixed"]) {
		assert.match(benchmark, new RegExp(`\\b${control}\\b`));
	}
	for (const metric of [
		"overlayComposedLinesPerFrame",
		"overlayStringRepeatCallsPerFrame",
		"selectionRowsVisitedPerFrame",
		"selectionComposedLinesPerFrame",
		"compositionReferencesAfterDispose",
	]) {
		assert.match(benchmark, new RegExp(`\\b${metric}\\b`));
	}
	assert.match(benchmark, /sourceInvariantOverlayTemporaryArraysPerFrame/);
	assert.match(benchmark, /sourceInvariantSelectionTemporaryArraysPerFrame/);
});
