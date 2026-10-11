import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Image } from "../../packages/tui/src/components/image.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { Container } from "../../packages/tui/src/tui.ts";
import { getCapabilities, setCapabilities } from "../../packages/tui/src/terminal-image.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";
import { pngFixture } from "../../tests/helpers/image-acceptance-fixtures.ts";
import { currentCommit } from "./benchmark.ts";

assert.equal(typeof globalThis.gc, "function", "requires --expose-gc");
const frames = 2048;
class Terminal extends FakeTerminal {
	uploads = 0;
	placements = 0;
	override write(data: string): void {
		if (data.includes("\x1b_Ga=T")) this.uploads++;
		if (data.includes("\x1b_Ga=p")) this.placements++;
	}
}
class Document extends Container {
	readonly image = new Image(pngFixture(8, 24).toString("base64"), "image/png", { fallbackColor: String }, { maxWidthCells: 2, maxHeightCells: 3 });
	constructor() { super(); this.addChild(this.image); }
	private readonly lines = ["", "covered", "", "outside"];
	tick = 0;
	changedRow = 1;
	override render(width: number): string[] {
		this.lines[0] = this.image.render(width)[0]!;
		this.lines[this.changedRow] = this.tick % 2 ? "active-odd" : "active-even";
		return this.lines;
	}
	override invalidate(): void { this.image.invalidate(); }
}
const inspector = new Session();
inspector.connect();
const previous = getCapabilities();
const pane = process.env.WEZTERM_PANE;
const program = process.env.TERM_PROGRAM;
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
const results = [];
try {
	for (const mode of ["full-wezterm", "full-kitty", "covered-wezterm", "outside-wezterm"] as const) {
		delete process.env.WEZTERM_PANE;
		process.env.TERM_PROGRAM = mode.endsWith("wezterm") ? "WezTerm" : "kitty";
		const terminal = new Terminal(20, 4);
		const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		const metrics = new TuiRenderInstrumentation();
		ui.setRenderInstrumentation(metrics);
		let document: Document | undefined = new Document();
		const weakImage = new WeakRef(document.image);
		document.changedRow = mode.startsWith("outside") ? 3 : 1;
		ui.setLayoutRoot(document);
		try {
			ui.start();
			const full = mode.startsWith("full");
			for (let index = 0; index < 128; index++) { document.tick++; ui.renderNow(full); }
			await ui.flushTerminalFrames();
			metrics.reset(); terminal.uploads = 0; terminal.placements = 0;
			globalThis.gc!();
			const heapBefore = process.memoryUsage().heapUsed;
			let peakHeap = heapBefore;
			await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
			const start = performance.now();
			for (let index = 0; index < frames; index++) {
				document.tick++; ui.renderNow(full);
				if (index % 128 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
			}
			const elapsedMs = performance.now() - start;
			const { profile } = await inspector.post("HeapProfiler.stopSampling");
			await ui.flushTerminalFrames();
			const counters = metrics.snapshot();
			assert.equal(counters.framePromisesCreated, 0);
			assert.equal(counters.frameAbortControllersCreated, 0);
			assert.equal(counters.frameWrapperObjectsCreated, 0);
			assert.equal(counters.fullSizeFrameCopies, 0);
			assert.ok(counters.terminalFrameQueueHighWaterMark <= 2);
			const queueAfterFlush = ui.getTerminalFrameQueueSnapshot();
			assert.equal(queueAfterFlush.activeFrameUtf8Bytes + queueAfterFlush.pendingFrameUtf8Bytes, 0);
			const uploads = terminal.uploads, placements = terminal.placements;
			let sampledBytes = 0;
			const sites: { name: string; url: string; line: number; bytes: number }[] = [];
			const pending = [profile.head];
			while (pending.length) {
				const node = pending.pop()!;
				sampledBytes += node.selfSize;
				if (node.selfSize) sites.push({ name: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, bytes: node.selfSize });
				pending.push(...node.children);
			}
			sites.sort((a, b) => b.bytes - a.bytes);
			ui.setLayoutRoot(undefined);
			ui.renderNow();
			assert.equal((document.image as unknown as { cachedLines?: string[] }).cachedLines, undefined);
			await ui.dispose({ preserveScreen: true });
			const retained = ui.getAltFinalUnmountRetainedReferenceCounts();
			assert.equal(retained.uploadedKittyImages, 0);
			assert.equal(retained.layoutRenderOwnerReferences, 0);
			document = undefined;
			for (let index = 0; index < 8; index++) { await nextTurn(); globalThis.gc!(); }
			const imageCollected = weakImage.deref() === undefined;
			assert.ok(imageCollected);
			results.push({ mode, frames, elapsedMs, sampledBytes, bytesPerFrame: sampledBytes / frames, heapBefore, peakHeap, heapAfterGc: process.memoryUsage().heapUsed, uploads, placements, counters, queueAfterFlush, retained, imageCollected, top: sites.slice(0, 8), profile });
		} finally { await ui.dispose({ preserveScreen: true }); }
	}
	const sourceHashes = Object.fromEntries(["tui-alt-screen.ts", "terminal-image.ts", "regex.ts"].map(file => [file, createHash("sha256").update(readFileSync(`packages/tui/src/${file}`)).digest("hex")]));
	const output = { commit: currentCommit(), node: process.version, platform: process.platform, arch: process.arch, sourceHashes, results };
	if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(output, null, 2));
	console.log(JSON.stringify({ ...output, results: results.map(({ profile, ...result }) => result) }));
} finally {
	inspector.disconnect();
	setCapabilities(previous);
	if (pane === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE = pane;
	if (program === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = program;
}
