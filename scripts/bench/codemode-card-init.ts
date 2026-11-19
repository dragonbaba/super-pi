import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { releaseComponentRenderCaches, type TUI } from "@super-pi/tui";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const count = 8192;
const args = { code: "text(1)" };
const ui = { requestRender() {} } as TUI;
const options = {};
const cwd = process.cwd();

function createCard(index: number) {
	return new ToolExecutionComponent("codemode", String(index), args, options, undefined, ui, cwd);
}

function measure() {
	const cards: ToolExecutionComponent[] = [];
	const refs: WeakRef<ToolExecutionComponent>[] = [];
	const digest = createHash("sha256");
	let fallbackTexts = 0, selfRenderContainers = 0;
	const initialHeap = process.memoryUsage().heapUsed;
	let peakHeap = initialHeap;
	const cpu = process.cpuUsage();
	for (let index = 0; index < count; index++) {
		const card = createCard(index);
		cards.push(card);
		refs.push(new WeakRef(card));
		const shells = card as unknown as { contentText?: unknown; selfRenderContainer?: unknown };
		if (shells.contentText) fallbackTexts++;
		if (shells.selfRenderContainer) selfRenderContainers++;
		if (index % 256 === 255) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
	}
	const constructionCpu = process.cpuUsage(cpu);
	global.gc!();
	const liveHeap = process.memoryUsage().heapUsed;
	for (const card of cards) {
		digest.update(card.render(80).join("\n"));
		releaseComponentRenderCaches(card);
	}
	return { refs, initialHeap, peakHeap, liveHeap, constructionCpu, count, fallbackTexts, selfRenderContainers, digest: digest.digest("hex") };
}

assert.equal(typeof global.gc, "function", "Run with --expose-gc");
initTheme("dark");
for (let index = 0; index < 128; index++) releaseComponentRenderCaches(createCard(index));
global.gc!();
const { refs, ...metrics } = measure();
for (let i = 0; i < 6; i++) { await setImmediate(); global.gc!(); }
let retainedCards = 0;
for (const ref of refs) if (ref.deref()) retainedCards++;
assert.equal(retainedCards, 0);
console.log(JSON.stringify({ ...metrics, retainedCards, heapAfterGc: process.memoryUsage().heapUsed }));
