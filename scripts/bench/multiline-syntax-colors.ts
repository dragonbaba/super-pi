import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getMarkdownTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { renderHighlightedHtml } from "../../packages/coding-agent/src/utils/syntax-highlight.ts";
import { Markdown } from "../../packages/tui/src/components/markdown.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";
import { currentCommit } from "./benchmark.ts";

assert.equal(typeof globalThis.gc, "function", "requires --expose-gc");
const iterations = 1024;
const inspector = new Session();
inspector.connect();
initTheme("dark");
let formatterCalls = 0;
function format(text: string): string { formatterCalls++; return `\x1b[32m${text}\x1b[39m`; }
const leafTheme = { string: format };
let highlightCalls = 0;
const markdownTheme = getMarkdownTheme();
const baseHighlight = markdownTheme.highlightCode!;
function measuredHighlight(code: string, language?: string): string[] { highlightCalls++; return baseHighlight(code, language); }
markdownTheme.highlightCode = measuredHighlight;
class Terminal extends FakeTerminal { override write(): void {} }

async function sample(run: () => void) {
	globalThis.gc!();
	const heapBefore = process.memoryUsage().heapUsed;
	let peakHeap = heapBefore;
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const start = performance.now();
	for (let index = 0; index < iterations; index++) {
		run();
		if (index % 128 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const elapsedMs = performance.now() - start;
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
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
	return { iterations, elapsedMs, sampledBytes, bytesPerOperation: sampledBytes / iterations, heapBefore, peakHeap, top: sites.slice(0, 8), profile };
}

function rendererLifetime(throws: boolean): WeakRef<object> {
	const owner = { marker: "owned-style" };
	const localTheme = { string: (text: string) => {
		if (throws) throw new Error(owner.marker);
		return `${owner.marker}:${renderHighlightedHtml(text)}:end`;
	} };
	try { renderHighlightedHtml('<span class="hljs-string">a\nb</span>', localTheme); }
	catch (error) { assert.ok(throws && error instanceof Error && error.message === owner.marker); }
	return new WeakRef(owner);
}

const results = [];
try {
	for (const html of ['<span class="hljs-string">single line</span>', '<span class="hljs-string">first\n\nsecond\nthird\n</span>']) {
		let outputChars = 0;
		function run(): void { outputChars += renderHighlightedHtml(html, leafTheme).length; }
		for (let index = 0; index < 128; index++) run();
		formatterCalls = 0; outputChars = 0;
		const profile = await sample(run);
		results.push({ kind: html.includes("\n") ? "multiline-helper" : "single-line-helper", ...profile, formatterCalls, outputChars });
	}
	const text = '```python\n"""\nline one\n\nline two\n"""\n';
	const variants = [text + "even\n```", text + "odd\n```"];
	async function productionCase(mode: "main" | "alt") {
		const terminal = new Terminal(80, 24);
		const ui = mode === "main" ? new TuiMainScreen(terminal, false) : new TuiAltScreen(terminal, false, undefined, { mouse: false });
		const metrics = new TuiRenderInstrumentation();
		ui.setRenderInstrumentation(metrics);
		let markdown: Markdown | undefined = new Markdown(variants[0]!, 0, 0, markdownTheme);
		const weak = new WeakRef(markdown);
		if (ui instanceof TuiAltScreen) ui.setLayoutRoot(markdown); else ui.addChild(markdown);
		let tick = 0;
		function run(): void { markdown!.setText(variants[++tick % 2]!); ui.renderNow(); }
		try {
			ui.start();
			for (let index = 0; index < 128; index++) run();
			await ui.flushTerminalFrames();
			metrics.reset(); highlightCalls = 0;
			const profile = await sample(run);
			await ui.flushTerminalFrames();
			const measured = metrics.snapshot();
			assert.equal(highlightCalls, iterations);
			assert.equal(measured.framePromisesCreated, 0);
			assert.equal(measured.frameAbortControllersCreated, 0);
			assert.equal(measured.frameWrapperObjectsCreated, 0);
			assert.equal(measured.fullSizeFrameCopies, 0);
			assert.equal(measured.frameStringsGenerated, iterations);
			assert.ok(measured.terminalFrameQueueHighWaterMark <= 2);
			const queue = ui.getTerminalFrameQueueSnapshot();
			assert.equal(queue.activeFrameUtf8Bytes + queue.pendingFrameUtf8Bytes, 0);
			await ui.dispose({ preserveScreen: true });
			assert.equal((markdown as unknown as { cachedLines?: string[] }).cachedLines, undefined);
			const retained = ui instanceof TuiAltScreen ? ui.getAltFinalUnmountRetainedReferenceCounts() : ui.getMainFinalUnmountRetainedReferenceCounts();
			for (const count of Object.values(retained)) assert.equal(count, 0);
			markdown = undefined;
			return { kind: `production-${mode}`, ...profile, highlightCalls, measured, queue, retained, weak };
		} finally { await ui.dispose({ preserveScreen: true }); }
	}
	for (const mode of ["main", "alt"] as const) {
		const { weak, ...result } = await productionCase(mode);
		for (let index = 0; index < 8; index++) { await nextTurn(); globalThis.gc!(); }
		const markdownCollected = weak.deref() === undefined;
		assert.ok(markdownCollected);
		results.push({ ...result, markdownCollected, heapAfterGc: process.memoryUsage().heapUsed });
	}
	const successfulOwner = rendererLifetime(false), throwingOwner = rendererLifetime(true);
	for (let index = 0; index < 8; index++) { await nextTurn(); globalThis.gc!(); }
	const ownersCollected = successfulOwner.deref() === undefined && throwingOwner.deref() === undefined;
	assert.ok(ownersCollected);
	const sourceHashes = Object.fromEntries(["packages/coding-agent/src/utils/syntax-highlight.ts", "packages/coding-agent/src/modes/interactive/theme/theme.ts"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
	const output = { commit: currentCommit(), node: process.version, platform: process.platform, arch: process.arch, sourceHashes, ownersCollected, results };
	if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(output, null, 2));
	console.log(JSON.stringify({ ...output, results: results.map(({ profile, ...result }) => result) }));
} finally { inspector.disconnect(); }
