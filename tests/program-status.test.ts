import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { formatProgramStatus, isProgramStatusReply, PROGRAM_STATUS_QUERY, sanitizeProgramStatusMessage } from "../packages/tui/src/program-status.ts";
import { ProcessTerminal } from "../packages/tui/src/terminal.ts";

class Input extends EventEmitter {
	isRaw = false;
	setRawMode(raw: boolean) { this.isRaw = raw; }
	setEncoding() {}
	resume() {}
	pause() {}
}
class Output extends EventEmitter {
	columns = 80;
	rows = 24;
	writes: string[] = [];
	gate = false;
	throwStatus = false;
	callback: ((error?: Error) => void) | undefined;
	write(data: string, callback: (error?: Error) => void): boolean {
		this.writes.push(data);
		if (data.startsWith("\x1b]7501;state=")) {
			if (this.throwStatus) throw new Error("fixture output failure");
			if (this.gate) { assert.equal(this.callback, undefined); this.callback = callback; return false; }
		}
		callback();
		return true;
	}
	finish(error?: Error) { const callback = this.callback; this.callback = undefined; callback?.(error); }
	statuses() { return this.writes.filter(value => value.startsWith("\x1b]7501;state=")); }
}
function fixture(override?: string) {
	const previous = process.env.SP_PROGRAM_STATUS;
	if (override === undefined) delete process.env.SP_PROGRAM_STATUS;
	else process.env.SP_PROGRAM_STATUS = override;
	const input = new Input(), output = new Output(), received: string[] = [];
	const terminal = new ProcessTerminal(output as never, { input: input as never, resizeSource: output as never });
	(terminal as any).enableWindowsVTInput = () => {};
	const start = () => terminal.start(value => received.push(value), () => {});
	return { terminal, input, output, received, start, release() {
		terminal.dispose(); output.finish(); output.emit("drain");
		if (previous === undefined) delete process.env.SP_PROGRAM_STATUS;
		else process.env.SP_PROGRAM_STATUS = previous;
	} };
}
const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

test("OSC encoding bounds UTF-8 text, strips controls and excludes invalid app/kind fields", () => {
	const sequence = formatProgramStatus("blocked", "\x1bHello\r\n世界\x9f", "permission", "superpi");
	assert.equal(sequence, "\x1b]7501;state=blocked:app=superpi:kind=permission:msg=SGVsbG8g5LiW55WM\x1b\\");
	const huge = formatProgramStatus("done", "🙂".repeat(100_000), "auth", "bad;app");
	const encoded = huge.match(/:msg=([^\x1b]+)/)![1];
	const decoded = Buffer.from(encoded, "base64");
	assert.equal(decoded.length, 2048);
	assert.ok(encoded.length <= 2732 && Buffer.byteLength(huge) < 4096);
	assert.equal(decoded.toString(), "🙂".repeat(512));
	assert.ok(!huge.includes("kind=") && !huge.includes("app="));
	assert.equal(sanitizeProgramStatusMessage("\x00\t\n"), undefined);
	assert.equal(isProgramStatusReply("\x1b]7501;?:states=idle,working:future=yes\x07"), true);
	assert.equal(isProgramStatusReply("\x1b]7501;?garbage\x07"), false);
});

for (const terminator of ["\x07", "\x1b\\"]) test(`auto-detection consumes split replies terminated by ${JSON.stringify(terminator)}`, () => {
	const f = fixture();
	try {
		f.terminal.setProgramStatus("idle", undefined, undefined, "superpi");
		f.start();
		assert.equal(f.output.statuses().length, 0);
		const query = f.output.writes.find(value => value.includes(PROGRAM_STATUS_QUERY))!;
		assert.ok(query.indexOf(PROGRAM_STATUS_QUERY) < query.indexOf("\x1b[c"));
		const reply = "\x1b]7501;?:states=idle,working,done,blocked,error" + terminator;
		for (const char of reply) f.input.emit("data", char);
		f.input.emit("data", "\x1b[?1;2c");
		f.input.emit("data", "x");
		assert.deepEqual(f.received, ["x"]);
		assert.equal(f.output.statuses().length, 1);
		for (let i = 0; i < 100_000; i++) f.terminal.setProgramStatus("idle", undefined, undefined, "superpi");
		assert.equal(f.output.statuses().length, 1);
	} finally { f.release(); }
});

test("DA first rejects late support; restart negotiates and replays only latest status", () => {
	const f = fixture();
	try {
		f.start(); f.terminal.setProgramStatus("working");
		f.input.emit("data", "\x1b[?1;2c" + PROGRAM_STATUS_QUERY);
		assert.equal(f.output.statuses().length, 0);
		f.terminal.stop(); f.terminal.setProgramStatus("done"); f.start();
		f.input.emit("data", PROGRAM_STATUS_QUERY + "\x1b[?1;2c");
		assert.deepEqual(f.output.statuses(), [formatProgramStatus("done")]);
		assert.deepEqual(f.received, []);
	} finally { f.release(); }
});

for (const override of ["0", "1"]) test(`SP_PROGRAM_STATUS=${override} bypasses query`, () => {
	const f = fixture(override);
	try {
		f.start(); f.terminal.setProgramStatus("done");
		assert.equal(f.output.writes.some(value => value.includes(PROGRAM_STATUS_QUERY)), false);
		f.input.emit("data", PROGRAM_STATUS_QUERY);
		assert.equal(f.output.statuses().length, override === "1" ? 1 : 0);
	} finally { f.release(); }
});

for (const drainFirst of [false, true]) test(`status writes retain only latest pending state; drainFirst=${drainFirst}`, async () => {
	const f = fixture("1");
	try {
		f.start(); f.output.gate = true;
		f.terminal.setProgramStatus("working");
		for (let i = 0; i < 1000; i++) f.terminal.setProgramStatus(i % 2 ? "idle" : "blocked", "bounded", "question");
		f.terminal.setProgramStatus("done");
		assert.equal(f.output.statuses().length, 1);
		assert.equal((f.terminal as any).controlWritesOutstanding, 1);
		if (drainFirst) f.output.emit("drain"); else f.output.finish();
		assert.equal(f.output.statuses().length, 1);
		if (drainFirst) f.output.finish(); else f.output.emit("drain");
		assert.deepEqual(f.output.statuses(), [formatProgramStatus("working"), formatProgramStatus("done")]);
		f.terminal.dispose();
		assert.equal((f.terminal as any).programStatusSequence, undefined);
		assert.equal(f.output.listenerCount("error"), 1, "pending OS write retains its error observer");
		f.output.finish(); f.output.emit("drain"); await nextTask();
		assert.equal(f.output.listenerCount("error"), 0);
		assert.equal(f.output.listenerCount("close"), 0);
		assert.equal(f.output.listenerCount("drain"), 0);
		assert.equal((f.terminal as any).controlWritesOutstanding, 0);
	} finally { f.release(); }
});

for (const failure of ["throw", "callback", "close", "error"] as const) test(`status output ${failure} failure releases logical state and observers`, async () => {
	const f = fixture("1");
	try {
		f.start(); f.output.gate = true;
		if (failure === "throw") { f.output.throwStatus = true; assert.throws(() => f.terminal.setProgramStatus("working"), /fixture/); }
		else {
			f.terminal.setProgramStatus("working");
			if (failure === "callback") f.output.finish(new Error("fixture callback"));
			else f.output.emit(failure, new Error("fixture event"));
		}
		assert.equal((f.terminal as any).programStatusSequence, undefined);
		assert.equal((f.terminal as any).programStatusMessage, undefined);
		assert.equal((f.terminal as any).controlWritesOutstanding, 0);
		f.terminal.dispose(); f.output.finish(); await nextTask();
		assert.equal(f.output.listenerCount("error"), 0);
		assert.equal(f.input.listenerCount("data"), 0);
	} finally { f.release(); }
});

test("stopping during status write suppresses pending writes until restart", () => {
	const f = fixture("1");
	try {
		f.start(); f.output.gate = true;
		f.terminal.setProgramStatus("working"); f.terminal.setProgramStatus("done");
		f.terminal.stop(); f.output.finish(); f.output.emit("drain");
		assert.equal(f.output.statuses().length, 1);
		f.start();
		assert.deepEqual(f.output.statuses(), [formatProgramStatus("working"), formatProgramStatus("done")]);
	} finally { f.release(); }
});

test("a pending status write failure cannot escape its drain callback", () => {
	const f = fixture("1");
	try {
		f.start(); f.output.gate = true;
		f.terminal.setProgramStatus("working"); f.terminal.setProgramStatus("done");
		f.output.finish(); f.output.throwStatus = true;
		assert.doesNotThrow(() => f.output.emit("drain"));
		assert.equal((f.terminal as any).programStatusSequence, undefined);
		assert.equal((f.terminal as any).controlWritesOutstanding, 0);
	} finally { f.release(); }
});

test("disposed terminal owners collect after status callback/drain completion", { skip: !global.gc }, async () => {
	const refs: WeakRef<object>[] = [];
	function run() {
		const f = fixture("1"); refs.push(new WeakRef(f.terminal), new WeakRef(f.input), new WeakRef(f.output));
		f.start(); f.output.gate = true; f.terminal.setProgramStatus("working", "bounded"); f.release();
	}
	run();
	for (let i = 0; i < 8; i++) { await nextTask(); global.gc!(); }
	assert.equal(refs.filter(ref => ref.deref()).length, 0);
});
