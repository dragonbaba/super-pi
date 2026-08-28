import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Input } from "../packages/tui/src/components/input.ts";
import { RetainedItem } from "../packages/tui/src/components/retained-item.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { Container, TuiBase, type Component } from "../packages/tui/src/tui.ts";

class QueryTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	readonly inputHandlers: Array<(data: string) => void> = [];
	readonly resizeHandlers: Array<() => void> = [];
	private input: ((data: string) => void) | undefined;
	private resize: (() => void) | undefined;
	private frameCompletion: ((generation: number, error?: Error) => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.input = onInput;
		this.resize = onResize;
		this.inputHandlers.push(onInput);
		this.resizeHandlers.push(onResize);
	}
	stop(): void {
		this.input = undefined;
		this.resize = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.writes.push(data);
		this.frameCompletion?.(generation);
	}
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	emitInput(data: string): void {
		this.input?.(data);
	}

	emitResize(): void {
		this.resize?.();
	}
}

class QueryTui extends TuiBase {
	readonly mode = "regular" as const;
	protected doRender(): void {}
}

class FocusComponent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class InheritedContainer extends Container {}

class OverriddenContainer extends Container {
	override render(width: number): string[] {
		return [`overridden:${width}`];
	}
}

class CachedLinesComponent implements Component {
	readonly lines = ["cached"];

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class ThrowingComponent implements Component {
	private readonly error: Error;

	constructor(error: Error) {
		this.error = error;
	}

	render(): string[] {
		throw this.error;
	}

	invalidate(): void {}
}

test("Container returns fresh caller-owned outer arrays without mutating child caches", () => {
	const cached = new CachedLinesComponent();
	const container = new Container();
	container.addChild(cached);
	const first = container.render(80);
	const second = container.render(80);
	assert.notEqual(first, second);
	assert.deepEqual(first, ["cached"]);
	assert.deepEqual(second, ["cached"]);
	first[0] = "mutated";
	first.push("outer-only");
	assert.deepEqual(cached.lines, ["cached"]);
	assert.deepEqual(container.render(80), ["cached"]);
});

test("Container flattening preserves inherited and overridden renders without JS name collisions", () => {
	const root = new Container();
	const nested = new InheritedContainer();
	nested.addChild({ render: (width) => [`nested:${width}`], invalidate(): void {} });
	let collidingCalls = 0;
	(nested as unknown as { renderInto: (width: number, target: string[]) => void }).renderInto = () => {
		collidingCalls++;
	};
	root.addChild(nested);
	root.addChild(new OverriddenContainer());
	assert.deepEqual(root.render(42), ["nested:42", "overridden:42"]);
	assert.equal(collidingCalls, 0);
});

test("Container naturally falls back to foreign components and propagates render errors", () => {
	const foreign = runInNewContext(`({ render(width) { return ["foreign:" + width]; } })`) as Component;
	const root = new Container();
	root.addChild(foreign);
	assert.deepEqual(root.render(33), ["foreign:33"]);
	const expected = new Error("render failed");
	root.addChild(new ThrowingComponent(expected));
	assert.throws(() => root.render(33), (error) => error === expected);
});

test("default retained items share one module-level context callback", () => {
	const component = new CachedLinesComponent();
	const callbacks = new Set<unknown>();
	let context: unknown;
	for (let index = 0; index < 100_000; index++) {
		const item = new RetainedItem(component, { id: `item-${index}`, version: 0 });
		const callback = (item as unknown as { getContext: () => unknown }).getContext;
		callbacks.add(callback);
		const nextContext = callback();
		context ??= nextContext;
		assert.equal(nextContext, context);
	}
	assert.equal(callbacks.size, 1);
});

test("Input grapheme hot paths avoid callback arrays and preserve Unicode clusters", () => {
	const source = readFileSync("packages/tui/src/components/input.ts", "utf8");
	assert.doesNotMatch(source, /\[\.\.\.data\]\.some\(/);
	assert.doesNotMatch(source, /\[\.\.\.segmenter\.segment\((?:beforeCursor|afterCursor)\)\]/);

	const input = new Input();
	input.handleInput("A");
	input.handleInput("中");
	input.handleInput("👨‍👩‍👧‍👦");
	input.handleInput("e\u0301");
	assert.equal(input.getValue(), "A中👨‍👩‍👧‍👦e\u0301");
	input.handleInput("\u001b[D");
	input.handleInput("\u007f");
	assert.equal(input.getValue(), "A中e\u0301");
	input.handleInput("\u001b[H");
	input.handleInput("\u001b[C");
	input.handleInput("\u001b[3~");
	assert.equal(input.getValue(), "Ae\u0301");
});

test("TuiBase reuses terminal input and resize callbacks across lifecycle restarts", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const input = terminal.inputHandlers[0];
	const resize = terminal.resizeHandlers[0];
	assert.equal(typeof input, "function");
	assert.equal(typeof resize, "function");
	terminal.emitInput("x");
	terminal.emitResize();
	await tui.stop();
	tui.start();
	assert.equal(terminal.inputHandlers[1], input);
	assert.equal(terminal.resizeHandlers[1], resize);
	terminal.emitInput("y");
	terminal.emitResize();
	await tui.dispose();
});

test("OSC 11 concurrent queries share one physical response owner", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	try {
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 1_000 });
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 1_000 });
		terminal.emitInput("\x1b]11;rgb:1111/2222/3333\x07");
		assert.deepEqual(await first, { r: 17, g: 34, b: 51 });
		assert.deepEqual(await second, { r: 17, g: 34, b: 51 });
		assert.equal(first, second);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);
	} finally {
		await tui.dispose();
	}
});

test("OSC 11 query wave shares the first caller deadline", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	try {
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 50 });
		const state = tui as unknown as {
			osc11BackgroundQueryTimer: NodeJS.Timeout & { _idleTimeout?: number };
			osc11BackgroundActiveGeneration: number;
		};
		const firstGeneration = state.osc11BackgroundActiveGeneration;
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 5_000 });
		assert.equal(second, first);
		assert.equal(state.osc11BackgroundQueryTimer._idleTimeout, 50);
		assert.equal(state.osc11BackgroundActiveGeneration, firstGeneration);
		assert.equal(await first, undefined);
	} finally {
		await tui.dispose();
	}
});

test("OSC 11 stale timeout generation cannot settle a replacement wave", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const state = tui as unknown as {
		handleOsc11BackgroundTimeout(generation: number): void;
		osc11BackgroundQueryPromise: Promise<unknown> | undefined;
		osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundPhysicalOutstanding: boolean;
		osc11BackgroundTombstone: boolean;
		osc11BackgroundUnsupported: boolean;
		osc11BackgroundActiveGeneration: number;
	};
	try {
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		const firstGeneration = state.osc11BackgroundActiveGeneration;
		assert.ok(firstGeneration > 0);
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout(firstGeneration);
		assert.equal(await first, undefined);

		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		const secondGeneration = state.osc11BackgroundActiveGeneration;
		const secondTimer = state.osc11BackgroundQueryTimer;
		const secondResolve = state.osc11BackgroundQueryResolve;
		assert.ok(secondGeneration > firstGeneration);
		assert.ok(secondTimer);
		assert.equal(state.osc11BackgroundQueryPromise, second);

		state.handleOsc11BackgroundTimeout(firstGeneration);
		assert.equal(state.osc11BackgroundActiveGeneration, secondGeneration);
		assert.equal(state.osc11BackgroundQueryPromise, second);
		assert.equal(state.osc11BackgroundQueryResolve, secondResolve);
		assert.equal(state.osc11BackgroundQueryTimer, secondTimer);
		assert.equal(state.osc11BackgroundPhysicalOutstanding, false);
		assert.equal(state.osc11BackgroundTombstone, true);
		assert.equal(state.osc11BackgroundUnsupported, false);

		clearTimeout(secondTimer);
		state.handleOsc11BackgroundTimeout(secondGeneration);
		assert.equal(await second, undefined);
	} finally {
		await tui.dispose();
	}
});

test("OSC 11 timeout keeps a FIFO tombstone for a late response", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	try {
		assert.equal(await tui.queryTerminalBackgroundColor({ timeoutMs: 1 }), undefined);
		const current = tui.queryTerminalBackgroundColor({ timeoutMs: 1_000 });
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);
		let currentSettled = false;
		void current.then(() => {
			currentSettled = true;
		});
		terminal.emitInput("\x1b]11;rgb:0000/0000/0000\x07");
		await Promise.resolve();
		assert.equal(currentSettled, false);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 2);
		terminal.emitInput("\x1b]11;rgb:ffff/ffff/ffff\x07");
		assert.deepEqual(await current, { r: 255, g: 255, b: 255 });
	} finally {
		await tui.dispose();
	}
});

test("disposing a TUI settles and releases pending OSC 11 queries", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const pending = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
	await tui.dispose();
	assert.equal(await pending, undefined);
});

test("10,000 concurrent OSC 11 callers share one bounded physical query", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const queries: Array<Promise<unknown>> = [];
	try {
		for (let index = 0; index < 10_000; index++) {
			queries.push(tui.queryTerminalBackgroundColor({ timeoutMs: 1 }));
		}
		const first = queries[0];
		for (let index = 1; index < queries.length; index++) assert.equal(queries[index], first);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);
		const active = tui as unknown as {
			osc11BackgroundQueryPromise: Promise<unknown> | undefined;
			osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
			osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
			osc11BackgroundPhysicalOutstanding: boolean;
			osc11BackgroundTombstone: boolean;
		};
		assert.equal(active.osc11BackgroundQueryPromise, first);
		assert.ok(active.osc11BackgroundQueryTimer);
		assert.equal(typeof active.osc11BackgroundQueryResolve, "function");
		assert.equal(active.osc11BackgroundPhysicalOutstanding, true);
		assert.equal(active.osc11BackgroundTombstone, false);
		assert.deepEqual(await Promise.all(queries), new Array(10_000).fill(undefined));
		const state = tui as unknown as {
			osc11BackgroundQueryPromise: Promise<unknown> | undefined;
			osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
			osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
			osc11BackgroundTombstone: boolean;
		};
		assert.equal(state.osc11BackgroundQueryPromise, undefined);
		assert.equal(state.osc11BackgroundQueryTimer, undefined);
		assert.equal(state.osc11BackgroundQueryResolve, undefined);
		assert.equal(active.osc11BackgroundPhysicalOutstanding, false);
		assert.equal(state.osc11BackgroundTombstone, true);
	} finally {
		await tui.dispose();
	}
	const disposed = tui as unknown as {
		osc11BackgroundQueryPromise: Promise<unknown> | undefined;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
		osc11BackgroundTombstone: boolean;
	};
	assert.equal(disposed.osc11BackgroundQueryPromise, undefined);
	assert.equal(disposed.osc11BackgroundQueryTimer, undefined);
	assert.equal(disposed.osc11BackgroundQueryResolve, undefined);
	assert.equal(disposed.osc11BackgroundTombstone, false);
});

test("OSC 11 caches unsupported after one follower deadline and bounds 10,000 no-response calls", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const state = tui as unknown as {
		handleOsc11BackgroundTimeout(generation: number): void;
		osc11BackgroundQueryPromise: Promise<unknown> | undefined;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
		osc11BackgroundPhysicalOutstanding: boolean;
		osc11BackgroundTombstone: boolean;
		osc11BackgroundUnsupported: boolean;
		osc11BackgroundWaveGeneration: number;
		osc11BackgroundActiveGeneration: number;
	};
	let maximumRecords = 0;
	let maximumTombstones = 0;
	let maximumTimers = 0;
	let maximumResolvers = 0;
	let unsupportedResult: Promise<unknown> | undefined;
	try {
		for (let index = 0; index < 10_000; index++) {
			const wave = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
			maximumRecords = Math.max(maximumRecords, state.osc11BackgroundQueryPromise ? 1 : 0);
			maximumTombstones = Math.max(maximumTombstones, state.osc11BackgroundTombstone ? 1 : 0);
			maximumTimers = Math.max(maximumTimers, state.osc11BackgroundQueryTimer ? 1 : 0);
			maximumResolvers = Math.max(maximumResolvers, state.osc11BackgroundQueryResolve ? 1 : 0);
			if (state.osc11BackgroundQueryTimer) {
				clearTimeout(state.osc11BackgroundQueryTimer);
				state.handleOsc11BackgroundTimeout(state.osc11BackgroundActiveGeneration);
			} else if (index >= 2) {
				unsupportedResult ??= wave;
				assert.equal(wave, unsupportedResult);
			}
			assert.equal(await wave, undefined);
			assert.equal(state.osc11BackgroundQueryPromise, undefined);
			assert.equal(state.osc11BackgroundQueryTimer, undefined);
			assert.equal(state.osc11BackgroundQueryResolve, undefined);
			assert.equal(state.osc11BackgroundActiveGeneration, 0);
		}
		assert.equal(state.osc11BackgroundWaveGeneration, 2);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);
		assert.equal(state.osc11BackgroundPhysicalOutstanding, false);
		assert.equal(state.osc11BackgroundTombstone, false);
		assert.equal(state.osc11BackgroundUnsupported, true);
		assert.equal(maximumRecords, 1);
		assert.equal(maximumTombstones, 1);
		assert.equal(maximumTimers, 1);
		assert.equal(maximumResolvers, 1);
	} finally {
		await tui.dispose();
	}
	assert.equal(state.osc11BackgroundTombstone, false);
	assert.equal(state.osc11BackgroundUnsupported, false);
});

test("a late OSC 11 reply clears unsupported cache and permits a fresh successful wave", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const state = tui as unknown as {
		handleOsc11BackgroundTimeout(generation: number): void;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundUnsupported: boolean;
		osc11BackgroundActiveGeneration: number;
	};
	try {
		const physical = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout(state.osc11BackgroundActiveGeneration);
		assert.equal(await physical, undefined);
		const follower = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout(state.osc11BackgroundActiveGeneration);
		assert.equal(await follower, undefined);
		assert.equal(state.osc11BackgroundUnsupported, true);
		const unsupported = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		assert.equal(await unsupported, undefined);
		assert.equal(state.osc11BackgroundQueryTimer, undefined);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);

		terminal.emitInput("\x1b]11;rgb:0000/0000/0000\x07");
		assert.equal(state.osc11BackgroundUnsupported, false);
		const recovered = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 2);
		terminal.emitInput("\x1b]11;rgb:1234/5678/9abc\x07");
		assert.deepEqual(await recovered, { r: 18, g: 86, b: 154 });
	} finally {
		await tui.dispose();
	}
});

test("OSC 11 new wave succeeds after the timed-out physical reply is consumed", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const state = tui as unknown as {
		handleOsc11BackgroundTimeout(generation: number): void;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundActiveGeneration: number;
	};
	try {
		const timedOut = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout(state.osc11BackgroundActiveGeneration);
		assert.equal(await timedOut, undefined);
		const current = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		const currentGeneration = state.osc11BackgroundActiveGeneration;
		assert.ok(currentGeneration > 1);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 1);
		terminal.emitInput("\x1b]11;rgb:0000/0000/0000\x07");
		assert.equal(state.osc11BackgroundActiveGeneration, currentGeneration);
		assert.equal(terminal.writes.filter((write) => write === "\x1b]11;?\x07").length, 2);
		terminal.emitInput("\x1b]11;rgb:aaaa/bbbb/cccc\x07");
		assert.deepEqual(await current, { r: 170, g: 187, b: 204 });
		assert.equal(state.osc11BackgroundActiveGeneration, 0);
	} finally {
		await tui.dispose();
	}
});

test("fixed overlay focus state restores a blocked overlay", async () => {
	const tui = new QueryTui(new QueryTerminal());
	const base = new FocusComponent();
	const overlay = new FocusComponent();
	const external = new FocusComponent();
	try {
		tui.setFocus(base);
		tui.showOverlay(overlay);
		assert.equal(tui.getFocusedComponent(), overlay);
		tui.setFocus(external);
		assert.equal(tui.getFocusedComponent(), external);
		tui.setFocus(null);
		assert.equal(tui.getFocusedComponent(), overlay);
	} finally {
		await tui.dispose();
	}
});

test("fixed overlay focus state preserves an explicit unfocus target", async () => {
	const tui = new QueryTui(new QueryTerminal());
	const base = new FocusComponent();
	const overlay = new FocusComponent();
	const external = new FocusComponent();
	try {
		tui.setFocus(base);
		const handle = tui.showOverlay(overlay);
		tui.setFocus(external);
		handle.unfocus({ target: base });
		tui.setFocus(null);
		assert.equal(tui.getFocusedComponent(), base);
	} finally {
		await tui.dispose();
	}
});
