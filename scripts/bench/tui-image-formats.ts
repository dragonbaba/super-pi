import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as imageModule from "../../packages/tui/src/components/image.ts";
import { getCapabilities, setCapabilities } from "../../packages/tui/src/terminal-image.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { VStack } from "../../packages/tui/src/components/v-stack.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";
import { pngFixture } from "../../tests/helpers/image-acceptance-fixtures.ts";
import { currentCommit } from "./benchmark.ts";

assert.equal(typeof globalThis.gc, "function", "requires --expose-gc");
const output = process.argv[2];
const frames = 2048;
const png = pngFixture(8, 4).toString("base64");
let conversions = 0;
function convert(): string { conversions++; return png; }
const setTranscoder = (imageModule as unknown as { setImageTranscoder?: (fn: typeof convert | undefined) => void }).setImageTranscoder;
class Terminal extends FakeTerminal { override write(): void {} }
class Active {
	private even = ["active-even"];
	private odd = ["active-odd"];
	tick = 0;
	render(): string[] { return this.tick % 2 ? this.odd : this.even; }
	invalidate(): void {}
}
const inspector = new Session();
inspector.connect();
async function sample(run: () => void) {
	globalThis.gc!();
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const start = performance.now();
	run();
	const elapsedMs = performance.now() - start;
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
	let bytes = 0;
	const pending = [profile.head];
	while (pending.length) { const node = pending.pop()!; bytes += node.selfSize; pending.push(...node.children); }
	return { elapsedMs, sampledBytes: bytes, bytesPerOperation: bytes / frames, profile };
}
const previous = getCapabilities();
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
setTranscoder?.(convert);
let ui: TuiAltScreen | undefined;
let image: imageModule.Image | undefined;
let layout: VStack | undefined;
try {
	image = new imageModule.Image(png, "image/jpeg", { fallbackColor: String }, {}, { widthPx: 8, heightPx: 4 });
	const weakImage = new WeakRef(image);
	let lines: string[] | undefined = image.render(80);
	const preparationConversions = conversions;
	const leaf = await sample(() => {
		for (let index = 0; index < frames; index++) assert.equal(image!.render(80), lines);
	});
	const terminal = new Terminal(80, 24);
	ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const metrics = new TuiRenderInstrumentation();
	ui.setRenderInstrumentation(metrics);
	const active = new Active();
	layout = new VStack([image, active]);
	ui.setLayoutRoot(layout);
	ui.start();
	for (let index = 0; index < 128; index++) { active.tick++; ui.requestRender(); ui.renderNow(); }
	await ui.flushTerminalFrames();
	metrics.reset();
	const production = await sample(() => {
		for (let index = 0; index < frames; index++) { active.tick++; ui!.requestRender(); ui!.renderNow(); }
	});
	await ui.flushTerminalFrames();
	const measured = metrics.snapshot();
	assert.equal(conversions, preparationConversions, "no conversion in measured frames");
	assert.equal(measured.framePromisesCreated, 0);
	assert.equal(measured.frameAbortControllersCreated, 0);
	assert.equal(measured.frameWrapperObjectsCreated, 0);
	assert.equal(measured.fullSizeFrameCopies, 0);
	assert.ok(measured.terminalFrameQueueHighWaterMark <= 2);
	ui.setLayoutRoot(new VStack([]));
	ui.renderNow();
	await ui.dispose({ preserveScreen: true });
	const retained = ui.getAltFinalUnmountRetainedReferenceCounts();
	const queue = ui.getTerminalFrameQueueSnapshot();
	assert.equal(retained.uploadedKittyImages, 0);
	assert.equal(queue.activeFrameUtf8Bytes + queue.pendingFrameUtf8Bytes, 0);
	assert.equal((image as unknown as { cachedLines?: string[] }).cachedLines, undefined);
	image = undefined; layout = undefined; lines = undefined;
	for (let index = 0; index < 8; index++) { await nextTurn(); globalThis.gc!(); }
	const imageCollected = weakImage.deref() === undefined;
	assert.ok(imageCollected, "unmounted image owner must be collectible");
	const result = {
		commit: currentCommit(), sourceSha256: createHash("sha256").update(readFileSync("packages/tui/src/components/image.ts")).digest("hex"),
		node: process.version, platform: process.platform, arch: process.arch, frames,
		preparationConversions, measuredConversions: conversions - preparationConversions,
		leaf, production, measured, retained, queue, imageCollected,
	};
	if (output) writeFileSync(output, JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ ...result, leaf: { ...leaf, profile: undefined }, production: { ...production, profile: undefined } }));
} finally {
	await ui?.dispose({ preserveScreen: true });
	inspector.disconnect();
	setTranscoder?.(undefined);
	setCapabilities(previous);
}
