import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { TuiBase, type Component } from "../packages/tui/src/tui.ts";

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
		handleOsc11BackgroundTimeout(): void;
		osc11BackgroundQueryPromise: Promise<unknown> | undefined;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
		osc11BackgroundPhysicalOutstanding: boolean;
		osc11BackgroundTombstone: boolean;
		osc11BackgroundUnsupported: boolean;
		osc11BackgroundWaveGeneration: number;
		osc11BackgroundActiveGeneration: number;
		osc11BackgroundTombstoneGeneration: number;
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
				state.handleOsc11BackgroundTimeout();
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
		assert.equal(state.osc11BackgroundTombstoneGeneration, 0);
		assert.equal(state.osc11BackgroundUnsupported, true);
		assert.equal(maximumRecords, 1);
		assert.equal(maximumTombstones, 1);
		assert.equal(maximumTimers, 1);
		assert.equal(maximumResolvers, 1);
	} finally {
		await tui.dispose();
	}
	assert.equal(state.osc11BackgroundTombstone, false);
	assert.equal(state.osc11BackgroundTombstoneGeneration, 0);
	assert.equal(state.osc11BackgroundUnsupported, false);
});

test("a late OSC 11 reply clears unsupported cache and permits a fresh successful wave", async () => {
	const terminal = new QueryTerminal();
	const tui = new QueryTui(terminal);
	tui.start();
	const state = tui as unknown as {
		handleOsc11BackgroundTimeout(): void;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundUnsupported: boolean;
	};
	try {
		const physical = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout();
		assert.equal(await physical, undefined);
		const follower = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout();
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
		handleOsc11BackgroundTimeout(): void;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundActiveGeneration: number;
	};
	try {
		const timedOut = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		if (state.osc11BackgroundQueryTimer) clearTimeout(state.osc11BackgroundQueryTimer);
		state.handleOsc11BackgroundTimeout();
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
