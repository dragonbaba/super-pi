import { performance } from "node:perf_hooks";
import type { TUI } from "@super-pi/tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Load only the selected implementation, so a baseline process does not retain a
// second, unused candidate module graph during controlled-GC measurements.
const sourceIndex = process.argv.indexOf("--source-root");
const sourceUrl = sourceIndex < 0 ? new URL("../../", import.meta.url).href : pathToFileURL(resolve(process.argv[sourceIndex + 1]!) + "/").href;
const { ToolExecutionComponent }: typeof import("../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts") =
	await import(sourceUrl + "packages/coding-agent/src/modes/interactive/components/tool-execution.ts");
const { initTheme }: typeof import("../../packages/coding-agent/src/modes/interactive/theme/theme.ts") =
	await import(sourceUrl + "packages/coding-agent/src/modes/interactive/theme/theme.ts");
const { RELEASE_COMPONENT_RENDER_CACHE } = await import(sourceUrl + "packages/tui/dist/index.js");

/** Test-owned clock. No production timer replacement or scheduler is introduced. */
export class BashRenderClock {
	private readonly now = Date.now;
	private readonly interval = globalThis.setInterval;
	private readonly clear = globalThis.clearInterval;
	private readonly timers = new Map<unknown, () => void>();
	time = 100_000;
	lastCallback: (() => void) | undefined;
	constructor() {
		Date.now = () => this.time;
		globalThis.setInterval = ((callback: (...args: any[]) => void, _delay: number, ...args: any[]) => {
			const handle = { unref() {} };
			const tick = () => callback(...args);
			this.lastCallback = tick;
			this.timers.set(handle, tick);
			return handle;
		}) as unknown as typeof setInterval;
		globalThis.clearInterval = ((handle: unknown) => { this.timers.delete(handle); }) as typeof clearInterval;
	}
	tick(ms = 1000): void { this.time += ms; for (const callback of this.timers.values()) callback(); }
	get pending(): number { return this.timers.size; }
	dispose(): void {
		Date.now = this.now;
		globalThis.setInterval = this.interval;
		globalThis.clearInterval = this.clear;
		this.timers.clear();
		this.lastCallback = undefined;
	}
}

export function createBashRenderFixture(clock: BashRenderClock, expanded = false, empty = false,
	implementation?: { ToolExecutionComponent: typeof ToolExecutionComponent; initTheme: typeof initTheme; release: symbol }) {
	(implementation?.initTheme ?? initTheme)("dark");
	const ToolComponent = implementation?.ToolExecutionComponent ?? ToolExecutionComponent;
	const release = implementation?.release ?? RELEASE_COMPONENT_RENDER_CACHE;
	const metrics: any = {
		updateDisplayCalls: 0, callRendererCalls: 0, resultRendererCalls: 0, componentCreations: 0,
		renderContextObjects: 0, internalWrapperObjects: 0, imageScans: 0, argsSerializations: 0,
		toolArgsGenerationUpdates: 0, toolArgsReplacementUpdates: 0, toolArgsSemanticFallbackComparisons: 0,
		toolArgsMissingGenerationUpdates: 0, toolArgsFinalizations: 0,
	};
	let notifications = 0;
	const ui = { requestRender() {} } as TUI;
	const component = new ToolComponent("bash", "bash-fixture", { command: "node -e \"" + "// quiet command 中文 😀\n".repeat(100) + "\"" }, {
		allocationMetrics: metrics,
		onVisualInvalidate(c) { notifications++; c.render(120); },
	}, undefined, ui, process.cwd());
	const raw = component as any;
	// Keep the context alive on the baseline too; do not mistake weak-context GC for an optimization.
	let context: any;
	const originalContext = raw.getRenderContext;
	raw.getRenderContext = function (...args: any[]) { context = originalContext.apply(this, args); return context; };
	component.setArgsComplete();
	component.markExecutionStarted();
	const result = { content: [{ type: "text" as const, text: empty ? "" : ("result 中文 😀 " + "x".repeat(100) + "\n").repeat(100) }], isError: false, details: undefined as any };
	component.updateResult(result, true);
	component.setExpanded(expanded);
	component.render(120);
	const bashMetrics = { previewComponentsCreated: 0, timeComponentsCreated: 0, warningComponentsCreated: 0,
		expandedComponentsCreated: 0, timeTextUpdates: 0, warningTextUpdates: 0,
		preparedOutputRecomputations: 0, previewLineRecomputations: 0, failureAnalyses: 0 };
	raw.resultRendererComponent.setAllocationMetrics?.(bashMetrics);
	const call = raw.callRendererComponent;
	let callSetText = 0, callLayouts = 0, callRenderCalls = 0;
	const setText = call.setText, render = call.render;
	call.setText = function (text: string) { callSetText++; return setText.call(this, text); };
	call.render = function (width: number) {
		callRenderCalls++;
		if (!this.cachedLines || this.cachedText !== this.text || this.cachedWidth !== width) callLayouts++;
		return render.call(this, width);
	};
	function identities() {
		const r = raw.resultRendererComponent;
		return { prepared: r.state.preparedContent, lines: r.state.cachedLines, output: empty ? undefined : r.children[0], time: r.children.at(-1) };
	}
	function run(count: number, changeOutput = false, advanceMs = 1000) {
		let prior = identities();
		const beforeCalls = metrics.callRendererCalls, beforeSet = callSetText, beforeLayouts = callLayouts;
		const beforeRender = callRenderCalls, beforeNotifications = notifications;
		let preparedReplacements = 0, lineReplacements = 0, outputReplacements = 0, timeReplacements = 0;
		const durations: number[] = [];
		for (let i = 0; i < count; i++) {
			const start = performance.now();
			if (changeOutput) {
				result.content[0]!.text = result.content[0]!.text.replace(/\nversion:[^\n]*$/, "") + `\nversion:${i}`;
				component.updateResult(result, true);
				component.render(120);
			} else clock.tick(advanceMs);
			durations.push(performance.now() - start);
			const next = identities();
			if (next.prepared !== prior.prepared) preparedReplacements++;
			if (next.lines !== prior.lines) lineReplacements++;
			if (next.output !== prior.output) outputReplacements++;
			if (next.time !== prior.time) timeReplacements++;
			prior = next;
		}
		durations.sort((a, b) => a - b);
		return { updates: count, callRendererCalls: metrics.callRendererCalls - beforeCalls,
			callSetText: callSetText - beforeSet, callLayouts: callLayouts - beforeLayouts,
			callRenderCalls: callRenderCalls - beforeRender, notifications: notifications - beforeNotifications,
			preparedReplacements, lineReplacements, outputReplacements, timeReplacements,
			p95Ms: durations[Math.ceil(count * .95) - 1], maxMs: durations.at(-1) };
	}
	return { component, raw, result, metrics, bashMetrics, run, identities, getContext: () => context,
		dispose() {
			component.updateResult(result, false);
			raw.resultRendererComponent[release]();
			raw[release]();
			context = undefined;
			return raw.resultRendererComponent.getBashResultRenderCacheReferenceCounts();
		} };
}
