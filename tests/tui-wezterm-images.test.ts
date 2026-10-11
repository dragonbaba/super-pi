import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Image } from "../packages/tui/src/components/image.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { Container } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import * as images from "../packages/tui/src/terminal-image.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";

function configure(t: test.TestContext, terminal: "pane" | "program" | "kitty"): void {
	const previous = images.getCapabilities();
	const pane = process.env.WEZTERM_PANE;
	const program = process.env.TERM_PROGRAM;
	delete process.env.WEZTERM_PANE;
	process.env.TERM_PROGRAM = terminal === "program" ? "WezTerm" : "kitty";
	if (terminal === "pane") process.env.WEZTERM_PANE = "0";
	images.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => {
		images.setCapabilities(previous);
		if (pane === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE = pane;
		if (program === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = program;
	});
}

function imageLine(id: number): string {
	images.registerKittyImageMetadata({ imageId: id, columns: 2, rows: 3, widthPx: 8, heightPx: 12 });
	return images.encodeKitty(pngFixture(8, 12).toString("base64"), { imageId: id, columns: 2, rows: 3, moveCursor: false });
}

test("WezTerm full frames place images after clears and text writes", async t => {
	configure(t, "pane");
	const terminal = new FakeTerminal(20, 4);
	const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const line = imageLine(73001);
	ui.setLayoutRoot({ render: () => [line, "covered", "", "after"], invalidate() {} });
	try {
		ui.start(); ui.renderNow();
		const frame = terminal.writes.at(-1)!;
		assert.ok(frame.indexOf("\x1b_Ga=T") > frame.lastIndexOf("\x1b[2K"), "no later EL may erase image cells");
		assert.ok(frame.indexOf("\x1b_Ga=T") > frame.indexOf("covered"), "covered text must precede placement");
		assert.ok(frame.includes("after"));
	} finally { await ui.dispose({ preserveScreen: true }); }
});

test("unchanged image anchors redraw only when their visible rows change", async t => {
	for (const terminalKind of ["program", "kitty"] as const) await t.test(terminalKind, async t => {
		configure(t, terminalKind);
		const terminal = new FakeTerminal(20, 4);
		const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		let anchor = imageLine(73002);
		let covered = "before";
		let outside = "outside";
		ui.setLayoutRoot({ render: () => [anchor, covered, "", outside], invalidate() {} });
		try {
			ui.start(); ui.renderNow();
			covered = "changed"; ui.renderNow();
			const frame = terminal.writes.at(-1)!;
			if (terminalKind === "program") {
				assert.ok(frame.includes(images.deleteAllKittyPlacements()), "unchanged anchor must be restored");
				assert.ok(frame.indexOf("\x1b_Ga=p") > frame.indexOf("changed"));
			} else assert.ok(!frame.includes("\x1b_G"), "ordinary Kitty keeps incremental text frames");
			assert.ok(!frame.includes("\x1b_Ga=T"), "reuse uploaded content");
			outside = "outside-changed"; ui.renderNow();
			assert.ok(!terminal.writes.at(-1)!.includes("\x1b_G"), "outside placement needs no image redraw");
			anchor = images.cropKittyImageLine(anchor, 2, 1); ui.renderNow();
			covered = "below-crop"; ui.renderNow();
			assert.ok(!terminal.writes.at(-1)!.includes("\x1b_G"), "cropped r=1 overrides original metadata rows=3");
		} finally { await ui.dispose({ preserveScreen: true }); }
	});
});

test("WezTerm scroll crops reuse image IDs and clear placements on document replacement", async t => {
	configure(t, "pane");
	const terminal = new FakeTerminal(20, 4);
	const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const image = new Image(pngFixture(8, 32).toString("base64"), "image/png", { fallbackColor: String }, { maxWidthCells: 2, maxHeightCells: 4 });
	const document = new Container();
	document.addChild(image);
	document.addChild({ render: () => ["tail", "tail", "tail", "tail"], invalidate() {} });
	const scroll = new ScrollView(document, { primary: true });
	ui.setLayoutRoot(scroll);
	try {
		ui.start(); ui.renderNow();
		const id = image.getImageId();
		assert.ok(id);
		scroll.scrollTo(1); ui.renderNow();
		const frame = terminal.writes.at(-1)!;
		assert.match(frame, /\x1b_Ga=p[^\x1b]*y=\d+,h=\d+,r=3/);
		assert.ok(!frame.includes("\x1b_Ga=T"));
		assert.ok(frame.indexOf("\x1b_Ga=p") > frame.lastIndexOf("\x1b[2K"));
		scroll.scrollToEnd(); ui.renderNow();
		scroll.scrollToStart(); ui.renderNow();
		assert.equal(image.getImageId(), id);
		assert.ok(!terminal.writes.at(-1)!.includes("\x1b_Ga=T"));
		ui.setLayoutRoot({ render: () => ["replacement"], invalidate() {} }); ui.renderNow();
		assert.ok(terminal.writes.at(-1)!.includes(images.deleteAllKittyPlacements()));
		assert.equal((image as unknown as { cachedLines?: string[] }).cachedLines, undefined);
	} finally { await ui.dispose({ preserveScreen: true }); }
	assert.equal(ui.getAltFinalUnmountRetainedReferenceCounts().uploadedKittyImages, 0);
	assert.equal(ui.getAltFinalUnmountRetainedReferenceCounts().layoutRenderOwnerReferences, 0);
	assert.equal(ui.getTerminalFrameQueueSnapshot().activeFrameUtf8Bytes, 0);
});

test("placement coverage reads explicit crop rows before original metadata and ignores payload controls", () => {
	assert.equal(images.getKittyImagePlacementRows(images.encodeKitty("r=99", { rows: 2 })), 2);
	imageLine(73003);
	assert.equal(images.getKittyImagePlacementRows("\x1b_Ga=T,i=73003;payload\x1b\\"), 3);
	assert.equal(images.getKittyImagePlacementRows("\x1b_Ga=T,i=73003,r=0;payload\x1b\\"), 3);
	assert.equal(images.getKittyImagePlacementRows("\x1b_Ga=T;payload,r=99\x1b\\"), undefined);
	assert.equal(images.getKittyImagePlacementRows("text"), undefined);
});

test("WezTerm redraw uses primitive coverage and no per-frame closures or change arrays", () => {
	const path = "packages/tui/src/tui-alt-screen.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const type = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "TuiAltScreen") as ts.ClassDeclaration;
	const render = type.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "doRender")!;
	function visit(node: ts.Node): void {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node));
		if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Map", "Set"].includes(node.expression.getText(source)));
		if (ts.isCallExpression(node)) assert.doesNotMatch(node.expression.getText(source), /\.(?:map|filter|flatMap|some|slice|bind)$/);
		ts.forEachChild(node, visit);
	}
	visit(render);
	assert.doesNotMatch(render.getText(source), /process\.env/);
});
