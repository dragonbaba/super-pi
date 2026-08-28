import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createInteractiveTuiReference } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import type { Component, OverlayHandle, TUI, TuiInputListener } from "../packages/tui/src/tui.ts";

type Harness = TUI & {
	requestRenderCalls: number;
	renderNowCalls: number;
	invalidateCalls: number;
	removedListeners: TuiInputListener[];
	stopResult: Promise<void>;
	disposeResult: Promise<void>;
	flushResult: Promise<void>;
	overlayHandle: OverlayHandle;
};

function createHarness(mode: "regular" | "fullscreen"): Harness {
	const listeners = new Set<TuiInputListener>();
	const overlayHandle = {
		hide(): void {}, setHidden(): void {}, isHidden(): boolean { return false; },
		focus(): void {}, unfocus(): void {}, isFocused(): boolean { return false; },
	} as OverlayHandle;
	const harness = {
		mode,
		children: [] as Component[],
		terminal: { mode } as never,
		onDebug: undefined,
		fullRedraws: 0,
		requestRenderCalls: 0,
		renderNowCalls: 0,
		invalidateCalls: 0,
		removedListeners: [] as TuiInputListener[],
		stopResult: Promise.resolve(),
		disposeResult: Promise.resolve(),
		flushResult: Promise.resolve(),
		overlayHandle,
		addChild(component: Component): void { this.children.push(component); },
		removeChild(component: Component): void { const index = this.children.indexOf(component); if (index >= 0) this.children.splice(index, 1); },
		clear(): void { this.children.length = 0; },
		invalidate(): void { this.invalidateCalls++; },
		render(): string[] { return []; },
		getShowHardwareCursor(): boolean { return false; }, setShowHardwareCursor(): void {},
		getClearOnShrink(): boolean { return true; }, setClearOnShrink(): void {},
		setRenderInstrumentation(): void {}, setFocus(): void {},
		showOverlay(): OverlayHandle { return this.overlayHandle; }, hideOverlay(): void {}, hasOverlay(): boolean { return false; },
		start(): void {}, stop(): Promise<void> { return this.stopResult; }, dispose(): Promise<void> { return this.disposeResult; },
		renderNow(): void { this.renderNowCalls++; }, requestRender(): void { this.requestRenderCalls++; },
		flushTerminalFrames(): Promise<void> { return this.flushResult; },
		addInputListener(listener: TuiInputListener): () => void { listeners.add(listener); return () => listeners.delete(listener); },
		removeInputListener(listener: TuiInputListener): void { listeners.delete(listener); this.removedListeners.push(listener); },
		onTerminalColorSchemeChange(): () => void { return () => {}; }, setTerminalColorSchemeNotifications(): void {},
		async queryTerminalBackgroundColor(): Promise<undefined> { return undefined; },
		async queryTerminalColorScheme(): Promise<undefined> { return undefined; },
	};
	return harness as unknown as Harness;
}

test("stable interactive TUI methods preserve identity and follow renderer replacement", () => {
	const main = createHarness("regular");
	const alt = createHarness("fullscreen");
	let current: TUI = main;
	const reference = createInteractiveTuiReference(() => current);
	const requestRender = reference.requestRender;
	const renderNow = reference.renderNow;
	const invalidate = reference.invalidate;
	assert.equal(reference.requestRender, requestRender);
	assert.equal(reference.renderNow, renderNow);
	assert.equal(reference.invalidate, invalidate);
	const identities = new Set<TUI["requestRender"]>();
	for (let index = 0; index < 100_000; index++) identities.add(reference.requestRender);
	assert.equal(identities.size, 1);
	requestRender();
	current = alt;
	requestRender();
	renderNow();
	invalidate();
	assert.equal(main.requestRenderCalls, 1);
	assert.equal(alt.requestRenderCalls, 1);
	assert.equal(alt.renderNowCalls, 1);
	assert.equal(alt.invalidateCalls, 1);
	assert.equal(reference.mode, "fullscreen");
	assert.equal(reference.terminal, alt.terminal);
	assert.equal(reference.children, alt.children);
	assert.equal(reference.showOverlay(main), alt.overlayHandle);
	assert.equal(reference.stop(), alt.stopResult);
	assert.equal(reference.dispose(), alt.disposeResult);
	assert.equal(reference.flushTerminalFrames(), alt.flushResult);
	const onDebug = (): void => {};
	const terminal = { replacement: true } as never;
	reference.onDebug = onDebug;
	reference.terminal = terminal;
	reference.children = [main];
	assert.equal(alt.onDebug, onDebug);
	assert.equal(alt.terminal, terminal);
	assert.equal(alt.children[0], main);
});

test("stable listener forwarding preserves function identity", () => {
	const renderer = createHarness("regular");
	const reference = createInteractiveTuiReference(() => renderer);
	const listener: TuiInputListener = () => undefined;
	const remove = reference.removeInputListener;
	reference.addInputListener(listener);
	remove(listener);
	assert.deepEqual(renderer.removedListeners, [listener]);
});

test("stable facade has no Proxy or prototype-impersonation dependency", () => {
	const source = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.doesNotMatch(source, /this\.ui\s+instanceof\s+Tui(?:Main|Alt)Screen/);
	assert.doesNotMatch(source, /InteractiveTuiReference[\s\S]{0,120}getPrototypeOf/);
	assert.doesNotMatch(source, /createInteractiveTuiReference[\s\S]{0,120}Proxy/);
});
