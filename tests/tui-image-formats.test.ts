import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as imageModule from "../packages/tui/src/components/image.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { Container } from "../packages/tui/src/tui.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import { Text } from "../packages/tui/src/components/text.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { getCapabilities, getPngDimensions, setCapabilities } from "../packages/tui/src/terminal-image.ts";
import { convertToPngWithLoadedConverter, loadPngConverter } from "../packages/coding-agent/src/utils/image-convert.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const style = { fallbackColor: (text: string) => text };
const png = pngFixture(8, 4).toString("base64");
const setTranscoder = imageModule.setImageTranscoder;

test("direct JPEG, GIF and WebP Images send prepared PNG to Kitty", async t => {
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => { setTranscoder(undefined); setCapabilities(previous); });
	const codec = await loadPngConverter();
	assert.ok(codec);
	const decoded = codec.PhotonImage.new_from_byteslice(Buffer.from(png, "base64"));
	let jpeg: string, webp: string;
	try {
		jpeg = Buffer.from(decoded.get_bytes_jpeg(80)).toString("base64");
		webp = Buffer.from(decoded.get_bytes_webp()).toString("base64");
	} finally { decoded.free(); }
	let calls = 0;
	setTranscoder((data, mime) => { calls++; return convertToPngWithLoadedConverter(codec, data, mime)?.data ?? null; });
	for (const [mime, data] of [["image/jpeg", jpeg], ["image/webp", webp], ["image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"]]) {
		const component = new imageModule.Image(data!, mime!, style);
		const beforeRender = calls;
		const lines = component.render(80);
		const payload = lines[0]!.slice(lines[0]!.indexOf(";") + 1, -2);
		assert.ok(getPngDimensions(payload), `${mime} bytes must actually be PNG`);
		assert.equal(calls, beforeRender, "render cannot transcode");
		assert.equal(component.render(80), lines);
		const id = component.getImageId();
		component.invalidate(); component.render(40);
		assert.equal(component.getImageId(), id);
		assert.equal(calls, beforeRender, "invalidation/resize cannot reconvert prepared content");
	}
	assert.equal(calls, 3);
});

test("PNG, iTerm2 and text-only terminals bypass conversion", t => {
	const previous = getCapabilities();
	t.after(() => { setTranscoder(undefined); setCapabilities(previous); });
	let calls = 0;
	setTranscoder(() => { calls++; throw new Error("unexpected conversion"); });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	assert.ok(new imageModule.Image(png, "image/png", style).render(80)[0]!.includes(`;${png}\x1b\\`));
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	assert.ok(new imageModule.Image("jpeg-source", "image/jpeg", style).render(80).at(-1)!.endsWith(":jpeg-source\x07"));
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	assert.match(new imageModule.Image("jpeg-source", "image/jpeg", style).render(80)[0]!, /Image/);
	assert.equal(calls, 0);
});

test("failed conversion is bounded and retries only after registration and explicit invalidation", t => {
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => { setTranscoder(undefined); setCapabilities(previous); });
	const image = new imageModule.Image("jpeg-source", "image/jpeg", style, {}, { widthPx: 1, heightPx: 8 });
	assert.match(image.render(80)[0]!, /^\[Image:/);
	assert.equal(image.getImageId(), undefined, "fallback allocates no Kitty ID");
	let calls = 0;
	for (const failure of [null, "not-a-png", "throw"] as const) {
		setTranscoder(() => { calls++; if (failure === "throw") throw new Error("decode"); return failure; });
		image.invalidate();
		const prepared = calls;
		for (let index = 0; index < 8; index++) {
			image.invalidate();
			assert.match(image.render(40 + index)[0]!, /^\[Image:/);
		}
		assert.equal(calls, prepared);
	}
	setTranscoder(() => { calls++; return png; });
	assert.match(image.render(80)[0]!, /^\[Image:/, "render does not perform late preparation");
	image.invalidate();
	const rows = image.render(80).length;
	assert.equal(rows, new imageModule.Image(png, "image/png", style).render(80).length, "converted dimensions replace source/EXIF dimensions");
	assert.equal(calls, 4);
	const state = image as unknown as { base64Data: string; mimeType: string };
	assert.equal(state.base64Data, png, "converted content replaces the source reference");
	assert.equal(state.mimeType, "image/png");
});

test("prepared Image survives scroll and cache release, then releases layout/upload ownership", async t => {
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => { setTranscoder(undefined); setCapabilities(previous); });
	let calls = 0;
	setTranscoder(() => { calls++; return png; });
	const terminal = new FakeTerminal(80, 12);
	const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const image = new imageModule.Image("jpeg-source", "image/jpeg", style);
	const document = new Container();
	document.addChild(image); document.addChild(new Text("line\n".repeat(30), 0, 0));
	const scroll = new ScrollView(document, { primary: true });
	ui.setLayoutRoot(new VStack([{ component: scroll, grow: 1, basis: 0 }]));
	try {
		ui.start(); ui.renderNow();
		const id = image.getImageId();
		assert.ok(id);
		scroll.scrollToEnd(); ui.renderNow();
		scroll.scrollToStart(); ui.renderNow();
		assert.equal(image.getImageId(), id);
		image[RELEASE_COMPONENT_RENDER_CACHE]();
		assert.equal((image as unknown as { cachedLines?: string[] }).cachedLines, undefined);
		image.render(80);
		assert.equal(calls, 1);
		ui.setLayoutRoot(new VStack([])); ui.renderNow();
		assert.equal((image as unknown as { cachedLines?: string[] }).cachedLines, undefined);
	} finally { await ui.dispose({ preserveScreen: true }); }
	assert.equal(ui.getAltFinalUnmountRetainedReferenceCounts().uploadedKittyImages, 0);
	assert.equal(ui.getAltFinalUnmountRetainedReferenceCounts().layoutRenderOwnerReferences, 0);
	assert.equal(ui.getTerminalFrameQueueSnapshot().activeFrameUtf8Bytes, 0);
});

test("interactive startup registers the codec before extension session_start", async () => {
	const toolkit = await import("@super-pi/tui");
	const { alphaSession } = await import("./helpers/alpha-session.ts");
	const previous = toolkit.getCapabilities();
	toolkit.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	toolkit.setImageTranscoder(undefined);
	let lines: string[] | undefined;
	let fixture: Awaited<ReturnType<typeof alphaSession>> | undefined;
	try {
		fixture = await alphaSession({ extensions: [(pi: any) => {
			pi.on("session_start", () => {
				lines = new toolkit.Image("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "image/gif", style).render(80);
			});
		}] });
		assert.equal(await fixture.mode.init(), true);
		assert.ok(lines?.[0]?.includes(";iVBORw0KGgo"), "extension gets actual PNG on first construction");
	} finally {
		await fixture?.release();
		toolkit.setImageTranscoder(undefined); toolkit.setCapabilities(previous);
	}
});

test("Image render has no conversion, decoding, closures, promises or controllers", () => {
	const path = "packages/tui/src/components/image.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const imageClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "Image") as ts.ClassDeclaration;
	const render = imageClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "render")!;
	function visit(node: ts.Node): void {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node));
		if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController"].includes(node.expression.getText(source)));
		if (ts.isCallExpression(node)) assert.ok(!["prepareForTerminal", "imageTranscoder", "getPngDimensions", "getImageDimensions", "Buffer.from"].some(name => node.expression.getText(source).endsWith(name)));
		ts.forEachChild(node, visit);
	}
	visit(render);
	const prepare = imageClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "prepareForTerminal")!;
	assert.match(prepare.getText(source), /preparedTranscoderRevision === transcoderRevision/);
	const release = imageClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source).includes("RELEASE_COMPONENT_RENDER_CACHE"))!;
	assert.doesNotMatch(release.getText(source), /prepareForTerminal/);
});
