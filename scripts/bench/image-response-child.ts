import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { statSync } from "node:fs";
import assert from "node:assert/strict";
const [root, path, scenario, cancelArg, scheduling] = process.argv.slice(2);
const natural = scheduling === "natural";
process.env.SP_CODING_AGENT_DIR = root; process.env.SP_OFFLINE = "1";
const { alphaSession } = await import("../../tests/helpers/alpha-session.ts");
const { loadPhoton } = await import("../../packages/coding-agent/src/utils/photon.ts");
const f = await alphaSession({ fixtureRoot: root, mode: "fullscreen", sinkDelay: 1, settings: { compaction: { enabled: false }, retry: { enabled: false } } });
await f.mode.init();
if (natural) f.input.write("PROBE_BASE");
await f.internal.ui.flushTerminalFrames();
if (natural) assert.ok(f.internal.renderer.previousScreen.join("\n").includes("PROBE_BASE"), "baseline text was rendered before the probe");
const photon = await loadPhoton(); if (!photon) throw new Error("Photon unavailable");
const wasm = createRequire(import.meta.url)("@silvia-odwyer/photon-node").__wasm;
const handle = await open(path, "r"); const proto = Object.getPrototypeOf(handle); await handle.close();
const saved = { read: proto.read, toString: Buffer.prototype.toString, from: Buffer.from, decode: photon.PhotonImage.new_from_byteslice,
	free: photon.PhotonImage.prototype.free, getBytes: photon.PhotonImage.prototype.get_bytes, projection: f.internal.defaultEditor.setAttachmentText,
	frame: f.terminal.writeFrame, complete: (f.terminal as any).frameWriteCompletionListener };
const stages: Record<string, { count: number; ms: number }> = {};
function stage(name: string, start: number) { const item = stages[name] ??= { count: 0, ms: 0 }; item.count++; item.ms += performance.now() - start; }
const probes: any[] = [], decodes: any[] = []; let nativeActive = 0, nativeHigh = 0, wasmPeak = wasm.memory.buffer.byteLength;
let epoch = 0, receivedAt: number | undefined, frameAt: number | undefined, probeScheduled = false, pendingReadyFrame: number | undefined;
let pendingProbe: any; const workerEvents: any[] = [];
// Diagnostic observation only: preserve production input handling and scheduled rendering.
const editor = f.internal.defaultEditor, ui = f.internal.renderer;
const savedHandleInput = editor.handleInput, savedWriteTerminalFrame = ui.writeTerminalFrame;
let matchingFrameData: string | undefined;
let readyFrameData: string | undefined;
if (natural) {
	editor.handleInput = function (data: string) {
		const probe = pendingProbe;
		if (probe && data === (probe.kind === "cancel" ? "\x03" : "x")) probe.inputArrived = performance.now();
		const result = savedHandleInput.call(this, data);
		if (probe?.inputArrived !== undefined && probe.processed === undefined &&
			(probe.kind === "cancel" ? this.getText() === "" && f.internal.imageDraft.items.length === 0 : this.getText() === "PROBE_BASEx")) {
			probe.processed = performance.now(); probe.acceptedState = this.getText();
		}
		return result;
	};
	ui.writeTerminalFrame = function (data: string, diffLines: number) {
		// nextScreen is the screen used to construct THIS frame, before the production buffer swap.
		// Match that concrete data again at the physical queue sink, including replaced-frame behavior.
		if (pendingProbe?.processed !== undefined && pendingProbe.generation === undefined) {
			const screen = this.nextScreen.join("\n");
			const matches = pendingProbe.kind === "cancel"
				? !screen.includes("PROBE_BASE") && !screen.includes("正在添加") && !screen.includes("未发送")
				: screen.includes("PROBE_BASEx");
			if (matches) { matchingFrameData = data; pendingProbe.matchedState = true; pendingProbe.framePrepared = performance.now(); }
		}
		if (!f.internal.imageDraft.busy && f.internal.imageDraft.items.length && f.internal.imageDraft.items.every((item: any) => item.state === "ready") && this.nextScreen.join("\n").includes("未发送")) readyFrameData = data;
		return savedWriteTerminalFrame.call(this, data, diffLines);
	};
}
function scheduleProbe(start: number) {
	if (probeScheduled) return; probeScheduled = true;
	const probe: any = { planned: start + 5, kind: cancelArg === "true" ? "cancel" : "input" }; probes.push(probe);
	setTimeout(() => {
		probe.callbackAt = performance.now(); probe.handled = probe.callbackAt; pendingProbe = probe; f.input.write(cancelArg === "true" ? "\x03" : "x");
		probe.dispatchReturned = performance.now();
		// Legacy forced measurement: callback arrival and next-generation completion only.
		if (!natural) f.internal.ui.renderNow();
	}, Math.max(0, Math.ceil(probe.planned - performance.now())) + 1);
}
(f.internal.imageDraft as any).decodeObserver = (event: any) => {
	workerEvents.push(event);
	if (event.type === "decode-start") { scheduleProbe(event.at); decodes.push({ start: event.at, end: undefined, terminated: false }); }
	if (event.type === "decode-end") {
		Object.assign(decodes.at(-1), { end: event.at, rss: event.rss, wasmBytes: event.wasmBytes });
		const item = stages.pixelDecode ??= { count: 0, ms: 0 }; item.count++; item.ms += event.elapsed;
		wasmPeak = Math.max(wasmPeak, event.wasmBytes); nativeActive = event.active;
	}
	if (event.type === "worker-exit" && decodes.at(-1)?.end === undefined) Object.assign(decodes.at(-1), { end: event.at, terminated: true });
};
proto.read = async function (...args: any[]) { const start = performance.now(); try { return await saved.read.apply(this, args); } finally { stage("read", start); } };
Buffer.prototype.toString = function (...args: any[]) { const start = performance.now(); try { return saved.toString.apply(this, args as never); } finally { if (args[0] === "base64") stage("base64Encode", start); } };
(Buffer as any).from = function (...args: any[]) { const start = performance.now(); try { return saved.from.apply(Buffer, args as never); } finally { if (args[1] === "base64") stage("base64Decode", start); } };
photon.PhotonImage.new_from_byteslice = function (data: Uint8Array) {
	const start = performance.now(); scheduleProbe(start); let success = false;
	try { const result = saved.decode(data); success = true; nativeActive++; nativeHigh = Math.max(nativeHigh, nativeActive); return result; }
	finally { const end = performance.now(); stage("pixelDecode", start); wasmPeak = Math.max(wasmPeak, wasm.memory.buffer.byteLength); decodes.push({ start, end, success, rss: process.memoryUsage.rss(), wasmBytes: wasm.memory.buffer.byteLength }); }
};
photon.PhotonImage.prototype.free = function () { try { return saved.free.call(this); } finally { nativeActive--; } };
photon.PhotonImage.prototype.get_bytes = function () { const start = performance.now(); try { return saved.getBytes.call(this); } finally { stage("convertPng", start); } };
f.internal.defaultEditor.setAttachmentText = function (text: string) { const start = performance.now(); if (text.includes("未发送")) receivedAt = performance.now(); try { return saved.projection.call(this, text); } finally { stage("uiProjection", start); } };
f.terminal.writeFrame = function (data: string, generation: number) { if (natural ? data === readyFrameData : data.includes("未发送")) pendingReadyFrame = generation; if (pendingProbe && pendingProbe.generation === undefined && (!natural || data === matchingFrameData)) pendingProbe.generation = generation; return saved.frame.call(this, data, generation); };
f.terminal.setFrameWriteCompletionListener((generation, error) => { if (generation === pendingReadyFrame) frameAt = performance.now(); if (generation === pendingProbe?.generation) { pendingProbe.frame = performance.now(); pendingProbe.error = error?.message; pendingProbe = undefined; } saved.complete?.(generation, error); });
global.gc?.(); const before = { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, wasmBytes: wasm.memory.buffer.byteLength };
try {
	epoch = performance.now();
	f.input.write(`\x1b[200~${Array(scenario === "multi" ? 3 : 1).fill(`"${path}"`).join(" ")}\x1b[201~`);
	while (f.internal.imageDraft.busy || (f.internal.imageDraft as any).decoding || f.internal.imageDraft.items.some((item: any) => item.state === "preparing")) await turn();
	const settledAt = performance.now(); if (!probeScheduled) scheduleProbe(settledAt);
	if (natural) {
		const deadline = performance.now() + 3000;
		while (probes[0]?.frame === undefined && performance.now() < deadline) await delay(5);
		if (probes[0]?.processed === undefined || probes[0]?.frame === undefined || !probes[0]?.matchedState) throw new Error("Natural input/frame not observed: " + JSON.stringify(probes));
		if (f.internal.imageDraft.items.some((item: any) => item.state === "ready")) {
			while (frameAt === undefined && performance.now() < deadline) await delay(5);
			assert.notEqual(frameAt, undefined, "ready attachment frame completed naturally");
		}
	} else { await delay(20); await f.internal.ui.flushTerminalFrames(); }
	const state = f.internal.imageDraft.items.map((item: any) => ({ state: item.state, error: item.error }));
	const peak = { maxRssKiB: process.resourceUsage().maxRSS, ...process.memoryUsage(), wasmPeak };
	f.mode.clearEditor(); await f.internal.ui.flushTerminalFrames();
	for (let i = 0; i < 4; i++) { await turn(); global.gc?.(); }
	const after = { ...process.memoryUsage(), wasmBytes: wasm.memory.buffer.byteLength, nativeActive, records: f.internal.imageDraft.items.length };
	console.log(JSON.stringify({ scheduling: natural ? "natural" : "forced", metricDefinition: natural ? "planned/callback/input-handler arrival/state accepted/matching frame write complete" : "handled is probe callback arrival before input.write; frame uses forced render and next generation, not verified state", scenario, cancel: cancelArg === "true", fixtureBytes: statSync(path).size, epoch, receivedAt, frameAt, settledAt, stages,
		probes: probes.map(p => ({ ...p, delayMs: p.callbackAt - p.planned, inputDelayMs: p.processed === undefined ? undefined : p.processed - p.planned, handlerMs: p.processed === undefined ? undefined : p.processed - p.inputArrived, frameDelayMs: p.frame - p.planned, plannedDuringDecode: decodes.some(d => p.planned >= d.start && p.planned <= d.end) })),
		decodes, workerEvents, before, peak, after, parentNativeHigh: nativeHigh, state, sink: "simulated async Writable; real ProcessTerminal/TUI input dispatch, no desktop paint; terminated decode interval ends at worker exit (native function completion/Photon object count unknown)" }));
} finally {
	editor.handleInput = savedHandleInput; ui.writeTerminalFrame = savedWriteTerminalFrame;
	proto.read = saved.read; Buffer.prototype.toString = saved.toString; Buffer.from = saved.from;
	photon.PhotonImage.new_from_byteslice = saved.decode; photon.PhotonImage.prototype.free = saved.free; photon.PhotonImage.prototype.get_bytes = saved.getBytes;
	await f.release();
}
