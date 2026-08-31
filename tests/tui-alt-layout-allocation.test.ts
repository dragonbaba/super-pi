import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { HStack } from "../packages/tui/src/components/h-stack.ts";
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

class FixedLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class WidthAwareLines implements Component {
	readonly widths: number[] = [];

	render(width: number): string[] {
		this.widths.push(width);
		return [`width-${width}`];
	}

	invalidate(): void {}
}

function createWidthOrder(widthCount: number, order: "increasing" | "decreasing" | "interleaved"): number[] {
	const widths: number[] = [];
	if (order === "increasing") {
		for (let width = 1; width <= widthCount; width++) widths.push(width);
	} else if (order === "decreasing") {
		for (let width = widthCount; width >= 1; width--) widths.push(width);
	} else {
		let low = 1;
		let high = widthCount;
		while (low <= high) {
			widths.push(low++);
			if (low <= high) widths.push(high--);
		}
	}
	const firstPassLength = widths.length;
	for (let index = 0; index < firstPassLength; index++) widths.push(widths[index]!);
	widths.push(widths[0]!);
	return widths;
}

function renderSameComponentWidths(
	widthCount: number,
	order: "increasing" | "decreasing" | "interleaved",
	scratch: LayoutFrameScratch,
): ReturnType<typeof renderLayoutFrame> {
	const component = new WidthAwareLines();
	const widths = createWidthOrder(widthCount, order);
	const rows: Component[] = [];
	for (let index = 0; index < widths.length; index++) {
		rows.push(new HStack([{ component, basis: widths[index]! }]));
	}
	return renderLayoutFrame(
		new VStack(rows),
		widthCount + 1,
		rows.length,
		() => {},
		scratch,
	);
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
	assert.equal(activeFrame.renderCacheIndexActivations, 0);

	assert.deepEqual(renderCandidate(80, 25).lines, renderReference(80, 25).lines);
	scratch.clear();
	assert.deepEqual(scratch.getRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
		sourceCodeUnits: 0,
		paintedCodeUnits: 0,
		maximumRowCodeUnits: 0,
		indexedComponents: 0,
		screenRows: 0,
		screenCodeUnits: 0,
	});
});

test("Alt layout gives extension visibility callbacks a fresh viewport snapshot per frame", async () => {
	const viewports: Array<{ width: number; height: number }> = [];
	const root = new VStack([
		{
			component: new MutableLines("visible"),
			visible(viewport): boolean {
				viewports.push(viewport);
				return true;
			},
		},
		{
			component: new MutableLines("also-visible"),
			visible(viewport): boolean {
				viewports.push(viewport);
				return true;
			},
		},
	]);
	const scratch = new LayoutFrameScratch();
	renderLayoutFrame(root, 120, 40, () => {}, scratch);
	const firstViewport = viewports[0]!;
	assert.equal(firstViewport, viewports[1]);
	viewports.length = 0;
	renderLayoutFrame(root, 200, 60, () => {}, scratch);
	const secondViewport = viewports[0]!;
	assert.equal(secondViewport, viewports[1]);

	assert.notEqual(firstViewport, secondViewport);
	assert.deepEqual(firstViewport, { width: 120, height: 40 });
	assert.deepEqual(secondViewport, { width: 200, height: 60 });

	const otherViewports: Array<{ width: number; height: number }> = [];
	const otherRoot = new VStack([
		{
			component: new MutableLines("other"),
			visible(viewport): boolean {
				otherViewports.push(viewport);
				return true;
			},
		},
	]);
	renderLayoutFrame(otherRoot, 80, 25, () => {}, new LayoutFrameScratch());
	assert.notEqual(secondViewport, otherViewports[0]);
	assert.deepEqual(secondViewport, { width: 200, height: 60 });

	const firstTerminal = new FakeTerminal(120, 40);
	const secondTerminal = new FakeTerminal(80, 25);
	const firstTui = new TuiAltScreen(firstTerminal, false, undefined, { mouse: false });
	const secondTui = new TuiAltScreen(secondTerminal, false, undefined, { mouse: false });
	firstTui.setLayoutRoot(root);
	secondTui.setLayoutRoot(otherRoot);
	firstTui.start();
	secondTui.start();
	try {
		viewports.length = 0;
		otherViewports.length = 0;
		firstTui.renderNow();
		secondTui.renderNow();
		assert.notEqual(viewports[0], otherViewports[0]);
		assert.deepEqual(viewports[0], { width: 120, height: 40 });
		assert.deepEqual(otherViewports[0], { width: 80, height: 25 });
	} finally {
		await firstTui.stop({ preserveScreen: true });
		await secondTui.stop({ preserveScreen: true });
	}
});

test("Alt layout render cache lookup probes scale linearly for large layouts", () => {
	for (const leafCount of [16, 64, 256, 1024]) {
		const children: Component[] = [];
		for (let index = 0; index < leafCount; index++) children.push(new MutableLines(`leaf-${index}`));
		const frame = renderLayoutFrame(new VStack(children), 120, leafCount + 1, () => {}, new LayoutFrameScratch());
		assert.equal(frame.renderCacheRecordCount, leafCount);
		assert.equal(frame.renderCacheIndexActivations, leafCount < 24 ? 0 : 1);
		assert.ok(
			(frame.renderCacheLookupProbes ?? Number.POSITIVE_INFINITY) <= leafCount * 4 + 1024,
			`${leafCount} leaves used ${frame.renderCacheLookupProbes} lookup probes`,
		);
	}

	const repeated = new WidthAwareLines();
	const repeatedChildren: Component[] = [];
	for (let index = 0; index < 64; index++) repeatedChildren.push(repeated);
	const repeatedFrame = renderLayoutFrame(new VStack(repeatedChildren), 120, 64, () => {}, new LayoutFrameScratch());
	assert.equal(repeatedFrame.renderCacheRecordCount, 1);
	assert.deepEqual(repeated.widths, [120]);

	const multiWidth = new WidthAwareLines();
	const multiWidthFrame = renderLayoutFrame(
		new HStack([
			{ component: multiWidth, basis: 20 },
			{ component: multiWidth, basis: 40 },
		]),
		60,
		1,
		() => {},
		new LayoutFrameScratch(),
	);
	assert.equal(multiWidthFrame.renderCacheRecordCount, 2);
	assert.deepEqual(multiWidth.widths, [20, 40]);
});

test("Alt layout bounds lookup work for many widths of the same component", () => {
	const nonlinear: string[] = [];
	for (const widthCount of [8, 16, 32, 64, 256]) {
		for (const order of ["increasing", "decreasing", "interleaved"] as const) {
			const scratch = new LayoutFrameScratch();
			const frame = renderSameComponentWidths(widthCount, order, scratch);
			if ((frame.renderCacheLookupProbes ?? Number.POSITIVE_INFINITY) > widthCount * 32 + 2048) {
				nonlinear.push(`${widthCount}:${order}:${frame.renderCacheLookupProbes}`);
			}
			if (widthCount > 8) assert.ok((frame.renderCacheWidthVariantBypasses ?? 0) > 0);
			assert.ok((frame.renderCacheRecordCount ?? Number.POSITIVE_INFINITY) <= createWidthOrder(widthCount, order).length + 8);
			assert.ok((frame.childRenderCalls ?? Number.POSITIVE_INFINITY) <= widthCount * 8 + 32);
			const retained = scratch.getRetainedReferenceCounts();
			assert.equal(retained.components, 0);
			assert.equal(retained.lines, 0);
			assert.equal(retained.indexedComponents, 0);
			scratch.clear();
		}
	}
	assert.deepEqual(nonlinear, []);
});

test("Alt layout does not retain oversized full-width row strings", () => {
	const hugeOsc = `\x1b]0;${"x".repeat(1024 * 1024)}\x07`;
	const scratch = new LayoutFrameScratch();
	const component = new MutableLines(hugeOsc);
	const hugeFrame = renderLayoutFrame(component, 120, 1, () => {}, scratch);
	assert.ok((hugeFrame.rowCacheRejectedBySize ?? 0) > 0);
	let retained = scratch.getRetainedReferenceCounts();
	assert.equal(retained.sources, 0);
	assert.equal(retained.cachedRows, 0);
	assert.equal(retained.sourceCodeUnits, 0);
	assert.equal(retained.paintedCodeUnits, 0);
	component.set("small");
	renderLayoutFrame(component, 120, 1, () => {}, scratch);
	renderLayoutFrame(component, 120, 1, () => {}, scratch);
	retained = scratch.getRetainedReferenceCounts();
	assert.ok(retained.screenCodeUnits < 1024);
	assert.ok(retained.sourceCodeUnits + retained.paintedCodeUnits <= 512 * 1024);
	scratch.clear();
	assert.deepEqual(scratch.getRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
		sourceCodeUnits: 0,
		paintedCodeUnits: 0,
		maximumRowCodeUnits: 0,
		indexedComponents: 0,
		screenRows: 0,
		screenCodeUnits: 0,
	});
});

test("Alt full-width row cache enforces per-row and total code-unit capacity", () => {
	const tenMiB = "x".repeat(10 * 1024 * 1024);
	const hugeScratch = new LayoutFrameScratch();
	const hugeFrame = renderLayoutFrame(new MutableLines(tenMiB), 120, 1, () => {}, hugeScratch);
	assert.ok((hugeFrame.rowCacheRejectedBySize ?? 0) > 0);
	let retained = hugeScratch.getRetainedReferenceCounts();
	assert.equal(retained.sourceCodeUnits, 0);
	assert.equal(retained.paintedCodeUnits, 0);

	const rows: string[] = [];
	for (let index = 0; index < 140; index++) {
		rows.push(`\x1b]0;${"z".repeat(4000)}-${index}\x07`);
	}
	const totalScratch = new LayoutFrameScratch();
	const first = renderLayoutFrame(new FixedLines(rows), 120, rows.length, () => {}, totalScratch);
	assert.ok((first.rowCacheRejectedBySize ?? 0) > 0);
	retained = totalScratch.getRetainedReferenceCounts();
	assert.ok(retained.sourceCodeUnits + retained.paintedCodeUnits <= 512 * 1024);
	assert.ok(retained.maximumRowCodeUnits <= 64 * 1024);

	const normal = new FixedLines(["alpha", "beta", "gamma"]);
	const normalScratch = new LayoutFrameScratch();
	renderLayoutFrame(normal, 120, 3, () => {}, normalScratch);
	const normalSecond = renderLayoutFrame(normal, 120, 3, () => {}, normalScratch);
	assert.equal(normalSecond.fullWidthRowCacheHits, 3);
	assert.equal(normalSecond.rowCacheRejectedBySize, 0);

	hugeScratch.clear();
	totalScratch.clear();
	normalScratch.clear();
	for (const scratch of [hugeScratch, totalScratch, normalScratch]) {
		assert.equal(scratch.getRetainedReferenceCounts().screenCodeUnits, 0);
		assert.equal(scratch.getRetainedReferenceCounts().sourceCodeUnits, 0);
		assert.equal(scratch.getRetainedReferenceCounts().paintedCodeUnits, 0);
	}
});

test("Alt stop and dispose release oversized screen and row-cache references", async () => {
	const terminal = new FakeTerminal(120, 1);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(new MutableLines(`\x1b]0;${"x".repeat(1024 * 1024)}\x07`));
	tui.start();
	tui.renderNow();
	assert.equal(tui.getAltLayoutRetainedReferenceCounts().sourceCodeUnits, 0);
	assert.ok(tui.getAltLayoutRetainedReferenceCounts().screenCodeUnits > 1024 * 1024);
	await tui.stop({ preserveScreen: true });
	assert.equal(tui.getAltLayoutRetainedReferenceCounts().screenCodeUnits, 0);
	await tui.dispose({ preserveScreen: true });
	assert.deepEqual(tui.getAltLayoutRetainedReferenceCounts(), {
		components: 0,
		lines: 0,
		sources: 0,
		cachedRows: 0,
		sourceCodeUnits: 0,
		paintedCodeUnits: 0,
		maximumRowCodeUnits: 0,
		indexedComponents: 0,
		screenRows: 0,
		screenCodeUnits: 0,
	});
});

test("Alt layout handles asymmetric height resize and documents borrowed frame-line lifetime", () => {
	const lines: string[] = [];
	for (let index = 0; index < 80; index++) lines.push(`row-${index}`);
	const component = new FixedLines(lines);
	const scratch = new LayoutFrameScratch();
	const first = renderLayoutFrame(component, 120, 40, () => {}, scratch);
	assert.deepEqual(first.lines, renderLayoutFrame(component, 120, 40, () => {}).lines);
	const second = renderLayoutFrame(component, 120, 60, () => {}, scratch);
	assert.equal(first.lines.length, 40);
	assert.deepEqual(second.lines, renderLayoutFrame(component, 120, 60, () => {}).lines);
	const third = renderLayoutFrame(component, 120, 40, () => {}, scratch);
	assert.equal(first.lines, third.lines);
	assert.equal(second.lines.length, 60);
	assert.deepEqual(third.lines, renderLayoutFrame(component, 120, 40, () => {}).lines);
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
		"altLayoutRenderCacheLookupProbes",
		"altLayoutRenderCacheRecordCount",
		"altLayoutRenderCacheIndexActivations",
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
		assert.equal(metrics.altLayoutRenderCacheIndexActivations, 0);
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
		sourceCodeUnits: 0,
		paintedCodeUnits: 0,
		maximumRowCodeUnits: 0,
		indexedComponents: 0,
		screenRows: 0,
		screenCodeUnits: 0,
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
		sourceCodeUnits: 0,
		paintedCodeUnits: 0,
		maximumRowCodeUnits: 0,
		indexedComponents: 0,
		screenRows: 0,
		screenCodeUnits: 0,
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

	const largeChildren: Component[] = [];
	for (let index = 0; index < 64; index++) largeChildren.push(new MutableLines(`child-${index}`));
	largeChildren.push(throwing);
	assert.throws(() => renderLayoutFrame(new VStack(largeChildren), 80, 65, () => {}, scratch), /layout failure/);
	assert.equal(scratch.getRetainedReferenceCounts().indexedComponents, 0);
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
	const layoutText = layout.getFullText();
	const altText = alt.getFullText();
	assert.match(layoutText, /renderComponents: Array<Component \| undefined>/);
	assert.match(layoutText, /renderLines: Array<string\[\] \| undefined>/);
	assert.match(layoutText, /visibleEntries: Array<StackLayoutEntry \| undefined>/);
	assert.doesNotMatch(layoutText, /undefined as unknown as/);
	assert.doesNotMatch(altText, /undefined as unknown as/);
	assert.match(layoutText, /Math\.max\(this\.sourceA\.length, this\.sourceB\.length\)/);
	assert.doesNotMatch(layoutText, /renderCacheMapsCreated|nestedRenderCacheMapsCreated/);
	const renderCachedText = findFunction(layout, "renderCached").getText(layout);
	assert.doesNotMatch(renderCachedText, /new Map|\{\s*component[,}]/);
	assert.match(layoutText, /MAX_RENDER_CACHE_WIDTH_VARIANTS = 8/);
	assert.match(renderCachedText, /RENDER_CACHE_WIDTH_VARIANTS_UNCACHEABLE/);
	const activateIndexText = findFunction(layout, "activateRenderCacheIndex").getText(layout);
	assert.equal(activateIndexText.match(/new Map</g)?.length, 1);
	assert.match(findMethod(layout, "LayoutFrameScratch", "releaseTransientReferences").getText(layout), /renderCacheIndex\?\.clear\(\)/);
	const visibleViewportText = findFunction(layout, "getVisibleViewport").getText(layout);
	assert.equal(visibleViewportText.match(/\{ width: context\.viewportWidth, height: context\.viewportHeight \}/g)?.length, 1);
	assert.doesNotMatch(visibleViewportText, /Object\.freeze|Object\.assign|\.\.\./);
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
	assert.match(benchmark, /layoutRenderCacheLookupProbesPerFrame/);
	assert.match(benchmark, /layoutRenderCacheIndexActivationsPerFrame/);
	assert.match(benchmark, /layoutCachedSourceCodeUnitsPerFrame/);
	assert.match(benchmark, /layoutRowCacheRejectedBySizePerFrame/);
	assert.match(benchmark, /sourceInvariantNestedRenderCacheMapsPerFrame/);
	assert.match(benchmark, /completedItemRendersPerFrame/);
	assert.match(benchmark, /terminalFrameQueueHighWaterMark/);
	assert.match(benchmark, /lifecycleHeapSlopeBytesPerCycle/);
	assert.match(benchmark, /lifecycleMaximumRetainedReferencesAfterDispose/);
	assert.match(benchmark, /retainedReferencesAfterDispose/);
});
