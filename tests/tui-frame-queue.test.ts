import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { TerminalFrameQueue, type TerminalFrameSink } from "../packages/tui/src/terminal-frame-queue.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { ProcessTerminal, type Terminal } from "../packages/tui/src/terminal.ts";
import { TuiBase } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";

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
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.started = false;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void | Promise<void> {
		if (!this.backpressure) {
			this.writer.writes.push(data);
			return;
		}
		return this.writer.write(data);
	}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
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
	callback: ((error?: Error | null) => void) | undefined;
	returnValue = false;

	write(_data: string, callback: (error?: Error | null) => void): boolean {
		this.callback = callback;
		return this.returnValue;
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
	assert.match(queueSource, /while \(this\.busy \|\| this\.idleSettlementScheduled\) await this\.getIdlePromise\(\)/);
	assert.match(queueSource, /this\.sink\.cancelFrameWrite\(token\)/);
	assert.doesNotMatch(queueSource, /Promise<[^>]+>\[\]|Array<Promise|\.push\(|\.shift\(|ObjectPool|Proxy\s*\(/);
	assert.doesNotMatch(queueSource, /AbortController|TerminalFrameWriter|result\.then/);

	const terminalSource = readFileSync("packages/tui/src/terminal.ts", "utf8");
	assert.match(terminalSource, /writeFrame\(data: string,[\s\S]{0,2400}this\.frameOutput\.write\(data,/);
	assert.match(terminalSource, /frameWriteCallbackComplete && this\.frameWriteDrainComplete/);
	assert.match(terminalSource, /frameOutput\.once\("drain", this\.onFrameWriteDrain\)/);
	const writeFrameSource = terminalSource.match(/writeFrame\(data: string,[\s\S]*?\n\tprivate tryCompleteFrameWrite/)?.[0] ?? "";
	assert.doesNotMatch(writeFrameSource, /const (?:finish|maybeFinish|failOutput|onDrain|onClose|onAbort)\s*=|new Set/);
	assert.match(queueSource, /this\.sink\.writeFrame\(data, token\)/);
	assert.match(terminalSource, /setFrameWriteCompletionListener/);
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
	assert.match(interactiveSource, /await previousUi\.stop\(\{ preserveScreen: true \}\)/);
	assert.match(interactiveSource, /await this\.stopInteractiveTui\(fullscreenExitOutput\)/);
	assert.match(interactiveSource, /criticalAgentEnd: true/);
	assert.match(interactiveSource, /case "agent_end":[\s\S]{0,1200}await this\.ui\.flushTerminalFrames\(\)/);

	const sessionSource = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
	assert.match(sessionSource, /private async _emitAgentEnd/);
	assert.match(sessionSource, /if \(!registration\.criticalAgentEnd \|\| deadlineReached\)/);
	assert.match(sessionSource, /Promise\.race\(\[observed, getDeadline\(\)\]\)/);
	assert.match(sessionSource, /if \(event\.type === "agent_end"\) \{\s*await this\._emitAgentEnd/);
	const highFrequencyEmit = sessionSource.match(/private _emit\(event:[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.doesNotMatch(highFrequencyEmit, /await|Promise\.all|Promise<|\.then\(/);
});
