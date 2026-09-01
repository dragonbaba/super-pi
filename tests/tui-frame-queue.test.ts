import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";
import {
	Loader,
	TuiMainScreen as InteractiveTuiMainScreen,
	type TuiMainScreenRenderState,
} from "@super-pi/tui";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { ExtensionInputComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { TerminalFrameQueue, type TerminalFrameSink } from "../packages/tui/src/terminal-frame-queue.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { ProcessTerminal, type Terminal } from "../packages/tui/src/terminal.ts";
import { type Component, TuiBase } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";

initTheme("dark");

interface Gate {
	resolve(): void;
	reject(error: Error): void;
}

class GatedWriter implements TerminalFrameSink {
	readonly writes: string[] = [];
	readonly gates: Gate[] = [];
	activeWrites = 0;
	maximumActiveWrites = 0;
	private frameCompletion: ((generation: number, error?: Error) => void) | undefined;

	write = (data: string): Promise<void> => {
		this.writes.push(data);
		this.activeWrites++;
		this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
		return new Promise<void>((resolve, reject) => {
			this.gates.push({
				resolve: () => {
					this.activeWrites--;
					resolve();
				},
				reject: (error) => {
					this.activeWrites--;
					reject(error);
				},
			});
		});
	};

	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameCompletion = listener;
	}

	writeFrame(data: string, generation: number): void {
		this.writes.push(data);
		this.activeWrites++;
		this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
		this.gates.push({
			resolve: () => {
				this.activeWrites--;
				this.frameCompletion?.(generation);
			},
			reject: (error) => {
				this.activeWrites--;
				this.frameCompletion?.(generation, error);
			},
		});
	}

	cancelFrameWrite(_generation: number): void {}
}

class GatedTerminal implements Terminal {
	readonly writer = new GatedWriter();
	backpressure = true;
	columns = 120;
	rows = 40;
	kittyProtocolActive = false;
	started = false;
	disposeCalls = 0;
	inputHandler: ((data: string) => void) | undefined;
	resizeHandler: (() => void) | undefined;
	frameListenerInstallations = 0;
	drainInputPromise: Promise<void> | undefined;
	start(onInput?: (data: string) => void, onResize?: () => void): void {
		this.started = true;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}
	stop(): void {
		this.started = false;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}
	dispose(): void {
		this.disposeCalls++;
	}
	drainInput(): Promise<void> { return this.drainInputPromise ?? Promise.resolve(); }
	write(data: string): void | Promise<void> {
		if (!this.backpressure) {
			this.writer.writes.push(data);
			return;
		}
		return this.writer.write(data);
	}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		if (listener) this.frameListenerInstallations++;
		this.writer.setFrameWriteCompletionListener(listener);
	}
	writeFrame(data: string, generation: number): void { this.writer.writeFrame(data, generation); }
	cancelFrameWrite(generation: number): void { this.writer.cancelFrameWrite(generation); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	emitInput(data: string): void { this.inputHandler?.(data); }
}

class ImmediateInputTerminal extends GatedTerminal {
	override writeFrame(data: string, generation: number): void {
		super.writeFrame(data, generation);
		this.writer.gates[this.writer.gates.length - 1]!.resolve();
	}
}

class FrameTui extends TuiBase {
	readonly mode = "regular" as const;
	renderCount = 0;
	generation = 0;
	protected doRender(): void {
		this.renderCount++;
		this.writeTerminalFrame(`frame-${this.generation}`, 1);
	}
}

const EMPTY_COMPONENT_LINES = Object.freeze([]) as unknown as string[];

class InputProbe implements Component {
	inputCalls = 0;
	readonly inputs: string[] = [];
	onInput?: (data: string) => void;

	render(): string[] { return EMPTY_COMPONENT_LINES; }
	invalidate(): void {}
	handleInput(data: string): void {
		this.inputCalls++;
		this.inputs.push(data);
		this.onInput?.(data);
	}
}

class CountingComponentArray extends Array<Component> {
	iterationCount = 0;
	override [Symbol.iterator](): ArrayIterator<Component> {
		this.iterationCount++;
		return super[Symbol.iterator]();
	}
}

class InstrumentedMainTui extends InteractiveTuiMainScreen {
	captureRenderStateCalls = 0;
	override captureRenderState(): TuiMainScreenRenderState {
		this.captureRenderStateCalls++;
		return super.captureRenderState();
	}
}

function preserveLoaderText(value: string): string {
	return value;
}

class SplitFrameTui extends FrameTui {
	protected override doRender(): void {
		this.renderCount++;
		this.writeTerminalFrame(`frame-${this.generation}`, 1);
		this.writeTerminalFrame(`cursor-${this.generation}`, 0);
	}
}

class RejectingStopTui extends FrameTui {
	protected override beforeTerminalStop(): Promise<void> {
		return Promise.reject(new Error("stop boundary EIO"));
	}
}

class ControlBoundaryTui extends FrameTui {
	protected override beforeTerminalStop(): void | Promise<void> {
		return this.terminal.write("control-boundary");
	}
}

class ThrowingCursorTerminal extends GatedTerminal {
	override showCursor(): void {
		throw new Error("cursor restore EIO");
	}
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function observeProcessFrame(terminal: ProcessTerminal, data: string, generation = 1): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		terminal.setFrameWriteCompletionListener((completedGeneration, error) => {
			if (completedGeneration !== generation) return;
			terminal.setFrameWriteCompletionListener(undefined);
			if (error) reject(error);
			else resolve();
		});
		terminal.writeFrame(data, generation);
	});
}

class ImmediateFrameSink implements TerminalFrameSink {
	readonly writes: string[] = [];
	private completion: ((generation: number, error?: Error) => void) | undefined;
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.completion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.writes.push(data);
		this.completion?.(generation);
	}
	cancelFrameWrite(): void {}
}

class NeverSettlingFrameSink implements TerminalFrameSink {
	activeGeneration = 0;
	cancelledGeneration = 0;
	private completion: ((generation: number, error?: Error) => void) | undefined;
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.completion = listener;
	}
	writeFrame(_data: string, generation: number): void { this.activeGeneration = generation; }
	cancelFrameWrite(generation: number): void { this.cancelledGeneration = generation; }
	settleLate(): void { this.completion?.(this.activeGeneration); }
}

class ControlledFrameOutput extends EventEmitter {
	readonly callbacks: Array<(error?: Error | null) => void> = [];
	readonly data: string[] = [];
	returnValue = false;
	get callback(): ((error?: Error | null) => void) | undefined {
		return this.callbacks[this.callbacks.length - 1];
	}

	write(data: string, callback: (error?: Error | null) => void): boolean {
		this.data.push(data);
		this.callbacks.push(callback);
		return this.returnValue;
	}
}

class LifecycleProcessTerminal extends ProcessTerminal {
	lifecycleStarted = false;
	override start(): void { this.lifecycleStarted = true; }
	override stop(): void { this.lifecycleStarted = false; }
	override hideCursor(): void {}
	override showCursor(): void {}
	override write(): Promise<void> { return Promise.resolve(); }
}

class ControlLifecycleProcessTerminal extends ProcessTerminal {
	lifecycleStarted = false;
	override start(): void { this.lifecycleStarted = true; }
	override stop(): void { this.lifecycleStarted = false; }
	override hideCursor(): void {}
	override showCursor(): void {}
}

class ThrowingFrameOutput extends EventEmitter {
	write(): boolean {
		throw new Error("synchronous frame EIO");
	}
}

class SynchronousCallbackFrameOutput extends EventEmitter {
	write(_data: string, callback: (error?: Error | null) => void): boolean {
		callback();
		return true;
	}
}

class SynchronousErrorCallbackFrameOutput extends EventEmitter {
	write(_data: string, callback: (error?: Error | null) => void): boolean {
		callback(new Error("synchronous progress callback EIO"));
		return true;
	}
}

class RealBackpressuredWritable extends Writable {
	private completeWrite: ((error?: Error | null) => void) | undefined;

	constructor() {
		super({ highWaterMark: 1 });
	}

	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.completeWrite = callback;
	}

	complete(error?: Error): void {
		this.completeWrite?.(error);
		this.completeWrite = undefined;
	}
}

test("ProcessTerminal drainInput shares one cycle and keeps data events allocation-bounded", async () => {
	const output = new ControlledFrameOutput();
	output.returnValue = true;
	const terminal = new ProcessTerminal(output as never);
	const state = terminal as unknown as {
		drainInputActive: boolean;
		drainInputPromise: Promise<void> | undefined;
		drainInputResolve: (() => void) | undefined;
		drainInputReject: ((error: Error) => void) | undefined;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		drainInputPreviousHandler: ((data: string) => void) | undefined;
		drainInputLastDataTime: number;
		drainInputDeadline: number;
		drainInputIdleMs: number;
		drainActiveGeneration: number;
		inputHandler: ((data: string) => void) | undefined;
		readDrainTime: () => number;
		onDrainInputData: () => void;
		onDrainInputTimer: (generation: number) => void;
		captureDrainInputResolve: (resolve: () => void, reject: (error: Error) => void) => void;
	};
	let now = 1_000;
	state.readDrainTime = () => now;
	const baselineDataListeners = process.stdin.listenerCount("data");
	const dataCallback = state.onDrainInputData;
	const timerCallback = state.onDrainInputTimer;
	const promiseExecutor = state.captureDrainInputResolve;
	const first = terminal.drainInput(60_000, 60_000);
	const generation = state.drainActiveGeneration;
	const concurrent = terminal.drainInput(5_000, 5_000);
	assert.equal(concurrent, first);
	assert.equal(state.drainInputDeadline, 61_000);
	assert.equal(state.drainInputIdleMs, 60_000);
	assert.equal(process.stdin.listenerCount("data"), baselineDataListeners + 1);
	const timer = state.drainInputTimer;
	assert.ok(timer);
	for (let update = 0; update < 100_000; update++) state.onDrainInputData();
	assert.equal(state.drainInputTimer, timer, "data events update one primitive timestamp without replacing the timer");
	assert.equal(state.onDrainInputData, dataCallback);
	assert.equal(state.onDrainInputTimer, timerCallback);
	assert.equal(state.captureDrainInputResolve, promiseExecutor);
	clearTimeout(timer);
	now = 61_000;
	state.onDrainInputTimer(generation);
	await first;
	assert.equal(process.stdin.listenerCount("data"), baselineDataListeners);
	assert.equal(state.drainInputActive, false);
	assert.equal(state.drainInputPromise, undefined);
	assert.equal(state.drainInputResolve, undefined);
	assert.equal(state.drainInputReject, undefined);
	assert.equal(state.drainInputTimer, undefined);
	assert.equal(state.drainInputPreviousHandler, undefined);
	assert.equal(state.drainInputLastDataTime, 0);

	now = 70_000;
	const second = terminal.drainInput(1_000, 1_000);
	const disposedGeneration = state.drainActiveGeneration;
	assert.notEqual(second, first);
	terminal.dispose();
	await second;
	state.onDrainInputTimer(disposedGeneration);
	state.onDrainInputData();
	assert.equal(process.stdin.listenerCount("data"), baselineDataListeners);
	assert.equal(state.drainInputActive, false);
	assert.equal(state.drainActiveGeneration, 0);
	assert.equal(state.drainInputPromise, undefined);
	assert.equal(state.drainInputResolve, undefined);
	assert.equal(state.drainInputReject, undefined);
	assert.equal(state.drainInputTimer, undefined);
	assert.equal(state.drainInputPreviousHandler, undefined);
	assert.equal(state.inputHandler, undefined);
});

test("drainInput timer generation isolates successful, stopped, and replacement cycles", async () => {
	const terminal = new ProcessTerminal(new SynchronousCallbackFrameOutput() as never);
	const state = terminal as unknown as {
		drainGeneration: number;
		drainActiveGeneration: number;
		drainInputActive: boolean;
		drainInputPromise: Promise<void> | undefined;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		readDrainTime: () => number;
		onDrainInputTimer: (generation: number) => void;
	};
	let now = 0;
	state.readDrainTime = () => now;

	const first = terminal.drainInput(100, 100);
	const firstGeneration = state.drainActiveGeneration;
	const firstTimer = state.drainInputTimer;
	assert.ok(firstTimer);
	clearTimeout(firstTimer);
	now = 100;
	state.onDrainInputTimer(firstGeneration);
	await first;

	now = 200;
	const second = terminal.drainInput(100, 100);
	const secondGeneration = state.drainActiveGeneration;
	assert.notEqual(secondGeneration, firstGeneration);
	state.onDrainInputTimer(firstGeneration);
	assert.equal(state.drainInputActive, true);
	assert.equal(state.drainInputPromise, second);

	terminal.stop();
	await second;
	now = 300;
	const third = terminal.drainInput(100, 100);
	const thirdGeneration = state.drainActiveGeneration;
	state.onDrainInputTimer(secondGeneration);
	assert.equal(state.drainInputPromise, third);
	const thirdTimer = state.drainInputTimer;
	assert.ok(thirdTimer);
	clearTimeout(thirdTimer);
	now = 400;
	state.onDrainInputTimer(thirdGeneration);
	await third;
	terminal.dispose();
});

test("drainInput first caller owns concurrent parameters in both orderings", async () => {
	const terminal = new ProcessTerminal(new SynchronousCallbackFrameOutput() as never);
	const state = terminal as unknown as {
		drainInputDeadline: number;
		drainInputIdleMs: number;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		drainActiveGeneration: number;
		readDrainTime: () => number;
		onDrainInputTimer: (generation: number) => void;
	};
	let now = 10;
	state.readDrainTime = () => now;
	const shortFirst = terminal.drainInput(50, 20);
	const longSecond = terminal.drainInput(5_000, 4_000);
	assert.equal(longSecond, shortFirst);
	assert.equal(state.drainInputDeadline, 60);
	assert.equal(state.drainInputIdleMs, 20);
	let timer = state.drainInputTimer;
	assert.ok(timer);
	clearTimeout(timer);
	now = 60;
	state.onDrainInputTimer(state.drainActiveGeneration);
	await shortFirst;

	now = 100;
	const longFirst = terminal.drainInput(5_000, 4_000);
	const shortSecond = terminal.drainInput(50, 20);
	assert.equal(shortSecond, longFirst);
	assert.equal(state.drainInputDeadline, 5_100);
	assert.equal(state.drainInputIdleMs, 4_000);
	timer = state.drainInputTimer;
	assert.ok(timer);
	clearTimeout(timer);
	now = 5_100;
	state.onDrainInputTimer(state.drainActiveGeneration);
	await longFirst;
	terminal.dispose();
});

test("drainInput validates durations and resolves exact idle and absolute boundaries monotonically", async () => {
	const terminal = new ProcessTerminal(new SynchronousCallbackFrameOutput() as never);
	const state = terminal as unknown as {
		drainInputActive: boolean;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		drainActiveGeneration: number;
		readDrainTime: () => number;
		onDrainInputData: () => void;
		onDrainInputTimer: (generation: number) => void;
	};
	for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
		assert.throws(() => terminal.drainInput(invalid, 1), RangeError);
		assert.throws(() => terminal.drainInput(1, invalid), RangeError);
		assert.equal(state.drainInputActive, false);
	}
	let now = 1_000;
	state.readDrainTime = () => now;
	await terminal.drainInput(0, 10);
	await terminal.drainInput(10, 0);

	const idleLongerThanMax = terminal.drainInput(10, 100);
	let generation = state.drainActiveGeneration;
	let timer = state.drainInputTimer;
	assert.ok(timer);
	clearTimeout(timer);
	now = 1_010;
	state.onDrainInputTimer(generation);
	await idleLongerThanMax;

	now = 2_000;
	const exactIdle = terminal.drainInput(1_000, 100);
	generation = state.drainActiveGeneration;
	timer = state.drainInputTimer;
	assert.ok(timer);
	clearTimeout(timer);
	now = 2_100;
	state.onDrainInputTimer(generation);
	await exactIdle;

	now = 3_000;
	const continuous = terminal.drainInput(100, 10);
	generation = state.drainActiveGeneration;
	for (let elapsed = 9; elapsed < 100; elapsed += 9) {
		now = 3_000 + elapsed;
		state.onDrainInputData();
		timer = state.drainInputTimer;
		if (timer) clearTimeout(timer);
		state.onDrainInputTimer(generation);
		assert.equal(state.drainInputActive, true);
	}
	timer = state.drainInputTimer;
	if (timer) clearTimeout(timer);
	now = 3_100;
	state.onDrainInputTimer(generation);
	await continuous;
	terminal.dispose();
});

test("real EventEmitter drain input keeps one Promise, timer, listener, and resolver across 100k events", async () => {
	const terminal = new ProcessTerminal(new SynchronousCallbackFrameOutput() as never);
	const input = new EventEmitter();
	const state = terminal as unknown as {
		drainInputSource: EventEmitter;
		drainInputPromise: Promise<void> | undefined;
		drainInputResolve: (() => void) | undefined;
		drainInputReject: ((error: Error) => void) | undefined;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		drainActiveGeneration: number;
		readDrainTime: () => number;
		onDrainInputData: () => void;
		onDrainInputTimer: (generation: number) => void;
	};
	let now = 0;
	state.readDrainTime = () => now;
	state.drainInputSource = input;
	const promise = terminal.drainInput(60_000, 60_000);
	const timer = state.drainInputTimer;
	const resolve = state.drainInputResolve;
	const reject = state.drainInputReject;
	assert.ok(timer);
	assert.equal(input.listenerCount("data"), 1);
	assert.equal(input.listeners("data")[0], state.onDrainInputData);
	let promiseIdentityChanges = 0;
	let timerIdentityChanges = 0;
	let maximumPromises = 0;
	let maximumTimers = 0;
	let maximumResolvers = 0;
	let maximumRejectors = 0;
	for (let event = 0; event < 100_000; event++) {
		now = event / 10;
		input.emit("data", "x");
		if (state.drainInputPromise !== promise) promiseIdentityChanges++;
		if (state.drainInputTimer !== timer) timerIdentityChanges++;
		maximumPromises = Math.max(maximumPromises, state.drainInputPromise ? 1 : 0);
		maximumTimers = Math.max(maximumTimers, state.drainInputTimer ? 1 : 0);
		maximumResolvers = Math.max(maximumResolvers, state.drainInputResolve ? 1 : 0);
		maximumRejectors = Math.max(maximumRejectors, state.drainInputReject ? 1 : 0);
	}
	assert.equal(promiseIdentityChanges, 0);
	assert.equal(timerIdentityChanges, 0);
	assert.equal(maximumPromises, 1);
	assert.equal(maximumTimers, 1);
	assert.equal(maximumResolvers, 1);
	assert.equal(maximumRejectors, 1);
	assert.equal(state.drainInputResolve, resolve);
	assert.equal(state.drainInputReject, reject);
	clearTimeout(timer);
	now = 60_000;
	state.onDrainInputTimer(state.drainActiveGeneration);
	await promise;
	assert.equal(input.listenerCount("data"), 0);
	assert.equal(state.drainInputPromise, undefined);
	assert.equal(state.drainInputTimer, undefined);
	assert.equal(state.drainInputResolve, undefined);
	assert.equal(state.drainInputReject, undefined);
	terminal.dispose();
});

test("same ProcessTerminal stop and restart cannot restore a stale drain handler", async () => {
	const terminal = new ProcessTerminal(new SynchronousCallbackFrameOutput() as never);
	const inputA: string[] = [];
	const inputB: string[] = [];
	const state = terminal as unknown as {
		drainActiveGeneration: number;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		readDrainTime: () => number;
		onDrainInputData: () => void;
		onDrainInputTimer: (generation: number) => void;
		onStdinBufferData: (data: string) => void;
	};
	let now = 0;
	state.readDrainTime = () => now;
	terminal.start((data) => inputA.push(data), () => {});
	const draining = terminal.drainInput(60_000, 60_000);
	const staleGeneration = state.drainActiveGeneration;
	terminal.stop();
	await draining;
	terminal.start((data) => inputB.push(data), () => {});
	state.onDrainInputTimer(staleGeneration);
	state.onDrainInputData();
	state.onStdinBufferData("b");
	assert.deepEqual(inputA, []);
	assert.deepEqual(inputB, ["b"]);
	terminal.dispose();
	assert.equal(state.drainInputTimer, undefined);
	state.onDrainInputTimer(staleGeneration);
	state.onDrainInputData();
	assert.deepEqual(inputB, ["b"]);
});

test("ProcessTerminal drainInput reports synchronous control failure through its shared Promise", async () => {
	const output = new ThrowingFrameOutput();
	const terminal = new ProcessTerminal(output as never);
	const state = terminal as unknown as {
		keyboardProtocolPushed: boolean;
		drainInputPromise: Promise<void> | undefined;
		drainInputResolve: (() => void) | undefined;
		drainInputReject: ((error: Error) => void) | undefined;
		drainInputTimer: ReturnType<typeof setTimeout> | undefined;
		drainGeneration: number;
		drainActiveGeneration: number;
		readDrainTime: () => number;
		onDrainInputTimer: (generation: number) => void;
	};
	let now = 0;
	state.readDrainTime = () => now;
	state.keyboardProtocolPushed = true;
	const result = terminal.drainInput(100, 10);
	const failedGeneration = state.drainGeneration;
	await assert.rejects(result, /synchronous frame EIO/);
	assert.equal(state.drainInputPromise, undefined);
	assert.equal(state.drainInputResolve, undefined);
	assert.equal(state.drainInputReject, undefined);
	assert.equal(state.drainInputTimer, undefined);
	assert.equal(state.drainActiveGeneration, 0);
	state.keyboardProtocolPushed = false;
	const replacement = terminal.drainInput(100, 100);
	const replacementGeneration = state.drainActiveGeneration;
	state.onDrainInputTimer(failedGeneration);
	assert.equal(state.drainInputPromise, replacement);
	const replacementTimer = state.drainInputTimer;
	assert.ok(replacementTimer);
	clearTimeout(replacementTimer);
	now = 100;
	state.onDrainInputTimer(replacementGeneration);
	await replacement;
	terminal.dispose();
});

test("latest terminal frame replaces stale pending output with bounded depth", async () => {
	const writer = new GatedWriter();
	const startedMetadata: number[] = [];
	const queue = new TerminalFrameQueue(writer, { onWriteStarted: (metadata) => startedMetadata.push(metadata) });
	queue.submit("frame-a");
	queue.submit("frame-b");
	queue.submit("frame-c");

	assert.deepEqual(writer.writes, ["frame-a"]);
	assert.deepEqual(queue.snapshot(), {
		activeWrites: 1,
		pendingFrames: 1,
		frameQueueHighWaterMark: 2,
		replacedFrames: 1,
		failed: false,
		idleWaiterActive: 0,
		activeFrameUtf8Bytes: 7,
		pendingFrameUtf8Bytes: 7,
	});

	writer.gates[0]!.resolve();
	await settle();
	assert.deepEqual(writer.writes, ["frame-a", "frame-c"]);
	assert.deepEqual(startedMetadata, [0, 0]);
	assert.equal(writer.maximumActiveWrites, 1);
	assert.equal(queue.snapshot().pendingFrames, 0);

	writer.gates[1]!.resolve();
	await queue.flush();
	assert.deepEqual(queue.snapshot(), {
		activeWrites: 0,
		pendingFrames: 0,
		frameQueueHighWaterMark: 2,
		replacedFrames: 1,
		failed: false,
		idleWaiterActive: 0,
		activeFrameUtf8Bytes: 0,
		pendingFrameUtf8Bytes: 0,
	});
});

test("critical flush waits for the final latest frame", async () => {
	const writer = new GatedWriter();
	const queue = new TerminalFrameQueue(writer);
	queue.submit("active");
	queue.submit("final-v1");
	queue.submit("final-v2");
	let flushed = false;
	const flush = queue.flush().then(() => {
		flushed = true;
	});

	await settle();
	assert.equal(flushed, false);
	writer.gates[0]!.resolve();
	await settle();
	assert.deepEqual(writer.writes, ["active", "final-v2"]);
	assert.equal(flushed, false);
	writer.gates[1]!.resolve();
	await flush;
	assert.equal(flushed, true);
});

test("AgentSession awaits only explicit critical listeners and isolates final rejection", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const events: string[] = [];
	const session = Object.create(AgentSession.prototype) as unknown as {
		_eventListeners: Array<{
			listener: (event: unknown) => void | Promise<void>;
			criticalAgentEnd: boolean;
			observeRejection?: (error: unknown) => void;
		}>;
		_emitAgentEnd(event: { type: "agent_end"; messages: []; willRetry: boolean }): Promise<void>;
	};
	session._eventListeners = [
		{
			criticalAgentEnd: false,
			listener: () => {
				events.push("ordinary-pending");
				return new Promise<void>(() => {});
			},
		},
		{
			criticalAgentEnd: true,
			listener: async () => {
				events.push("critical-start");
				await gate;
				events.push("critical-end");
			},
		},
		{
			criticalAgentEnd: true,
			listener: async () => {
				events.push("critical-reject");
				throw new Error("isolated UI failure");
			},
		},
	];

	let settled = false;
	const boundary = session._emitAgentEnd({ type: "agent_end", messages: [], willRetry: false }).then(() => {
		settled = true;
	});
	await settle();
	assert.equal(settled, false);
	assert.deepEqual(events, ["ordinary-pending", "critical-start"]);
	release();
	await boundary;
	assert.equal(settled, true);
	assert.deepEqual(events, ["ordinary-pending", "critical-start", "critical-end", "critical-reject"]);
});

test("AgentSession bounds the complete critical agent_end listener lane", async () => {
	const events: string[] = [];
	const session = Object.create(AgentSession.prototype) as unknown as {
		_eventListeners: Array<{
			listener: (event: unknown) => void | Promise<void>;
			criticalAgentEnd: boolean;
			observeRejection?: (error: unknown) => void;
		}>;
		_criticalAgentEndTimeoutMs: number;
		_emitAgentEnd(event: { type: "agent_end"; messages: []; willRetry: boolean }): Promise<void>;
	};
	session._criticalAgentEndTimeoutMs = 20;
	session._eventListeners = [
		{
			criticalAgentEnd: true,
			listener: () => {
				events.push("pending-critical");
				return new Promise<void>(() => {});
			},
		},
		{
			criticalAgentEnd: true,
			listener: () => {
				events.push("later-critical");
			},
		},
	];

	await session._emitAgentEnd({ type: "agent_end", messages: [], willRetry: false });
	assert.deepEqual(events, ["pending-critical", "later-critical"]);
});

test("AgentSession observes ordinary async listener rejection without awaiting pending listeners", async () => {
	const session = Object.create(AgentSession.prototype) as unknown as {
		_eventListeners: Array<{
			listener: (event: unknown) => void | Promise<void>;
			criticalAgentEnd: boolean;
			observeRejection?: (error: unknown) => void;
		}>;
		_emit(event: unknown): void;
	};
	let resolvePending: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		resolvePending = resolve;
	});
	const delivered: string[] = [];
	const observedErrors: unknown[] = [];
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown): void => {
		unhandled.push(error);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		session._eventListeners = [
			{
				listener: async () => {
					throw new Error("ordinary listener rejection");
				},
				criticalAgentEnd: false,
				observeRejection: (error: unknown) => observedErrors.push(error),
			},
			{
				listener: () => pending,
				criticalAgentEnd: false,
			},
			{
				listener: () => {
					delivered.push("healthy");
				},
				criticalAgentEnd: false,
			},
		];
		for (const event of [
			{ type: "queue_update", steering: [], followUp: [] },
			{ type: "message_start", message: { role: "user", content: "hello", timestamp: 0 } },
			{ type: "agent_settled" },
			{ type: "compaction_start", reason: "manual" },
		]) {
			session._emit(event);
		}
		assert.deepEqual(delivered, ["healthy", "healthy", "healthy", "healthy"]);
		resolvePending?.();
		await settle();
		assert.deepEqual(unhandled, []);
		assert.equal(observedErrors.length, 4);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("ProcessTerminal requires callback and drain in either order after Writable backpressure", async () => {
	for (const order of ["callback-drain", "drain-callback"] as const) {
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		const baselineErrorListeners = output.listenerCount("error");
		let settled = false;
		const write = observeProcessFrame(terminal, `frame-${order}`).then(() => {
			settled = true;
		});

		if (order === "callback-drain") output.callback?.();
		else output.emit("drain");
		await settle();
		assert.equal(settled, false, `${order} settled before both completion conditions`);
		if (order === "callback-drain") output.emit("drain");
		else output.callback?.();
		await write;
		assert.equal(settled, true);
		assert.equal(output.listenerCount("drain"), 0);
		assert.equal(output.listenerCount("close"), 0);
		assert.equal(output.listenerCount("error"), baselineErrorListeners);
	}
});

test("cancelled physical write settles before a reused generation can start", async () => {
	for (const boundary of ["Main-to-Alt", "suspend-resume", "external-editor-resume"] as const) {
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		const previousQueue = new TerminalFrameQueue(terminal);
		previousQueue.submit(`${boundary}-A`);
		const callbackA = output.callbacks[0];
		assert.ok(callbackA);
		assert.equal(previousQueue.abort(new Error(`${boundary} lifecycle boundary`)), true);
		previousQueue.detach();
		assert.equal(
			(terminal as unknown as { physicalFrameWriteActive: boolean }).physicalFrameWriteActive,
			true,
		);

		// A new TUI owns a fresh queue and may reuse generation 1. It must wait
		// behind the canceled but physically active OS write.
		const nextQueue = new TerminalFrameQueue(terminal);
		nextQueue.submit(`${boundary}-B`);
		assert.equal(output.callbacks.length, 1, `${boundary} started B before orphan A settled`);

		callbackA();
		output.emit("drain");
		await settle();
		assert.equal(nextQueue.snapshot().activeWrites, 1, `${boundary} completed B from A's callback/drain`);
		assert.equal(output.callbacks.length, 2);

		const callbackB = output.callbacks[1];
		assert.ok(callbackB);
		callbackB();
		await settle();
		assert.equal(nextQueue.snapshot().activeWrites, 1, `${boundary} completed B before its drain`);
		output.emit("drain");
		await nextQueue.flush();
		assert.equal(nextQueue.snapshot().activeWrites, 0);
		assert.equal(nextQueue.snapshot().pendingFrames, 0);
		nextQueue.detach();
		terminal.dispose();
	}

	const interactiveSource = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.match(
		interactiveSource,
		/await previousUi\.stop\(\{ preserveScreen: true \}\)[\s\S]{0,240}this\.renderer !== previousUi[\s\S]{0,240}const terminal = previousUi\.terminal/,
	);
	const suspendSource = interactiveSource.match(/private async handleCtrlZ[\s\S]*?\n\tprivate async handleFollowUp/)?.[0] ?? "";
	assert.match(suspendSource, /await this\.ui\.stop\(\)/);
	assert.match(suspendSource, /this\.ui\.start\(\)/);
	assert.match(interactiveSource, /private async handleOpenExternalEditor[\s\S]{0,800}await this\.ui\.stop\(\)[\s\S]{0,800}this\.ui\.start\(\)/);
});

test("ProcessTerminal dispose permanently releases listeners and is idempotent across instances", async () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const first = new ProcessTerminal(output as never);
	const second = new ProcessTerminal(output as never);
	assert.equal(output.listenerCount("error"), baselineErrors + 2);

	let completions = 0;
	first.setFrameWriteCompletionListener(() => completions++);
	first.writeFrame("dispose-active", 1);
	const lateCallback = output.callbacks[0];
	first.dispose();
	first.dispose();
	assert.equal(output.listenerCount("error"), baselineErrors + 2);
	assert.equal(output.listenerCount("drain"), 1);
	assert.equal(output.listenerCount("close"), 1);
	assert.equal((first as unknown as { frameWriteCompletionListener?: unknown }).frameWriteCompletionListener, undefined);
	lateCallback?.();
	output.emit("drain");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(completions, 0);
	assert.equal(
		(first as unknown as { physicalFrameWriteActive: boolean }).physicalFrameWriteActive,
		false,
	);
	assert.equal((first as unknown as { frameWriteCallbackComplete: boolean }).frameWriteCallbackComplete, false);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);

	second.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.listenerCount("error"), baselineErrors);
	const third = new ProcessTerminal(output as never);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	third.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.listenerCount("error"), baselineErrors);
	assert.throws(() => third.write("after-dispose"), /disposed ProcessTerminal/);
});

test("ProcessTerminal repeated start-stop-dispose returns process listeners to baseline", () => {
	const lifecycleScript = String.raw`
		const { EventEmitter } = await import("node:events");
		const { ProcessTerminal } = await import("./packages/tui/src/terminal.ts");
		class CallbackOutput extends EventEmitter {
			write(_data, callback) {
				setImmediate(callback);
				return true;
			}
		}
		const output = new CallbackOutput();
		const stdinData = process.stdin.listenerCount("data");
		const stdoutResize = process.stdout.listenerCount("resize");
		const outputError = output.listenerCount("error");
		const terminal = new ProcessTerminal(output);
		if (output.listenerCount("error") !== outputError + 1) process.exit(11);
		for (let index = 0; index < 2; index++) {
			terminal.start(() => {}, () => {});
			terminal.stop();
			if (process.stdin.listenerCount("data") !== stdinData) process.exit(12);
			if (process.stdout.listenerCount("resize") !== stdoutResize) process.exit(13);
		}
		terminal.dispose();
		terminal.dispose();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		if (output.listenerCount("error") !== outputError) process.exit(14);
		try {
			terminal.start(() => {}, () => {});
			process.exit(15);
		} catch {}
	`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", lifecycleScript], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("TuiBase dispose permanently releases its terminal exactly once", async () => {
	const terminal = new GatedTerminal();
	const tui = new FrameTui(terminal);
	const first = tui.dispose();
	const second = tui.dispose();
	assert.equal(first, second);
	await first;
	assert.equal(terminal.disposeCalls, 1);
	await tui.dispose();
	assert.equal(terminal.disposeCalls, 1);
	assert.throws(() => tui.start(), /disposed TUI/);
});

test("ProcessTerminal resolves a Writable-accepted frame from its successful callback alone", async () => {
	const output = new ControlledFrameOutput();
	output.returnValue = true;
	const terminal = new ProcessTerminal(output as never);
	let settled = false;
	const write = observeProcessFrame(terminal, "accepted-frame").then(() => {
		settled = true;
	});
	await settle();
	assert.equal(settled, false);
	output.callback?.();
	await write;
	assert.equal(settled, true);
	assert.equal(output.listenerCount("drain"), 0);
	assert.equal(output.listenerCount("close"), 0);
});

test("ProcessTerminal follows a real Node Writable callback and drain boundary", async () => {
	const output = new RealBackpressuredWritable();
	const terminal = new ProcessTerminal(output as never);
	let settled = false;
	const write = observeProcessFrame(terminal, "real-writable-frame").then(() => {
		settled = true;
	});
	await settle();
	assert.equal(settled, false);
	output.complete();
	await write;
	assert.equal(settled, true);
});

test("128 KiB at 16 KiB/s completes normally beyond the five-second lifecycle boundary", async () => {
	const output = new RealBackpressuredWritable();
	const terminal = new ProcessTerminal(output as never);
	const frame = "x".repeat(128 * 1024);
	const expectedDelayMs = Buffer.byteLength(frame) / (16 * 1024) * 1_000;
	const started = performance.now();
	const write = observeProcessFrame(terminal, frame);
	setTimeout(() => output.complete(), expectedDelayMs);
	await write;
	assert.ok(performance.now() - started >= expectedDelayMs - 100);
});

test("ProcessTerminal frame writes isolate stream error, close, abort, and late events", async () => {
	{
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		let queueErrors = 0;
		const queue = new TerminalFrameQueue(terminal, {
			onError: () => queueErrors++,
		});
		queue.submit("callback-error");
		const error = new Error("stdout callback EIO");
		output.callback?.(error);
		output.emit("error", error);
		await assert.rejects(queue.flush(), error);
		assert.equal(queueErrors, 1);
		assert.equal(output.listenerCount("drain"), 0);
		assert.equal(output.listenerCount("close"), 0);
	}
	{
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		const write = observeProcessFrame(terminal, "closed-frame");
		output.emit("close");
		await assert.rejects(write, /closed before frame completion/);
		assert.equal(output.listenerCount("drain"), 0);
		assert.equal(output.listenerCount("close"), 0);
	}
	{
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		let completions = 0;
		terminal.setFrameWriteCompletionListener(() => completions++);
		terminal.writeFrame("aborted-frame", 17);
		terminal.cancelFrameWrite(17);
		output.callback?.();
		output.emit("drain");
		output.emit("error", new Error("late aborted stdout EIO"));
		await settle();
		assert.equal(completions, 0);
		assert.equal(output.listenerCount("drain"), 0);
		assert.equal(output.listenerCount("close"), 0);
	}
});

test("ProcessTerminal synchronous throw and callback error both fail the frame queue", async () => {
	const throwingOutput = new ControlledFrameOutput();
	throwingOutput.write = () => {
		throw new Error("stdout sync EIO");
	};
	const callbackErrorOutput = new ControlledFrameOutput();
	callbackErrorOutput.write = (_data, done) => {
		done(new Error("stdout async EIO"));
		return false;
	};
	for (const output of [throwingOutput, callbackErrorOutput]) {
		const terminal = new ProcessTerminal(output as never);
		const queue = new TerminalFrameQueue(terminal);
		queue.submit("frame");
		await assert.rejects(queue.flush(), /stdout (?:sync|async) EIO/);
		assert.equal(queue.snapshot().failed, true);
	}
});

test("normal writes have no absolute deadline and lifecycle abort releases every queue reference", async () => {
	const sink = new NeverSettlingFrameSink();
	const queue = new TerminalFrameQueue(sink);
	queue.submit("active-large-frame");
	queue.submit("pending-large-frame");
	let flushed = false;
	const flushing = Promise.all([queue.flush(), queue.flush()]).finally(() => {
		flushed = true;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
	assert.equal(flushed, false);
	const timeout = new Error("Terminal lifecycle flush timed out after 20ms");
	assert.equal(queue.abort(timeout), true);
	await assert.rejects(flushing, timeout);
	assert.deepEqual(queue.snapshot(), {
		activeWrites: 0,
		pendingFrames: 0,
		frameQueueHighWaterMark: 2,
		replacedFrames: 0,
		failed: true,
		idleWaiterActive: 0,
		activeFrameUtf8Bytes: 0,
		pendingFrameUtf8Bytes: 0,
	});
	assert.equal(sink.cancelledGeneration, 1);
	sink.settleLate();
	await settle();
	assert.equal(queue.snapshot().failed, true);
});

test("concurrent flush observes a frame published in the settled-before-cleanup microtask window", async () => {
	const writer = new GatedWriter();
	const queue = new TerminalFrameQueue(writer);
	queue.submit("frame-a");
	let flushed = 0;
	const firstFlush = queue.flush().then(() => flushed++);
	const secondFlush = queue.flush().then(() => flushed++);
	writer.gates[0]!.resolve();
	queueMicrotask(() => queue.submit("frame-b"));
	await settle();
	assert.deepEqual(writer.writes, ["frame-a", "frame-b"]);
	assert.equal(flushed, 0);
	writer.gates[1]!.resolve();
	await Promise.all([firstFlush, secondFlush]);
	assert.equal(flushed, 2);
	assert.equal(queue.snapshot().activeWrites, 0);
	assert.equal(queue.snapshot().pendingFrames, 0);
	assert.equal(queue.snapshot().idleWaiterActive, 0);
});

test("discardPending releases stale output and write failure terminates the queue", async () => {
	const writer = new GatedWriter();
	const queue = new TerminalFrameQueue(writer);
	queue.submit("active");
	queue.submit("large-pending-frame");
	assert.equal(queue.discardPending(), true);
	assert.equal(queue.snapshot().pendingFrames, 0);

	const failure = new Error("terminal closed");
	writer.gates[0]!.reject(failure);
	await assert.rejects(queue.flush(), failure);
	assert.equal(queue.snapshot().failed, true);
	assert.equal(queue.restartAfterLifecycleAbort(), undefined);
	assert.throws(() => queue.submit("after-error"), failure);
});

test("synchronous writers finish without retaining active or pending frames", async () => {
	const sink = new ImmediateFrameSink();
	const queue = new TerminalFrameQueue(sink);
	for (let index = 0; index < 100_000; index++) queue.submit(`frame-${index}`);
	await queue.flush();
	assert.equal(sink.writes.length, 100_000);
	assert.equal(queue.snapshot().activeWrites, 0);
	assert.equal(queue.snapshot().pendingFrames, 0);
});

test("TuiBase defers relative rendering while a terminal frame is active", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	tui.generation = 1;
	tui.renderNow();
	tui.generation = 2;
	tui.renderNow();
	assert.equal(tui.renderCount, 1);
	assert.deepEqual(terminal.writer.writes, ["frame-0"]);

	terminal.writer.gates[0]!.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(tui.renderCount, 2);
	assert.deepEqual(terminal.writer.writes, ["frame-0", "frame-2"]);
	terminal.writer.gates[1]!.resolve();
	await tui.flushTerminalFrames();
	const metrics = instrumentation.snapshot();
	assert.equal(metrics.terminalActiveWriteHighWaterMark, 1);
	assert.equal(metrics.terminalPendingFrameHighWaterMark, 0);
});

test("100,000 render requests retain one latest intent and produce the final frame", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	for (let index = 1; index <= 100_000; index++) {
		tui.generation = index;
		tui.requestRender();
	}
	assert.equal(tui.renderCount, 1);
	terminal.writer.gates[0]!.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(tui.renderCount, 2);
	assert.deepEqual(terminal.writer.writes, ["frame-0", "frame-100000"]);
	terminal.writer.gates[1]!.resolve();
	await tui.flushTerminalFrames();
	assert.equal(instrumentation.snapshot().pendingRenderRequestHighWaterMark, 1);
});

test("content and cursor remain one atomic frame while latest render intent replaces stale work", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new SplitFrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	assert.deepEqual(terminal.writer.writes, ["frame-0cursor-0"]);

	tui.generation = 1;
	tui.renderNow();
	tui.generation = 2;
	tui.requestRender(true);
	terminal.writer.gates[0]!.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(terminal.writer.writes, ["frame-0cursor-0", "frame-2cursor-2"]);
	assert.equal(terminal.writer.writes.some((write) => write.includes("frame-1") || write === "cursor-1"), false);

	terminal.writer.gates[1]!.resolve();
	await tui.flushTerminalFrames();
	const metrics = instrumentation.snapshot();
	assert.equal(metrics.frameStringsGenerated, 2);
	assert.equal(metrics.fullSizeFrameCopies, 0);
	assert.equal(metrics.framePromisesCreated, 0);
	assert.equal(metrics.frameAbortControllersCreated, 0);
	assert.equal(metrics.frameWrapperObjectsCreated, 0);
});

test("queue byte ownership uses UTF-8 bytes without allocating a copied frame", async () => {
	const writer = new GatedWriter();
	const queue = new TerminalFrameQueue(writer);
	queue.submit("中😀");
	assert.equal(queue.snapshot().activeFrameUtf8Bytes, Buffer.byteLength("中😀", "utf8"));
	writer.gates[0]!.resolve();
	await queue.flush();
	assert.equal(queue.snapshot().activeFrameUtf8Bytes, 0);
});

test("stop waits for one final deferred render before terminal cleanup", async () => {
	const terminal = new GatedTerminal();
	terminal.start();
	const tui = new FrameTui(terminal);
	tui.renderNow();
	tui.generation = 1;
	tui.renderNow();
	const stopped = tui.stop();
	assert.equal(terminal.started, true);
	terminal.writer.gates[0]!.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(terminal.writer.writes, ["frame-0", "frame-1"]);
	assert.equal(terminal.started, true);
	terminal.writer.gates[1]!.resolve();
	await stopped;
	assert.equal(terminal.started, false);
});

test("stop-pending input admission blocks listeners focus debug and render work", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	const focused = new InputProbe();
	let inputListenerCalls = 0;
	let debugCalls = 0;
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(focused);
	tui.setFocus(focused);
	tui.addInputListener(() => {
		inputListenerCalls++;
		return undefined;
	});
	tui.onDebug = () => { debugCalls++; };
	tui.start();
	tui.renderNow();
	const renderCountBeforeInput = tui.renderCount;
	const metricsBeforeInput = instrumentation.snapshot();
	const queueBeforeInput = tui.getTerminalFrameQueueSnapshot();

	const stopping = tui.stop();
	assert.equal(terminal.started, true, "physical terminal remains attached while the active frame is gated");
	terminal.emitInput("ordinary-input");
	terminal.emitInput("\x1b[100;6u");

	assert.equal(inputListenerCalls, 0);
	assert.equal(focused.inputCalls, 0);
	assert.equal(debugCalls, 0);
	assert.equal(tui.renderCount, renderCountBeforeInput);
	assert.equal(instrumentation.snapshot().frameStringsGenerated, metricsBeforeInput.frameStringsGenerated);
	assert.equal(tui.getTerminalFrameQueueSnapshot().pendingFrames, queueBeforeInput.pendingFrames);

	terminal.writer.gates[0]!.resolve();
	await stopping;
});

test("a second input from the same synchronous batch is quiesced after the first starts stop", async () => {
	const terminal = new GatedTerminal();
	const tui = new FrameTui(terminal);
	const focused = new InputProbe();
	let stopping: Promise<void> | undefined;
	focused.onInput = () => {
		if (focused.inputCalls === 1) stopping = tui.stop();
	};
	tui.addChild(focused);
	tui.setFocus(focused);
	tui.start();
	tui.renderNow();

	terminal.emitInput("first");
	terminal.emitInput("second");
	assert.equal(focused.inputCalls, 1);
	assert.deepEqual(focused.inputs, ["first"]);

	terminal.writer.gates[0]!.resolve();
	await stopping;
});

test("an input listener that starts stop quiesces later listeners and the rest of the same dispatch", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	const focused = new InputProbe();
	let firstListenerCalls = 0;
	let secondListenerCalls = 0;
	let stopping: Promise<void> | undefined;
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(focused);
	tui.setFocus(focused);
	tui.addInputListener(() => {
		firstListenerCalls++;
		stopping = tui.stop();
		return undefined;
	});
	tui.addInputListener(() => {
		secondListenerCalls++;
		return undefined;
	});
	tui.start();
	tui.renderNow();
	const renderCountBeforeInput = tui.renderCount;
	const metricsBeforeInput = instrumentation.snapshot();
	const queueBeforeInput = tui.getTerminalFrameQueueSnapshot();

	terminal.emitInput("stop-now");
	terminal.emitInput("subsequent-input");
	assert.equal(firstListenerCalls, 1);
	assert.equal(secondListenerCalls, 0);
	assert.equal(focused.inputCalls, 0);
	assert.equal(tui.renderCount, renderCountBeforeInput);
	assert.equal(instrumentation.snapshot().frameStringsGenerated, metricsBeforeInput.frameStringsGenerated);
	assert.equal(tui.getTerminalFrameQueueSnapshot().pendingFrames, queueBeforeInput.pendingFrames);

	terminal.writer.gates[0]!.resolve();
	await stopping;
});

test("stop-pending protocol replies settle before ordinary input admission", async () => {
	const terminal = new GatedTerminal();
	terminal.backpressure = false;
	const tui = new FrameTui(terminal);
	const focused = new InputProbe();
	let inputListenerCalls = 0;
	tui.addChild(focused);
	tui.setFocus(focused);
	tui.addInputListener(() => {
		inputListenerCalls++;
		return undefined;
	});
	tui.start();
	const background = tui.queryTerminalBackgroundColor({ timeoutMs: 5_000 });
	const colorScheme = tui.queryTerminalColorScheme({ timeoutMs: 5_000 });
	tui.renderNow();
	const stopping = tui.stop();

	terminal.emitInput("\x1b]11;rgb:ffff/0000/8080\x07");
	terminal.emitInput("\x1b[?997;1n");
	assert.deepEqual(await background, { r: 255, g: 0, b: 128 });
	assert.equal(await colorScheme, "dark");
	assert.equal(inputListenerCalls, 0);
	assert.equal(focused.inputCalls, 0);
	const state = tui as unknown as {
		osc11BackgroundQueryPromise: Promise<unknown> | undefined;
		osc11BackgroundQueryResolve: ((value: unknown) => void) | undefined;
		osc11BackgroundQueryTimer: NodeJS.Timeout | undefined;
		osc11BackgroundPhysicalOutstanding: boolean;
		osc11BackgroundTombstone: boolean;
		osc11BackgroundActiveGeneration: number;
		terminalColorSchemeListeners: Set<unknown>;
	};
	assert.equal(state.osc11BackgroundQueryPromise, undefined);
	assert.equal(state.osc11BackgroundQueryResolve, undefined);
	assert.equal(state.osc11BackgroundQueryTimer, undefined);
	assert.equal(state.osc11BackgroundPhysicalOutstanding, false);
	assert.equal(state.osc11BackgroundTombstone, false);
	assert.equal(state.osc11BackgroundActiveGeneration, 0);
	assert.equal(state.terminalColorSchemeListeners.size, 0);

	terminal.writer.gates[0]!.resolve();
	await stopping;
});

test("ordinary input admission resumes after the same TUI restarts", async () => {
	const terminal = new ImmediateInputTerminal();
	const tui = new FrameTui(terminal);
	const focused = new InputProbe();
	let inputListenerCalls = 0;
	tui.addChild(focused);
	tui.setFocus(focused);
	tui.addInputListener(() => {
		inputListenerCalls++;
		return undefined;
	});
	tui.start();
	await tui.stop();
	tui.start();
	terminal.emitInput("restored");
	assert.equal(inputListenerCalls, 1);
	assert.equal(focused.inputCalls, 1);
	assert.deepEqual(focused.inputs, ["restored"]);
	await tui.dispose();
});

function createModeSwitchHarness(previousUi: FrameTui | InstrumentedMainTui): Record<string, any> {
	const mode = Object.create(InteractiveMode.prototype) as Record<string, any>;
	const settingsManager = {
		getShowTerminalProgress(): boolean { return false; },
		getFullscreenExitOutput(): "resume-hint" { return "resume-hint"; },
	};
	const session = { isStreaming: false, isCompacting: false, settingsManager };
	Object.assign(mode, {
		runtimeHost: { session },
		renderer: previousUi,
		ui: previousUi,
		tuiLifecycleGeneration: 0,
		mainScreenRenderState: undefined,
		fullscreenLayoutRoot: new InputProbe(),
		transcriptRenderContext: { rendererVersion: 0 },
		options: { tuiMode: "regular" },
		onRightClickPaste: undefined,
		renderInstrumentation: undefined,
		themeController: { rebindTui(): void {}, disableAutoSync(): void {} },
		disposeActiveSelector(): void {},
		clearStatusIndicator(): void {},
		clearExtensionTerminalInputListeners(): void {},
		footer: { dispose(): void {} },
		footerDataProvider: { dispose(): void {} },
		unsubscribe: undefined,
		isInitialized: true,
		unregisterSignalHandlers(): void {},
	});
	return mode;
}

test("concurrent mode switches create one replacement after sharing the previous stop", async () => {
	const terminal = new GatedTerminal();
	const previousUi = new InstrumentedMainTui(terminal);
	const countedChildren = new CountingComponentArray();
	countedChildren.push(new InputProbe());
	previousUi.children = countedChildren;
	const mode = createModeSwitchHarness(previousUi);
	previousUi.start();
	previousUi.renderNow();
	const listenerInstallationsBefore = terminal.frameListenerInstallations;
	const childrenIterationsBefore = countedChildren.iterationCount;
	const switchTuiMode = mode.switchTuiMode as (
		mode: "regular" | "fullscreen",
		restoreProgress?: boolean,
		startRenderer?: boolean,
	) => Promise<boolean>;

	const first = switchTuiMode.call(mode, "fullscreen", false, false);
	const second = switchTuiMode.call(mode, "fullscreen", false, false);
	terminal.writer.gates[0]!.resolve();
	const results = await Promise.all([first, second]);
	assert.deepEqual(results, [true, false]);
	assert.equal(mode.renderer.mode, "fullscreen");
	assert.equal(countedChildren.iterationCount - childrenIterationsBefore, 1);
	assert.equal(previousUi.captureRenderStateCalls, 1);
	assert.equal(terminal.frameListenerInstallations, listenerInstallationsBefore + 1);
	assert.equal(terminal.inputHandler, undefined);
	await mode.renderer.dispose();
});

test("Main to Alt mode switch preserves a Loader reused by the explicit layout root", async () => {
	const terminal = new ImmediateInputTerminal();
	const previousUi = new InstrumentedMainTui(terminal);
	const mode = createModeSwitchHarness(previousUi);
	const stableTui = createInteractiveTuiReference(() => mode.renderer);
	const loader = new Loader(stableTui, preserveLoaderText, preserveLoaderText, "switching");
	previousUi.addChild(loader);
	mode.fullscreenLayoutRoot = loader;
	previousUi.start();
	previousUi.renderNow();

	const switched = await mode.switchTuiMode.call(mode, "fullscreen", false, false);
	assert.equal(switched, true);
	assert.equal(mode.renderer.mode, "fullscreen");
	const raw = loader as unknown as { intervalId: NodeJS.Timeout | null; ui: unknown };
	assert.ok(raw.intervalId);
	assert.equal(raw.ui, stableTui);
	await mode.renderer.dispose({ preserveScreen: true });
	assert.equal(raw.intervalId, null);
	assert.equal(raw.ui, null);
});

test("Alt to Main mode switch preserves animation owners reused by the regular roots", async () => {
	const terminal = new ImmediateInputTerminal();
	const previousUi = new InstrumentedMainTui(terminal);
	const mode = createModeSwitchHarness(previousUi);
	const stableTui = createInteractiveTuiReference(() => mode.renderer);
	const loader = new Loader(stableTui, preserveLoaderText, preserveLoaderText, "switching-back");
	previousUi.addChild(loader);
	mode.fullscreenLayoutRoot = loader;
	previousUi.start();
	previousUi.renderNow();

	assert.equal(await mode.switchTuiMode.call(mode, "fullscreen", false, false), true);
	const raw = loader as unknown as { intervalId: NodeJS.Timeout | null; ui: unknown };
	assert.ok(raw.intervalId);
	assert.equal(await mode.switchTuiMode.call(mode, "regular", false, false), true);
	assert.equal(mode.renderer.mode, "regular");
	assert.ok(raw.intervalId);
	assert.equal(raw.ui, stableTui);
	await mode.renderer.dispose({ preserveScreen: true });
	assert.equal(raw.intervalId, null);
	assert.equal(raw.ui, null);
});

test("InteractiveMode stop cancels and settles timed extension dialogs", async () => {
	for (const kind of ["selector", "input"] as const) {
		const terminal = new ImmediateInputTerminal();
		terminal.backpressure = false;
		const previousUi = new InstrumentedMainTui(terminal);
		const mode = createModeSwitchHarness(previousUi);
		let cancelCalls = 0;
		const component = kind === "selector"
			? new ExtensionSelectorComponent("Timed selector", ["one"], preserveLoaderText, () => {
				cancelCalls++;
				mode.extensionSelector = undefined;
			}, {
				tui: previousUi,
				timeout: 60_000,
			})
			: new ExtensionInputComponent("Timed input", undefined, preserveLoaderText, () => {
				cancelCalls++;
				mode.extensionInput = undefined;
			}, {
				tui: previousUi,
				timeout: 60_000,
			});
		const raw = component as unknown as { countdown?: { intervalId?: NodeJS.Timeout } };
		mode.extensionSelector = kind === "selector" ? component : undefined;
		mode.extensionInput = kind === "input" ? component : undefined;
		previousUi.addChild(component);
		previousUi.start();
		assert.ok(raw.countdown?.intervalId);
		try {
			await mode.stop.call(mode, "resume-hint");
			assert.equal(cancelCalls, 1);
			assert.equal(raw.countdown?.intervalId, undefined);
			assert.equal(mode.extensionSelector, undefined);
			assert.equal(mode.extensionInput, undefined);
			await mode.stop.call(mode, "resume-hint");
			assert.equal(cancelCalls, 1);
		} finally {
			component.dispose();
		}
	}
});

test("mode switch snapshots the final root focus and Main render state after stop", async () => {
	const terminal = new GatedTerminal();
	const previousUi = new InstrumentedMainTui(terminal);
	const countedChildren = new CountingComponentArray();
	const initialChild = new InputProbe();
	const latestChild = new InputProbe();
	countedChildren.push(initialChild);
	previousUi.children = countedChildren;
	previousUi.setFocus(initialChild);
	const latestRenderState = previousUi.captureRenderState();
	latestRenderState.previousWidth = 77;
	latestRenderState.viewportWindowStart = 23;
	previousUi.captureRenderStateCalls = 0;
	const mode = createModeSwitchHarness(previousUi);
	previousUi.start();
	previousUi.renderNow();
	const childrenIterationsBefore = countedChildren.iterationCount;
	const switchTuiMode = mode.switchTuiMode as (
		mode: "regular" | "fullscreen",
		restoreProgress?: boolean,
		startRenderer?: boolean,
	) => Promise<boolean>;

	const switching = switchTuiMode.call(mode, "fullscreen", false, false);
	previousUi.addChild(latestChild);
	previousUi.setFocus(latestChild);
	previousUi.restoreRenderState(latestRenderState);
	terminal.writer.gates[0]!.resolve();

	assert.equal(await switching, true);
	assert.deepEqual(mode.renderer.children, [initialChild, latestChild]);
	assert.equal(mode.renderer.getFocusedComponent(), latestChild);
	assert.equal(mode.mainScreenRenderState.previousWidth, 77);
	assert.equal(mode.mainScreenRenderState.viewportWindowStart, 23);
	assert.equal(countedChildren.iterationCount - childrenIterationsBefore, 1);
	assert.equal(previousUi.captureRenderStateCalls, 1);
	await mode.renderer.dispose();
});

test("programmatic stop invalidates a mode switch waiting on the same renderer", async () => {
	const terminal = new GatedTerminal();
	const previousUi = new FrameTui(terminal);
	const mode = createModeSwitchHarness(previousUi);
	previousUi.start();
	previousUi.renderNow();
	const listenerInstallationsBefore = terminal.frameListenerInstallations;
	const switchTuiMode = mode.switchTuiMode as (
		mode: "regular" | "fullscreen",
		restoreProgress?: boolean,
		startRenderer?: boolean,
	) => Promise<boolean>;

	const switching = switchTuiMode.call(mode, "fullscreen", false, false);
	const stopping = mode.stop("resume-hint");
	terminal.writer.gates[0]!.resolve();
	assert.equal(await switching, false);
	await stopping;
	assert.equal(mode.renderer, previousUi);
	assert.equal(terminal.frameListenerInstallations, listenerInstallationsBefore);
	assert.equal(mode.isInitialized, false);
});

test("shutdown admission invalidates a mode switch while terminal input is draining", async () => {
	const terminal = new GatedTerminal();
	const previousUi = new FrameTui(terminal);
	const mode = createModeSwitchHarness(previousUi);
	previousUi.start();
	previousUi.renderNow();
	const drainFailure = new Error("controlled drain boundary");
	let rejectDrain: ((error: Error) => void) | undefined;
	terminal.drainInputPromise = new Promise<void>((_resolve, reject) => {
		rejectDrain = reject;
	});
	const switchTuiMode = mode.switchTuiMode as (
		mode: "regular" | "fullscreen",
		restoreProgress?: boolean,
		startRenderer?: boolean,
	) => Promise<boolean>;
	const shutdown = mode.shutdown as () => Promise<void>;

	const switching = switchTuiMode.call(mode, "fullscreen", false, false);
	const shuttingDown = shutdown.call(mode);
	terminal.writer.gates[0]!.resolve();
	assert.equal(await switching, false);
	rejectDrain?.(drainFailure);
	await assert.rejects(shuttingDown, drainFailure);
	assert.equal(mode.renderer, previousUi);
	await previousUi.dispose();
});

test("stop bounds a never-settling frame, clears pending work, and still restores terminal state", async () => {
	const terminal = new GatedTerminal();
	terminal.start();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal, false, undefined, 20);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	tui.generation = 1;
	tui.renderNow();
	await tui.stop();
	assert.equal(terminal.started, false);
	assert.equal(instrumentation.snapshot().terminalFrameWriteErrors, 1);
	await assert.rejects(tui.flushTerminalFrames(), /timed out after 20ms/);
	terminal.writer.gates[0]!.resolve();
	await settle();
	assert.deepEqual(terminal.writer.writes, ["frame-0"]);
});

test("same TUI resumes after a lifecycle timeout while the orphan write still owns the physical slot", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new LifecycleProcessTerminal(output as never);
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal, false, undefined, 20);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);

	await tui.stop();
	assert.equal(terminal.lifecycleStarted, false);
	assert.equal((terminal as unknown as { physicalFrameWriteActive: boolean }).physicalFrameWriteActive, true);

	tui.generation = 1;
	tui.start();
	tui.renderNow(true);
	assert.equal(output.callbacks.length, 1, "B must wait behind orphan A");
	assert.equal(instrumentation.snapshot().physicalTerminalFrameWrites, 1, "logical B is not yet a physical write");

	callbackA();
	output.emit("drain");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.callbacks.length, 2);
	assert.equal(instrumentation.snapshot().physicalTerminalFrameWrites, 2);
	const callbackB = output.callbacks[1];
	assert.ok(callbackB);
	callbackB();
	output.emit("drain");
	await tui.flushTerminalFrames();
	assert.equal(tui.getTerminalFrameQueueSnapshot().activeWrites, 0);
	assert.equal(tui.getTerminalFrameQueueSnapshot().pendingFrames, 0);
	await tui.dispose();
});

test("same TUI replaces a stale resumed frame before an orphan writer becomes available", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new LifecycleProcessTerminal(output as never);
	const tui = new FrameTui(terminal, false, undefined, 20);
	tui.renderNow();
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);

	await tui.stop();
	tui.generation = 1;
	tui.start();
	tui.renderNow(true);
	tui.generation = 2;
	tui.renderNow(true);
	assert.deepEqual(output.data, ["frame-0"], "B and C must remain logical while orphan A owns Writable");

	callbackA();
	output.emit("drain");
	for (let attempts = 0; attempts < 50 && output.data.length < 2; attempts++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.deepEqual(output.data, ["frame-0", "frame-2"], "stale B must never enter Writable");
	output.callbacks[1]?.();
	output.emit("drain");
	await tui.flushTerminalFrames();
	assert.equal(tui.getTerminalFrameQueueSnapshot().activeWrites, 0);
	assert.equal(tui.getTerminalFrameQueueSnapshot().pendingFrames, 0);
	await tui.dispose();
});

test("direct queue retains only the latest unsent frame behind an orphan writer", async () => {
	for (const frameBytes of [64 * 1024, 16 * 1024 * 1024]) {
		const output = new ControlledFrameOutput();
		const terminal = new ProcessTerminal(output as never);
		const queue = new TerminalFrameQueue(terminal);
		const frameA = `A:${"a".repeat(frameBytes - 2)}`;
		const frameB = `B:${"b".repeat(frameBytes - 2)}`;
		const frameC = `C:${"c".repeat(frameBytes - 2)}`;
		queue.submit(frameA);
		const callbackA = output.callbacks[0];
		assert.ok(callbackA);
		assert.equal(queue.abort(new Error("lifecycle timeout")), true);
		assert.ok(queue.restartAfterLifecycleAbort());
		queue.submit(frameB);
		queue.submit(frameC);
		assert.equal(queue.snapshot().pendingFrames, 1);
		assert.equal(
			(terminal as unknown as { pendingFrameData?: string }).pendingFrameData,
			undefined,
			"ProcessTerminal must not retain a second full-size pending frame",
		);

		callbackA();
		output.emit("drain");
		await settle();
		assert.equal(output.data.length, 2);
		assert.equal(output.data[1], frameC);
		assert.notEqual(output.data[1], frameB);
		output.callbacks[1]?.();
		output.emit("drain");
		await queue.flush();
		assert.equal(queue.snapshot().activeWrites, 0);
		assert.equal(queue.snapshot().pendingFrames, 0);
		queue.detach();
		terminal.dispose();
	}
});

test("late orphan stream failure permanently poisons the restarted queue", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new ProcessTerminal(output as never);
	const queue = new TerminalFrameQueue(terminal);
	queue.submit("A");
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);
	assert.equal(queue.abort(new Error("recoverable timeout")), true);
	assert.ok(queue.restartAfterLifecycleAbort());
	queue.submit("B");
	const permanent = new Error("late orphan EIO");
	callbackA(permanent);
	assert.doesNotThrow(() => output.emit("error", new Error("duplicate late orphan EIO")));
	await assert.rejects(queue.flush(), /late orphan EIO/);
	assert.equal(queue.snapshot().failed, true);
	assert.equal(queue.snapshot().pendingFrames, 0);
	assert.throws(() => queue.submit("C"), /late orphan EIO/);
	queue.detach();
	terminal.dispose();
});

test("Main to Alt uses the terminal orphan barrier rather than reusing the physical writer", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new LifecycleProcessTerminal(output as never);
	const main = new TuiMainScreen(terminal, false, undefined, 20);
	main.addChild({ render: () => ["main-A"], invalidate: () => {} });
	main.renderNow();
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);
	await main.stop({ preserveScreen: true });

	const alt = new TuiAltScreen(terminal, false, undefined, {
		mouse: false,
		terminalBoundaryTimeoutMs: 20,
	});
	alt.addChild({ render: () => ["alt-B"], invalidate: () => {} });
	alt.start();
	alt.renderNow(true);
	assert.equal(output.callbacks.length, 1);

	callbackA();
	output.emit("drain");
	for (let attempts = 0; attempts < 50 && output.callbacks.length < 2; attempts++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.equal(output.callbacks.length, 2);
	const callbackB = output.callbacks[1];
	assert.ok(callbackB);
	callbackB();
	output.emit("drain");
	await alt.flushTerminalFrames();
	await alt.dispose({ preserveScreen: true });
});

test("Main to Alt replaces the unsent Alt frame with the latest logical generation", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new LifecycleProcessTerminal(output as never);
	const main = new TuiMainScreen(terminal, false, undefined, 20);
	main.addChild({ render: () => ["main-A"], invalidate: () => {} });
	main.renderNow();
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);
	await main.stop({ preserveScreen: true });

	let generation = "B";
	const alt = new TuiAltScreen(terminal, false, undefined, {
		mouse: false,
		terminalBoundaryTimeoutMs: 20,
	});
	alt.addChild({ render: () => [`alt-${generation}`], invalidate: () => {} });
	alt.start();
	alt.renderNow(true);
	generation = "C";
	alt.renderNow(true);
	assert.equal(output.data.length, 1);

	callbackA();
	output.emit("drain");
	for (let attempts = 0; attempts < 50 && output.data.length < 2; attempts++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.equal(output.data.length, 2);
	assert.match(output.data[1]!, /alt-C/);
	assert.doesNotMatch(output.data[1]!, /alt-B/);
	output.callbacks[1]?.();
	output.emit("drain");
	await alt.flushTerminalFrames();
	await alt.dispose({ preserveScreen: true });
});

test("external-editor production lifecycle restarts the same TUI after a timed-out frame", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new LifecycleProcessTerminal(output as never);
	const tui = new FrameTui(terminal, false, undefined, 20);
	tui.renderNow();
	const callbackA = output.callbacks[0];
	assert.ok(callbackA);
	let edited = "";
	const mode = Object.create(InteractiveMode.prototype) as {
		ui: FrameTui;
		settingsManager: { getExternalEditorCommand(): undefined };
		editor: { getText(): string; setText(value: string): void };
		runExternalEditor(): Promise<{ status: "complete"; content: string }>;
		handleOpenExternalEditor(): Promise<void>;
	};
	Object.defineProperties(mode, {
		ui: { value: tui, configurable: true },
		settingsManager: { value: { getExternalEditorCommand: () => undefined }, configurable: true },
		editor: {
			value: { getText: () => "before", setText: (value: string) => { edited = value; } },
			configurable: true,
		},
	});
	mode.runExternalEditor = async () => ({ status: "complete", content: "after" });
	await mode.handleOpenExternalEditor();
	assert.equal(edited, "after");
	assert.equal(terminal.lifecycleStarted, true);
	assert.equal(output.callbacks.length, 1);

	callbackA();
	output.emit("drain");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.callbacks.length, 2);
	output.callbacks[1]?.();
	output.emit("drain");
	await tui.flushTerminalFrames();
	await tui.dispose();
});

test(
	"Ctrl-Z production lifecycle restarts the same TUI after a timed-out frame",
	{ skip: process.platform === "win32" },
	async () => {
		const output = new ControlledFrameOutput();
		const terminal = new LifecycleProcessTerminal(output as never);
		const tui = new FrameTui(terminal, false, undefined, 20);
		tui.renderNow();
		const callbackA = output.callbacks[0];
		assert.ok(callbackA);
		const mode = Object.create(InteractiveMode.prototype) as {
			ui: FrameTui;
			suspendProcessGroup(): void;
			handleCtrlZ(): Promise<void>;
		};
		Object.defineProperty(mode, "ui", { value: tui, configurable: true });
		mode.suspendProcessGroup = () => { process.emit("SIGCONT"); };
		await mode.handleCtrlZ();
		assert.equal(terminal.lifecycleStarted, true);
		assert.equal(output.callbacks.length, 1);

		callbackA();
		output.emit("drain");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(output.callbacks.length, 2);
		output.callbacks[1]?.();
		output.emit("drain");
		await tui.flushTerminalFrames();
		await tui.dispose();
	},
);

test("final ProcessTerminal dispose retains orphan error ownership until physical settlement", async () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	terminal.writeFrame("orphan", 1);
	const callback = output.callbacks[0];
	assert.ok(callback);
	terminal.dispose();
	assert.equal((terminal as unknown as { physicalFrameWriteActive: boolean }).physicalFrameWriteActive, true);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	const callbackError = new Error("late frame EIO");
	callback(callbackError);
	assert.doesNotThrow(() => output.emit("error", new Error("duplicate late frame EIO")));
	assert.equal((terminal as unknown as { frameOutputFailure?: Error }).frameOutputFailure, callbackError);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.listenerCount("error"), baselineErrors);
});

test("a never-settling disposed frame retains only explicit physical orphan ownership", () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	terminal.writeFrame("never-settling", 1);
	terminal.dispose();
	assert.equal((terminal as unknown as { physicalFrameWriteActive: boolean }).physicalFrameWriteActive, true);
	assert.equal((terminal as unknown as { pendingFrameData?: string }).pendingFrameData, undefined);
	assert.equal((terminal as unknown as { frameWriteCompletionListener?: unknown }).frameWriteCompletionListener, undefined);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
});

test("final ProcessTerminal dispose retains a control-write observer until late callback and error", async () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	const write = terminal.write("control");
	const callback = output.callbacks[0];
	assert.ok(callback);
	terminal.dispose();
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	assert.equal((terminal as unknown as { controlWritesOutstanding: number }).controlWritesOutstanding, 1);
	callback(new Error("late control EIO"));
	assert.doesNotThrow(() => output.emit("error", new Error("late control EIO")));
	await assert.rejects(write, /late control EIO/);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((terminal as unknown as { controlWritesOutstanding: number }).controlWritesOutstanding, 0);
	assert.equal(output.listenerCount("error"), baselineErrors);
});

test("final ProcessTerminal dispose owns every unawaited terminal control write", async () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	terminal.showCursor();
	terminal.hideCursor();
	terminal.clearLine();
	const terminalState = terminal as unknown as {
		started: boolean;
		keyboardProtocolPushed: boolean;
		_modifyOtherKeysActive: boolean;
		controlWritesOutstanding: number;
		frameOutputFailure?: Error;
	};
	terminalState.started = true;
	terminalState.keyboardProtocolPushed = true;
	terminalState._modifyOtherKeysActive = true;
	terminal.stop();
	assert.equal(output.callbacks.length, 6);
	assert.equal(terminalState.controlWritesOutstanding, 6);

	terminal.dispose();
	terminal.dispose();
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	output.callbacks[0]?.();
	const failure = new Error("late cursor EIO");
	output.callbacks[1]?.(failure);
	assert.doesNotThrow(() => output.emit("error", new Error("duplicate late cursor EIO")));
	assert.equal(terminalState.frameOutputFailure, failure);
	assert.equal(terminalState.controlWritesOutstanding, 4);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	for (let index = 2; index < output.callbacks.length; index++) output.callbacks[index]?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(terminalState.controlWritesOutstanding, 0);
	assert.equal(output.listenerCount("error"), baselineErrors);
});

test("100k progress keepalive ticks retain one physical progress write and one pending clear", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new ProcessTerminal(output as never);
	terminal.setProgress(true);
	const state = terminal as unknown as {
		writeProgressKeepalive(): void;
		controlWritesOutstanding: number;
		progressWriteActive: boolean;
		progressClearPending: boolean;
		progressInterval?: ReturnType<typeof setInterval>;
	};
	for (let index = 0; index < 100_000; index++) state.writeProgressKeepalive();
	assert.equal(output.callbacks.length, 1);
	assert.equal(state.controlWritesOutstanding, 1);
	assert.equal(state.progressWriteActive, true);

	terminal.setProgress(false);
	assert.equal(output.callbacks.length, 1);
	assert.equal(state.progressClearPending, true);
	output.callbacks[0]?.();
	assert.equal(output.callbacks.length, 2, "one clear follows the gated keepalive");
	assert.equal(state.controlWritesOutstanding, 1);
	output.callbacks[1]?.();
	await settle();
	assert.equal(state.controlWritesOutstanding, 0);
	assert.equal(state.progressWriteActive, false);
	assert.equal(state.progressClearPending, false);
	assert.equal(state.progressInterval, undefined);
	terminal.dispose();
});

test("progress callback failure stops keepalive and poisons output once", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new ProcessTerminal(output as never);
	terminal.setProgress(true);
	const state = terminal as unknown as {
		writeProgressKeepalive(): void;
		controlWritesOutstanding: number;
		progressWriteActive: boolean;
		progressClearPending: boolean;
		progressInterval?: ReturnType<typeof setInterval>;
		frameOutputFailure?: Error;
	};
	for (let index = 0; index < 100_000; index++) state.writeProgressKeepalive();
	const failure = new Error("progress EIO");
	output.callbacks[0]?.(failure);
	assert.doesNotThrow(() => output.emit("error", new Error("duplicate progress EIO")));
	assert.equal(state.frameOutputFailure, failure);
	assert.equal(state.controlWritesOutstanding, 0);
	assert.equal(state.progressWriteActive, false);
	assert.equal(state.progressClearPending, false);
	assert.equal(state.progressInterval, undefined);
	for (let index = 0; index < 100_000; index++) state.writeProgressKeepalive();
	assert.equal(output.callbacks.length, 1);
	terminal.dispose();
	await settle();
});

test("synchronous progress callback error cannot arm the keepalive timer", async () => {
	const output = new SynchronousErrorCallbackFrameOutput();
	const terminal = new ProcessTerminal(output as never);
	terminal.setProgress(true);
	const state = terminal as unknown as {
		controlWritesOutstanding: number;
		progressDesiredActive: boolean;
		progressWriteActive: boolean;
		progressInterval?: ReturnType<typeof setInterval>;
		frameOutputFailure?: Error;
	};
	assert.equal(state.progressDesiredActive, false);
	assert.equal(state.progressWriteActive, false);
	assert.equal(state.progressInterval, undefined);
	assert.equal(state.controlWritesOutstanding, 0);
	assert.match(state.frameOutputFailure?.message ?? "", /synchronous progress callback EIO/);
	terminal.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("dispose clears progress timer and pending intent while retaining one physical callback owner", async () => {
	const output = new ControlledFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	terminal.setProgress(true);
	const state = terminal as unknown as {
		controlWritesOutstanding: number;
		progressDesiredActive: boolean;
		progressWriteActive: boolean;
		progressClearPending: boolean;
		progressInterval?: ReturnType<typeof setInterval>;
	};
	terminal.setProgress(false);
	assert.equal(state.progressClearPending, true);
	terminal.dispose();
	assert.equal(state.progressDesiredActive, false);
	assert.equal(state.progressClearPending, false);
	assert.equal(state.progressInterval, undefined);
	assert.equal(state.controlWritesOutstanding, 1);
	assert.equal(output.listenerCount("error"), baselineErrors + 1);
	output.callbacks[0]?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(state.progressWriteActive, false);
	assert.equal(state.controlWritesOutstanding, 0);
	assert.equal(output.callbacks.length, 1);
	assert.equal(output.listenerCount("error"), baselineErrors);
});

test("unawaited terminal control synchronous throw rolls back ownership and poisons output", async () => {
	const output = new ThrowingFrameOutput();
	const baselineErrors = output.listenerCount("error");
	const terminal = new ProcessTerminal(output as never);
	assert.throws(() => terminal.showCursor(), /synchronous frame EIO/);
	const state = terminal as unknown as { controlWritesOutstanding: number; frameOutputFailure?: Error };
	assert.equal(state.controlWritesOutstanding, 0);
	assert.match(state.frameOutputFailure?.message ?? "", /synchronous frame EIO/);
	terminal.dispose();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(output.listenerCount("error"), baselineErrors);
});

test("ProcessTerminal start stop and dispose clean up transactionally after synchronous control errors", () => {
	for (const scenario of ["start-first", "start-middle", "stop-first", "stop-middle", "progress-clear", "dispose-stop"]) {
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "tests/fixtures/tui-terminal-sync-cleanup-child.ts", scenario],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
		);
		assert.equal(child.status, 0, `${scenario}: ${child.stderr}`);
		const result = JSON.parse(child.stdout.trim()) as {
			thrown: string;
			started: boolean;
			disposed: boolean;
			stdinBufferCleared: boolean;
			stdinDataHandlerCleared: boolean;
			inputHandlerCleared: boolean;
			resizeHandlerCleared: boolean;
			progressTimerCleared: boolean;
			dataListeners: number;
			resizeListeners: number;
			rawModes: boolean[];
			controls: string[];
		};
		assert.match(result.thrown, /sync-control-/, scenario);
		assert.equal(result.started, false, scenario);
		assert.equal(result.disposed, scenario === "dispose-stop", scenario);
		assert.equal(result.stdinBufferCleared, true, scenario);
		assert.equal(result.stdinDataHandlerCleared, true, scenario);
		assert.equal(result.inputHandlerCleared, true, scenario);
		assert.equal(result.resizeHandlerCleared, true, scenario);
		assert.equal(result.progressTimerCleared, true, scenario);
		assert.equal(result.dataListeners, 0, scenario);
		assert.equal(result.resizeListeners, 0, scenario);
		assert.equal(result.rawModes.at(-1), false, scenario);
		assert.ok(result.controls.includes("\x1b[?2004l"), `${scenario}: bracketed-paste restore attempted`);
		if (scenario !== "start-first") {
			assert.ok(result.controls.includes("\x1b[<u"), `${scenario}: keyboard restore attempted`);
		}
		if (!scenario.startsWith("start-")) {
			assert.ok(result.controls.includes("\x1b[>4;0m"), `${scenario}: modifyOtherKeys restore attempted`);
		}
	}
});

test("same TUI restarts after a control-boundary lifecycle timeout", async () => {
	const terminal = new GatedTerminal();
	terminal.start();
	const tui = new ControlBoundaryTui(terminal, false, undefined, 20);
	await tui.stop();
	assert.equal(terminal.writer.gates.length, 1);

	terminal.backpressure = false;
	tui.generation = 1;
	tui.start();
	tui.renderNow(true);
	terminal.writer.gates[1]?.resolve();
	await tui.flushTerminalFrames();
	assert.deepEqual(terminal.writer.writes, ["control-boundary", "frame-1"]);
	await tui.dispose();
});

test("late control callback failure permanently poisons lifecycle restart", async () => {
	const output = new ControlledFrameOutput();
	const terminal = new ControlLifecycleProcessTerminal(output as never);
	const tui = new ControlBoundaryTui(terminal, false, undefined, 20);
	await tui.stop();
	assert.equal(output.callbacks.length, 1);
	output.callbacks[0]?.(new Error("permanent control EIO"));
	await settle();

	tui.generation = 1;
	tui.start();
	tui.renderNow(true);
	await assert.rejects(tui.flushTerminalFrames(), /permanent control EIO/);
	await tui.dispose();
});

test("physical frame instrumentation starts only after Writable.write returns", async () => {
	const output = new ThrowingFrameOutput();
	const terminal = new ControlLifecycleProcessTerminal(output as never);
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	await settle();
	const metrics = instrumentation.snapshot();
	assert.equal(metrics.physicalTerminalFrameWrites, 0);
	assert.equal(metrics.terminalBytes, 0);
	await tui.dispose();
});

test("physical frame instrumentation records accepted and backpressured writes exactly once", async () => {
	for (const output of [new SynchronousCallbackFrameOutput(), new ControlledFrameOutput()]) {
		const terminal = new ControlLifecycleProcessTerminal(output as never);
		const instrumentation = new TuiRenderInstrumentation();
		const tui = new FrameTui(terminal);
		tui.setRenderInstrumentation(instrumentation);
		tui.renderNow();
		let metrics = instrumentation.snapshot();
		assert.equal(metrics.physicalTerminalFrameWrites, 1);
		assert.ok(metrics.terminalBytes > 0);
		if (output instanceof ControlledFrameOutput) {
			output.callbacks[0]?.();
			await settle();
			assert.equal(tui.getTerminalFrameQueueSnapshot().activeWrites, 1);
			output.emit("drain");
		}
		await tui.flushTerminalFrames();
		metrics = instrumentation.snapshot();
		assert.equal(metrics.physicalTerminalFrameWrites, 1);
		await tui.dispose();
	}
});

test("production Main reports the real active-plus-cursor frame queue depth", async () => {
	const terminal = new GatedTerminal();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new TuiMainScreen(terminal, false);
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild({
		render: () => ["main-frame"],
		invalidate: () => {},
	});
	tui.renderNow();
	let metrics = instrumentation.snapshot();
	assert.equal(metrics.terminalActiveWriteHighWaterMark, 1);
	assert.equal(metrics.terminalPendingFrameHighWaterMark, 0);
	assert.equal(metrics.terminalFrameQueueHighWaterMark, 1);
	assert.equal(metrics.frameStringsGenerated, 1);
	assert.ok(metrics.frameStringUtf8BytesGenerated > 0);
	assert.equal(metrics.maximumFrameUtf8Bytes, metrics.frameStringUtf8BytesGenerated);
	assert.ok(metrics.activeFrameUtf8Bytes > 0);
	assert.equal(metrics.pendingFrameUtf8Bytes, 0);
	assert.equal(metrics.fullSizeFrameCopies, 0);
	assert.equal(metrics.framePromisesCreated, 0);
	assert.equal(metrics.frameAbortControllersCreated, 0);
	assert.equal(metrics.frameWrapperObjectsCreated, 0);
	assert.equal(terminal.writer.writes.length, 1);

	terminal.writer.gates[0]!.resolve();
	await settle();
	assert.equal(terminal.writer.writes.length, 1);
	await tui.flushTerminalFrames();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.terminalFrameWriteErrors, 0);
	assert.equal(metrics.activeFrameUtf8Bytes, 0);
	assert.equal(metrics.pendingFrameUtf8Bytes, 0);
});

test("overlay scratch releases rendered lines when an overlay render throws", () => {
	const terminal = new GatedTerminal();
	terminal.backpressure = false;
	const tui = new TuiMainScreen(terminal);
	tui.addChild({ render: () => ["base"], invalidate: () => {} });
	tui.showOverlay({
		render: () => {
			throw new Error("overlay render failure");
		},
		invalidate: () => {},
	});
	assert.throws(() => tui.renderNow(true), /overlay render failure/);
	const scratch = tui as unknown as {
		overlayLinesScratch: string[][];
		overlayRowsScratch: number[];
		overlayColsScratch: number[];
		overlayWidthsScratch: number[];
		overlayLineCountsScratch: number[];
	};
	assert.equal(scratch.overlayLinesScratch.length, 0);
	assert.equal(scratch.overlayRowsScratch.length, 0);
	assert.equal(scratch.overlayColsScratch.length, 0);
	assert.equal(scratch.overlayWidthsScratch.length, 0);
	assert.equal(scratch.overlayLineCountsScratch.length, 0);
});

test("async terminal failure is contained, observed, and stops future rendering", async () => {
	const terminal = new GatedTerminal();
	terminal.start();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		tui.renderNow();
		terminal.writer.gates[0]!.reject(new Error("terminal EIO"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(terminal.started, false);
		assert.equal(instrumentation.snapshot().terminalFrameWriteErrors, 1);
		await assert.rejects(tui.flushTerminalFrames(), /terminal EIO/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("fullscreen stop flushes the latest frame and both terminal-exit boundaries", async () => {
	const terminal = new GatedTerminal();
	terminal.backpressure = false;
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	let generation = 0;
	tui.addChild({
		render: () => [`alt-${generation}`],
		invalidate: () => {},
	});
	tui.start();
	terminal.backpressure = true;
	tui.renderNow();
	generation = 1;
	tui.renderNow();
	let stopped = false;
	const stopping = tui.stop({ preserveScreen: true }).then(() => {
		stopped = true;
	});
	assert.equal(stopped, false);

	let releasedGates = 0;
	for (let attempts = 0; attempts < 20 && !stopped; attempts++) {
		const gate = terminal.writer.gates[releasedGates];
		if (gate) {
			releasedGates++;
			gate.resolve();
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	await stopping;
	assert.equal(stopped, true);
	assert.equal(terminal.started, false);
	assert.ok(terminal.writer.writes.some((write) => write.includes("alt-1")), "final Alt frame must be written");
	const output = terminal.writer.writes.join("");
	assert.ok(output.includes("\x1b[?1049l"), "alternate-screen exit must be written before stop resolves");
});

test("stop-hook write rejection still restores terminal state without becoming unhandled", async () => {
	const terminal = new GatedTerminal();
	terminal.backpressure = false;
	terminal.start();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new RejectingStopTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		await tui.stop();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(terminal.started, false);
		assert.equal(instrumentation.snapshot().terminalFrameWriteErrors, 1);
		await assert.rejects(tui.flushTerminalFrames(), /stop boundary EIO/);
		assert.deepEqual(unhandled, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("synchronous terminal cleanup failure is recorded without skipping stop", async () => {
	const terminal = new ThrowingCursorTerminal();
	terminal.start();
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new FrameTui(terminal);
	tui.setRenderInstrumentation(instrumentation);
	await tui.stop();
	assert.equal(terminal.started, false);
	assert.equal(instrumentation.snapshot().terminalFrameWriteErrors, 1);
	await assert.rejects(tui.flushTerminalFrames(), /cursor restore EIO/);
});

test("fatal child restores Alt, mouse, keyboard, cursor, and raw mode after frame timeout", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", "tests/fixtures/tui-fatal-restore-child.ts"],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
	);
	assert.equal(child.status, 1, child.stderr);
	const result = JSON.parse(child.stdout.trim()) as { frameWrites: number; frameAborts: number; evidence: string[] };
	assert.equal(result.frameWrites, 1);
	assert.equal(result.frameAborts, 1);
	assert.ok(result.evidence.includes("cursor:show"));
	assert.ok(result.evidence.includes("keyboard:restore"));
	assert.ok(result.evidence.includes("raw-mode:restore"));
	const controls = result.evidence.join("\n");
	assert.match(controls, /\\u001b\[\?1000l/);
	assert.match(controls, /\\u001b\[\?7h/);
	assert.match(controls, /\\u001b\[\?1049l/);
});

test("frame queue benchmark reports bounded production render and unique final-frame identity", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"scripts/bench/tui-frame-queue.ts",
			"--warmup", "1",
			"--runs", "1",
			"--requests", "1000",
			"--frame-kib", "64",
		],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout) as {
		metrics: Record<string, number>;
		observations: Record<string, string>;
	};
	assert.equal(result.metrics.doRenderCalls, 2);
	assert.equal(result.metrics.generatedFrameStrings, 2);
	assert.equal(result.metrics.writtenFrames, 2);
	assert.equal(result.metrics.uniqueWrittenFrames, 2);
	assert.equal(result.metrics.pendingRenderIntentHighWaterMark, 1);
	assert.equal(result.metrics.maximumActiveWrites, 1);
	assert.equal(result.metrics.instrumentedFrameStringsGenerated, 2);
	assert.equal(result.metrics.fullSizeFrameCopies, 0);
	assert.equal(result.metrics.framePromisesCreated, 0);
	assert.equal(result.metrics.frameAbortControllersCreated, 0);
	assert.equal(result.metrics.frameWrapperObjectsCreated, 0);
	assert.equal(result.metrics.activeFrameUtf8BytesAfterFlush, 0);
	assert.equal(result.metrics.pendingFrameUtf8BytesAfterFlush, 0);
	assert.equal(result.metrics.finalFrameSentinelMatched, 1);
	assert.match(result.observations.finalFrameSha256, /^[0-9a-f]{64}$/);
	assert.equal(result.observations.finalFrameSentinel, "frame-999-of-999:");
});

test("direct frame queue benchmark replaces 9,998 unique large frames without retaining a chain", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"scripts/bench/tui-frame-queue-direct.ts",
			"--warmup", "1",
			"--runs", "1",
			"--requests", "10000",
			"--frame-kib", "64",
		],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout) as {
		metrics: Record<string, number>;
		observations: Record<string, string>;
	};
	assert.equal(result.metrics.activeAtGate, 1);
	assert.equal(result.metrics.pendingAtGate, 1);
	assert.equal(result.metrics.frameQueueHighWaterMark, 2);
	assert.equal(result.metrics.writtenFrames, 2);
	assert.equal(result.metrics.replacedFrames, 9_998);
	assert.equal(result.metrics.activeAfterFlush, 0);
	assert.equal(result.metrics.pendingAfterFlush, 0);
	assert.equal(result.metrics.frameStringsMaterializedByQueue, 0);
	assert.equal(result.metrics.fullSizeFrameCopies, 0);
	assert.equal(result.metrics.framePromisesCreated, 0);
	assert.equal(result.metrics.frameAbortControllersCreated, 0);
	assert.equal(result.metrics.frameWrapperObjectsCreated, 0);
	assert.equal(result.metrics.finalFrameSentinelMatched, 1);
	assert.equal(result.observations.finalFrameSha256, "b884dbabfd3ff3c5a117714ba25c4e8834ca05509424f0438c365ea03b77d9c6");
	assert.equal(result.observations.finalFrameSentinel, "frame-9999-of-9999:");
});

test("queue-only prebuilt-frame allocation benchmark reports zero frame-owned objects and copies", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"scripts/bench/tui-frame-queue-allocations.ts",
			"--warmup", "100",
			"--frames", "1000",
			"--frame-kib", "1",
		],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout) as { fixture: string; metrics: Record<string, number> };
	assert.equal(result.fixture, "queue-only-prebuilt-frame");
	assert.equal(result.metrics.writtenFrames, 1000);
	assert.equal(result.metrics.activeAfterFlush, 0);
	assert.equal(result.metrics.pendingAfterFlush, 0);
	assert.equal(result.metrics.closuresCreated, 0);
	assert.equal(result.metrics.framePromisesCreated, 0);
	assert.equal(result.metrics.frameAbortControllersCreated, 0);
	assert.equal(result.metrics.frameWrapperObjectsCreated, 0);
	assert.equal(result.metrics.frameStringsMaterializedByQueue, 0);
	assert.equal(result.metrics.fullSizeFrameCopies, 0);
});

test("100k Agent observer and session delivery preserve synchronous UI lanes", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"scripts/bench/tui-session-event-allocations.ts",
			"--updates", "100000",
			"--warmup", "10000",
		],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
	);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout) as {
		fixtures: Array<{
			name: string;
			results: Array<{
				name: string;
				updates: number;
				metrics: Record<string, number>;
				sourceInvariant: Record<string, number>;
			}>;
		}>;
	};
	assert.deepEqual(result.fixtures.map((fixture) => fixture.name), ["agent-session-to-interactive-stub"]);
	const direct = result.fixtures[0]!.results.slice(0, 2);
	assert.deepEqual(direct.map((entry) => entry.name), ["message_update", "tool_execution_update"]);
	for (const entry of direct) {
		assert.equal(entry.updates, 100_000);
		assert.equal(entry.metrics.builtInListenerPromisesPerUpdate, 0);
		assert.equal(entry.metrics.rejectionObserversPerUpdate, 0);
		assert.equal(entry.sourceInvariant.toolWrapperObjectsPerUpdate, 0);
		assert.equal(entry.sourceInvariant.inlineClosuresPerUpdate, 0);
		assert.equal(entry.sourceInvariant.promiseTailsPerUpdate, 0);
		assert.equal(entry.sourceInvariant.promiseArraysPerUpdate, 0);
		assert.equal(entry.sourceInvariant.arraysPerUpdate, 0);
		assert.equal(entry.metrics.finalUpdateCorrect, 1);
		assert.ok(entry.metrics.sampledAllocationBytesPerUpdate >= 0);
		assert.ok(entry.metrics.cpuP95MsPerUpdate >= entry.metrics.cpuP50MsPerUpdate);
	}
	const fullChain = result.fixtures[0]!.results[2]!;
	assert.equal(fullChain.name, "observer-coalesced-message_update");
	assert.equal(fullChain.updates, 100_000);
	assert.equal(fullChain.metrics.rawUpdates, 100_000);
	assert.equal(fullChain.metrics.coalescedUpdates, 99_999);
	assert.equal(fullChain.metrics.coalescedDeliveries, 1);
	assert.equal(fullChain.metrics.snapshotCount, 1);
	assert.equal(fullChain.metrics.extensionObserverPublishes, 1);
	assert.equal(fullChain.metrics.promisesPerRawUpdate, 0);
	assert.equal(fullChain.metrics.promisesPerDelivery, 0);
	assert.equal(fullChain.metrics.observerBridgePromisesPerDelivery, 0);
	assert.equal(fullChain.metrics.builtInInteractivePromisesPerDelivery, 0);
	assert.equal(fullChain.metrics.rejectionObserversPerDelivery, 0);
	assert.equal(fullChain.sourceInvariant.toolWrapperObjectsPerUpdate, 0);
	assert.equal(fullChain.metrics.finalUpdateCorrect, 1);
	assert.ok(fullChain.metrics.sampledAllocationBytesPerRawUpdate >= 0);
	assert.ok(fullChain.metrics.sampledAllocationBytesPerDelivery >= 0);
	assert.ok(fullChain.metrics.cpuP95MsPerRawUpdate >= fullChain.metrics.cpuP50MsPerRawUpdate);
});

test("AgentSession observer bridge source is synchronous before extension coalescing", () => {
	const published: unknown[] = [];
	const delivered: unknown[] = [];
	const session = Object.create(AgentSession.prototype) as unknown as {
		_eventListeners: Array<{
			listener: (event: unknown) => void;
			criticalAgentEnd: boolean;
			observeRejection: (error: unknown) => void;
		}>;
		_extensionObserverDelivery: { publishLatest(key: string, event: unknown): void };
		_handleAgentObserverEvent(event: unknown): void | Promise<void>;
	};
	session._eventListeners = [{ listener: (event) => { delivered.push(event); }, criticalAgentEnd: false, observeRejection: () => {} }];
	session._extensionObserverDelivery = { publishLatest: (_key, event) => { published.push(event); } };
	const event = { type: "message_update", message: { role: "assistant", content: [], timestamp: 0 } };
	const result = session._handleAgentObserverEvent(event);
	assert.equal(result, undefined);
	assert.deepEqual(delivered, [event]);
	assert.deepEqual(published, [event]);

	const source = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
	assert.doesNotMatch(source, /_handleAgentObserverEvent\s*=\s*async/);
	assert.match(source, /private _handleAgentObserverEvent\(event: AgentEvent\): void/);
	assert.match(source, /this\._handleAgentObserverEvent = this\._handleAgentObserverEvent\.bind\(this\)/);
	assert.match(source, /this\._emit\(event\);[\s\S]{0,240}this\._extensionObserverDelivery\.publishLatest/);
});

test("production full replay benchmark exposes frame and lifecycle reference ownership", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"scripts/bench/tui-full-replay-backpressure.ts",
			"--warmup", "1",
			"--runs", "1",
			"--items", "100",
		],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
	);
	assert.equal(child.status, 0, child.stderr);
	const metrics = (JSON.parse(child.stdout) as { metrics: Record<string, number> }).metrics;
	assert.ok(metrics.firstResizeFrameBytes > 0);
	assert.equal(metrics.queueActiveReferencesAtGate, 1);
	assert.equal(metrics.queuePendingReferencesAtGate, 0);
	assert.equal(metrics.renderIntentReferencesAtGate, 1);
	assert.equal(metrics.activeTerminalFrameReferencesAtGate, 1);
	assert.equal(metrics.queueActiveAfterFlush, 0);
	assert.equal(metrics.queuePendingAfterFlush, 0);
	assert.equal(metrics.queueActiveAfterAbort, 0);
	assert.equal(metrics.queuePendingAfterAbort, 0);
	assert.equal(metrics.terminalFrameReferencesAfterAbort, 0);
	assert.equal(metrics.frameStringsGenerated, 3);
	assert.equal(metrics.maximumFrameUtf8Bytes > 0, true);
	assert.equal(metrics.fullSizeFrameCopies, 0);
	assert.equal(metrics.framePromisesCreated, 0);
	assert.equal(metrics.frameAbortControllersCreated, 0);
	assert.equal(metrics.frameWrapperObjectsCreated, 0);
	assert.equal(metrics.activeFrameUtf8BytesAfterAbort, 0);
	assert.equal(metrics.pendingFrameUtf8BytesAfterAbort, 0);
});

test("frame queue source retains one string without Promise tails or pooling", () => {
	const queueSource = readFileSync("packages/tui/src/terminal-frame-queue.ts", "utf8");
	assert.match(queueSource, /private activeWrite = false/);
	assert.match(queueSource, /private pendingFrame: string \| undefined/);
	assert.match(queueSource, /this\.pendingFrame = data/);
	assert.match(queueSource, /while \(this\.busy \|\| !this\.sinkAvailable \|\| this\.idleSettlementScheduled\)/);
	assert.match(queueSource, /this\.sink\.cancelFrameWrite\(token\)/);
	assert.doesNotMatch(queueSource, /Promise<[^>]+>\[\]|Array<Promise|\.push\(|\.shift\(|ObjectPool|Proxy\s*\(/);
	assert.doesNotMatch(queueSource, /AbortController|TerminalFrameWriter|result\.then/);

	const terminalSource = readFileSync("packages/tui/src/terminal.ts", "utf8");
	assert.doesNotMatch(terminalSource, /process\.stdout\.write/);
	assert.match(terminalSource, /private writeUnawaitedControl\(data: string\): void/);
	assert.match(terminalSource, /this\.frameOutput\.write\(data, this\.onUnawaitedControlWriteCallback\)/);
	assert.match(terminalSource, /writeFrame\(data: string,[\s\S]{0,2400}this\.frameOutput\.write\(data,/);
	assert.match(terminalSource, /frameWriteCallbackComplete && this\.frameWriteDrainComplete/);
	assert.match(terminalSource, /frameOutput\.once\("drain", this\.onFrameWriteDrain\)/);
	const writeFrameSource = terminalSource.match(/writeFrame\(data: string,[\s\S]*?\n\tprivate tryCompleteFrameWrite/)?.[0] ?? "";
	assert.ok(
		writeFrameSource.indexOf("this.frameOutput.write(data, this.onFrameWriteCallback)") <
			writeFrameSource.indexOf("this.frameWriteStartedListener?.(generation)"),
	);
	assert.doesNotMatch(writeFrameSource, /const (?:finish|maybeFinish|failOutput|onDrain|onClose|onAbort)\s*=|new Set/);
	assert.match(queueSource, /this\.sink\.writeFrame\(data, token\)/);
	assert.match(terminalSource, /setFrameWriteCompletionListener/);
	assert.match(terminalSource, /setFrameWriteReadyListener/);
	assert.doesNotMatch(terminalSource, /pendingFrameData|pendingFrameGeneration/);
	assert.doesNotMatch(terminalSource, /frameWriteSignal|captureFrameWritePromise|onFrameWriteAbort/);
	const tuiSource = readFileSync("packages/tui/src/tui.ts", "utf8");
	assert.match(tuiSource, /new TerminalFrameQueue\(this\.terminal/);
	assert.match(tuiSource, /process\.nextTick\(this\.scheduleRequestedRender\)/);
	assert.match(tuiSource, /process\.nextTick\(this\.runImmediateRender\)/);
	assert.match(tuiSource, /setTimeout\(this\.runScheduledRender, delay\)/);
	assert.match(tuiSource, /awaitTerminalBoundary/);
	assert.doesNotMatch(tuiSource, /void this\.terminal\.write\(/);

	for (const path of ["packages/tui/src/tui-main-screen.ts", "packages/tui/src/tui-alt-screen.ts"]) {
		const rendererSource = readFileSync(path, "utf8");
		assert.doesNotMatch(rendererSource, /recordTerminalFrame\([\s\S]{0,160}terminal\.write\(buffer\)/);
		assert.match(rendererSource, /writeTerminalFrame\(buffer,/);
	}

	const interactiveSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		"utf8",
	);
	const mountInteractiveTui = interactiveSource.match(
		/private mountInteractiveTui[\s\S]*?\n\t}\n/,
	)?.[0] ?? "";
	assert.notEqual(mountInteractiveTui, "");
	assert.ok(
		mountInteractiveTui.indexOf("tui.setLayoutRoot(this.fullscreenLayoutRoot)") <
			mountInteractiveTui.indexOf("for (const component of components)"),
	);
	assert.doesNotMatch(mountInteractiveTui, /new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);
	const switchTuiMode = interactiveSource.match(/private async switchTuiMode[\s\S]*?\n\t}\n/)?.[0] ?? "";
	assert.notEqual(switchTuiMode, "");
	assert.match(
		switchTuiMode,
		/previousUi instanceof TuiAltScreen\) previousUi\.detachLayoutRootForTransfer\(\)/,
	);
	assert.doesNotMatch(switchTuiMode, /new (?:Map|Set|AbortController)|\.map\(|\.filter\(|\.flatMap\(/);
	const cancelExtensionDialogs = interactiveSource.match(
		/private cancelExtensionDialogs[\s\S]*?\n\t}/,
	)?.[0] ?? "";
	assert.notEqual(cancelExtensionDialogs, "");
	assert.match(cancelExtensionDialogs, /this\.extensionSelector\?\.cancel\(\)/);
	assert.match(cancelExtensionDialogs, /this\.extensionInput\?\.cancel\(\)/);
	assert.doesNotMatch(
		cancelExtensionDialogs,
		/new (?:Map|Set|Promise|AbortController)|=>|function\s*\(|\.map\(|\.filter\(|\.flatMap\(/,
	);
	const interactiveStop = interactiveSource.match(
		/async stop\(fullscreenExitOutput[\s\S]*?\n\t}/,
	)?.[0] ?? "";
	assert.notEqual(interactiveStop, "");
	assert.ok(
		interactiveStop.indexOf("this.cancelExtensionDialogs()") <
			interactiveStop.indexOf("this.disposeActiveSelector()"),
	);
	const altSource = readFileSync("packages/tui/src/tui-alt-screen.ts", "utf8");
	const detachLayoutRootForTransfer = altSource.match(
		/detachLayoutRootForTransfer\(\): void \{[\s\S]*?\n\t}/,
	)?.[0] ?? "";
	assert.notEqual(detachLayoutRootForTransfer, "");
	assert.match(detachLayoutRootForTransfer, /this\.layoutRoot = undefined/);
	assert.match(detachLayoutRootForTransfer, /this\.layoutScratch\.clear\(\)/);
	assert.doesNotMatch(
		detachLayoutRootForTransfer,
		/releaseComponentRenderCaches|\.invalidate\(|\.render\(|new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/,
	);
	assert.match(interactiveSource, /await previousUi\.stop\(\{ preserveScreen: true \}\)/);
	assert.match(interactiveSource, /await this\.stopInteractiveTui\(fullscreenExitOutput\)/);
	assert.match(interactiveSource, /criticalAgentEnd: true/);
	assert.match(interactiveSource, /case "agent_end":[\s\S]{0,1200}return this\.flushAgentEndFrames\(\)/);

	const sessionSource = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
	assert.doesNotMatch(sessionSource, /_handleAgentObserverEvent\s*=\s*async/);
	assert.match(sessionSource, /private _handleAgentObserverEvent\(event: AgentEvent\): void/);
	assert.match(sessionSource, /private async _emitAgentEnd/);
	assert.match(sessionSource, /if \(!registration\.criticalAgentEnd \|\| deadlineReached\)/);
	assert.match(sessionSource, /Promise\.race\(\[observed, getDeadline\(\)\]\)/);
	assert.match(sessionSource, /if \(event\.type === "agent_end"\) \{\s*await this\._emitAgentEnd/);
	const highFrequencyEmit = sessionSource.match(/private _emit\(event:[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.doesNotMatch(highFrequencyEmit, /await|Promise\.all|Promise<|\.push\(|\.then\(\s*(?:async\s*)?\(/);
});

test("terminal lifecycle promises use stable observers and one-shot TUIs dispose permanently", () => {
	const interactiveSource = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.match(interactiveSource, /private observeLifecyclePromise[\s\S]{0,180}promise\.then\(undefined, this\.handleLifecyclePromiseRejection\)/);
	assert.match(interactiveSource, /handleSuspendAction[\s\S]{0,120}observeLifecyclePromise\(this\.handleCtrlZ\(\)\)/);
	assert.match(interactiveSource, /disposeAfterUncaughtCrash[\s\S]{0,300}await this\.ui\.dispose\(\)/);
	assert.match(interactiveSource, /await this\.ui\.dispose\(\{ preserveScreen:/);
	assert.doesNotMatch(interactiveSource, /void this\.(?:shutdown|handleCtrlZ|handleOpenExternalEditor)\(/);
	assert.doesNotMatch(interactiveSource, /void this\.ui\.(?:stop|dispose)\(\)\.(?:then|finally)/);
	assert.doesNotMatch(interactiveSource, /onTuiModeChange:[\s\S]{0,120}void \(async/);

	const startupSource = readFileSync("packages/coding-agent/src/cli/startup-ui.ts", "utf8");
	assert.match(startupSource, /observeStartupLifecycle[\s\S]{0,220}promise\.then\(undefined, onRejected\)/);
	assert.match(startupSource, /await ui\.dispose\(\)/);
	assert.doesNotMatch(startupSource, /void ui\.stop\(\)\.then/);

	for (const path of [
		"packages/coding-agent/src/cli/config-selector.ts",
		"packages/coding-agent/src/cli/session-picker.ts",
	]) {
		const source = readFileSync(path, "utf8");
		assert.match(source, /await ui\.dispose\(\)/, path);
		assert.match(source, /observeStartupLifecycle\(/, path);
		assert.doesNotMatch(source, /void ui\.(?:stop|dispose)\(\)\.(?:then|finally)/, path);
	}

	const terminalSource = readFileSync("packages/tui/src/terminal.ts", "utf8");
	assert.match(terminalSource, /finalizeDisposeAfterEvents[\s\S]{0,260}removeListener\("error", this\.onFrameOutputError\)/);
	assert.match(terminalSource, /if \(this\.disposed\) throw new Error\("Cannot start a disposed ProcessTerminal"\)/);
});
