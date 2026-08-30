import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { getLayoutNode } from "../packages/tui/src/layout-node.ts";
import { LayoutFrameScratch, renderLayoutFrame } from "../packages/tui/src/layout.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { isImageLine, registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class MutableLines implements Component {
	private readonly lines = [""];

	constructor(value: string) {
		this.lines[0] = value;
	}

	set(value: string): void {
		this.lines[0] = value;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function createLayout(itemCount = 100): {
	root: Component;
	active: MutableLines;
	advanceActive(value: string): void;
	instrumentation: TuiRenderInstrumentation;
} {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < itemCount; index++) {
		transcript.addRetainedChild(new MutableLines(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const active = new MutableLines("active-0");
	const retainedActive = transcript.addRetainedChild(active, { id: "active", version: 0 });
	const document = new ViewportContainer();
	document.addChild(transcript);
	const scroll = new ScrollView(document, { follow: "end", primary: true });
	const dock = new VStack([new MutableLines("status"), new MutableLines("footer")]);
	return {
		root: new VStack([
			{ component: scroll, basis: 0, grow: 1, minSize: 1 },
			{ component: dock, basis: "auto", minSize: 1 },
		]),
		active,
		advanceActive(value: string): void {
			active.set(value);
			retainedActive.advanceVersion();
		},
		instrumentation,
	};
}

test("Alt layout scratch remains golden-equivalent and reuses stable full-width rows", () => {
	const candidate = createLayout();
	const reference = createLayout();
	const scratch = new LayoutFrameScratch();
	const renderCandidate = (width: number, height: number) =>
		renderLayoutFrame(candidate.root, width, height, () => {}, scratch);
	const renderReference = (width: number, height: number) =>
		renderLayoutFrame(reference.root, width, height, () => {});

	assert.deepEqual(renderCandidate(120, 40).lines, renderReference(120, 40).lines);
	candidate.advanceActive("active-1");
	reference.advanceActive("active-1");
	const activeFrame = renderCandidate(120, 40);
	assert.deepEqual(activeFrame.lines, renderReference(120, 40).lines);
	assert.ok((activeFrame.fullWidthRowCacheHits ?? 0) > 0);
	assert.ok((activeFrame.stringRepeatCalls ?? 0) <= 1);
	assert.equal(activeFrame.screenArraysCreated, 0);
	assert.equal(activeFrame.fullViewportArrayCopies, 0);
	assert.equal(activeFrame.renderCacheMapsCreated, 0);

	assert.deepEqual(renderCandidate(80, 25).lines, renderReference(80, 25).lines);
	scratch.clear();
	assert.deepEqual(scratch.getRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
	});
});

test("Alt layout scratch preserves Kitty crop semantics and never row-caches image data", () => {
	registerKittyImageMetadata({ imageId: 904, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const imageLine = "\x1b_Ga=T,i=904,r=4;payload\x1b\\";
	const create = (): ScrollView => {
		const transcript = new RetainedContainer();
		for (let index = 0; index < 10; index++) {
			transcript.addRetainedChild(new MutableLines(`prefix-${index}`), {
				id: `prefix-${index}`,
				version: 1,
				completed: true,
			});
		}
		const image: Component = {
			render(): string[] {
				return [imageLine, "", "", "", "after-image"];
			},
			invalidate(): void {},
		};
		transcript.addRetainedChild(image, { id: "image", version: 1, completed: true });
		return new ScrollView(transcript, { follow: "none", primary: true });
	};
	const candidate = create();
	const reference = create();
	const scratch = new LayoutFrameScratch();
	renderLayoutFrame(candidate, 40, 4, () => {}, scratch);
	renderLayoutFrame(reference, 40, 4, () => {});
	candidate.scrollTo(11);
	reference.scrollTo(11);
	const candidateFrame = renderLayoutFrame(candidate, 40, 4, () => {}, scratch);
	const referenceFrame = renderLayoutFrame(reference, 40, 4, () => {});
	assert.deepEqual(candidateFrame.lines, referenceFrame.lines);
	assert.equal(isImageLine(candidateFrame.lines[0] ?? ""), true);
	const secondFrame = renderLayoutFrame(candidate, 40, 4, () => {}, scratch);
	assert.deepEqual(secondFrame.lines, referenceFrame.lines);
	assert.ok((secondFrame.fullWidthRowCacheHits ?? 0) < secondFrame.lines.length);
});

test("Alt layout stable-frame work remains independent of 5k versus 50k history", async () => {
	const run = async (itemCount: number) => {
		const { root, advanceActive, instrumentation } = createLayout(itemCount);
		const terminal = new FakeTerminal(120, 40);
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		tui.setLayoutRoot(root);
		tui.setRenderInstrumentation(instrumentation);
		tui.start();
		tui.renderNow();
		instrumentation.reset();
		advanceActive(`active-${itemCount}`);
		tui.renderNow();
		const metrics = instrumentation.snapshot();
		await tui.stop({ preserveScreen: true });
		return metrics;
	};
	const fiveThousand = await run(5_000);
	const fiftyThousand = await run(50_000);
	for (const key of [
		"altLayoutNodesVisited",
		"altLayoutBoxObjects",
		"altLayoutRectObjects",
		"altLayoutClipObjects",
		"altLayoutPaintBoxCalls",
		"altLayoutChildRenderCalls",
		"viewportItemVisits",
		"viewportCopiedLines",
	] as const) {
		assert.equal(fiftyThousand[key], fiveThousand[key], key);
	}
	assert.equal(fiveThousand.completedItemRenders, 0);
	assert.equal(fiftyThousand.completedItemRenders, 0);
	assert.equal(fiveThousand.fullHistoryFallbacks, 0);
	assert.equal(fiftyThousand.fullHistoryFallbacks, 0);
	assert.equal(fiveThousand.altLayoutFullViewportArrayCopies, 0);
	assert.equal(fiftyThousand.altLayoutFullViewportArrayCopies, 0);
});

test("Alt production frames report fixed layout work and release scratch on stop", async () => {
	const { root, active } = createLayout();
	const terminal = new FakeTerminal(120, 40);
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(root);
	tui.setRenderInstrumentation(instrumentation);
	tui.start();
	try {
		tui.renderNow();
		instrumentation.reset();
		active.set("active-1-中😀e\u0301\x1b[31mansi\x1b[0m");
		tui.renderNow();
		const metrics = instrumentation.snapshot();
		assert.ok(metrics.altLayoutNodesVisited > 0);
		assert.ok(metrics.altLayoutBoxObjects >= metrics.altLayoutNodesVisited);
		assert.ok(metrics.altLayoutRectObjects >= metrics.altLayoutClipObjects);
		assert.equal(metrics.altLayoutRenderCacheMapsCreated, 0);
		assert.equal(metrics.altLayoutNestedRenderCacheMapsCreated, 0);
		assert.equal(metrics.altLayoutScreenArraysCreated, 0);
		assert.equal(metrics.altLayoutFullViewportArrayCopies, 0);
		assert.ok(metrics.altLayoutFullWidthRowCacheHits > 0);
		assert.ok(metrics.altLayoutStringRepeatCalls <= 1);
		assert.equal(metrics.fullSizeFrameCopies, 0);
		assert.equal(metrics.framePromisesCreated, 0);
		assert.equal(metrics.frameAbortControllersCreated, 0);
		assert.equal(metrics.frameWrapperObjectsCreated, 0);
		assert.ok(tui.getAltLayoutRetainedReferenceCounts().cachedRows > 0);
	} finally {
		await tui.stop({ preserveScreen: true });
	}
	assert.deepEqual(tui.getAltLayoutRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
	});
});

test("layout nodes are stable and scratch abort/reentrancy never retains child references", () => {
	const stack = new VStack([new MutableLines("child")]);
	const scroll = new ScrollView(stack, { primary: true });
	assert.equal(getLayoutNode(stack), getLayoutNode(stack));
	assert.equal(getLayoutNode(scroll), getLayoutNode(scroll));

	const scratch = new LayoutFrameScratch();
	const throwing: Component = {
		render(): string[] {
			throw new Error("layout failure");
		},
		invalidate(): void {},
	};
	assert.throws(() => renderLayoutFrame(throwing, 80, 25, () => {}, scratch), /layout failure/);
	assert.deepEqual(scratch.getRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
	});

	let nested = false;
	const reentrant: Component = {
		render(): string[] {
			if (!nested) {
				nested = true;
				assert.deepEqual(renderLayoutFrame(new MutableLines("nested"), 20, 2, () => {}, scratch).lines, [
					"\x1b[0m\x1b]8;;\x07nested              \x1b[0m\x1b]8;;\x07",
					"",
				]);
			}
			return ["outer"];
		},
		invalidate(): void {},
	};
	assert.equal(renderLayoutFrame(reentrant, 20, 2, () => {}, scratch).lines.length, 2);
});

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
	let result: ts.FunctionDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node;
		if (!result) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(result, `${name} must exist`);
	return result;
}

function findMethod(source: ts.SourceFile, className: string, name: string): ts.MethodDeclaration {
	let result: ts.MethodDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isClassDeclaration(node) && node.name?.text === className) {
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(source) === name) result = member;
			}
		}
		if (!result) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(result, `${className}.${name} must exist`);
	return result;
}

test("stable Alt layout hot path has no collection transforms or inline allocation callbacks", () => {
	const layoutPath = "packages/tui/src/layout.ts";
	const altPath = "packages/tui/src/tui-alt-screen.ts";
	const layout = ts.createSourceFile(
		layoutPath,
		readFileSync(layoutPath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const alt = ts.createSourceFile(
		altPath,
		readFileSync(altPath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const targets: Array<{ node: ts.Node; source: ts.SourceFile }> = [
		{ node: findFunction(layout, "renderCached"), source: layout },
		{ node: findFunction(layout, "measureNaturalHeight"), source: layout },
		{ node: findFunction(layout, "layoutComponent"), source: layout },
		{ node: findFunction(layout, "paintBox"), source: layout },
		{ node: findMethod(layout, "LayoutFrameScratch", "begin"), source: layout },
		{ node: findMethod(alt, "TuiAltScreen", "compositeFlashes"), source: alt },
		{ node: findMethod(alt, "TuiAltScreen", "doRender"), source: alt },
	];
	const violations: string[] = [];
	for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
		const target = targets[targetIndex]!;
		function visit(node: ts.Node): void {
			const line = target.source.getLineAndCharacterOfPosition(node.getStart(target.source)).line + 1;
			if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) violations.push(`closure:${line}`);
			if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) violations.push(`spread:${line}`);
			if (ts.isNewExpression(node)) {
				const name = node.expression.getText(target.source);
				if (name === "Promise" || name === "AbortController" || name === "Map" || name === "Set") {
					violations.push(`new ${name}:${line}`);
				}
			}
			if (ts.isCallExpression(node)) {
				const call = node.expression.getText(target.source);
				if (/\.(?:map|filter|flatMap|reduce|slice|bind)$/.test(call) || call === "Array.from") {
					violations.push(`${call}:${line}`);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(target.node);
	}
	assert.deepEqual(violations, []);
	assert.match(findMethod(alt, "TuiAltScreen", "doRender").getText(alt), /this\.layoutScratch/);
});

test("Alt allocation benchmark uses the production fixture and reports dynamic layout counters", () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		scripts: Record<string, string>;
	};
	assert.equal(
		packageJson.scripts["bench:tui-alt-layout-allocations"],
		"node --expose-gc --experimental-strip-types ./scripts/bench/tui-frame-allocations.ts --fixture production-alt",
	);
	const benchmark = readFileSync("scripts/bench/tui-frame-allocations.ts", "utf8");
	assert.match(benchmark, /RetainedContainer/);
	assert.match(benchmark, /ScrollView/);
	assert.match(benchmark, /VStack/);
	assert.match(benchmark, /new TuiAltScreen/);
	assert.match(benchmark, /layoutNodesVisitedPerFrame/);
	assert.match(benchmark, /layoutFullViewportArrayCopiesPerFrame/);
	assert.match(benchmark, /completedItemRendersPerFrame/);
	assert.match(benchmark, /terminalFrameQueueHighWaterMark/);
	assert.match(benchmark, /retainedReferencesAfterDispose/);
});
