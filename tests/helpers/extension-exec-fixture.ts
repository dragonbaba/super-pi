import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

/** A deterministic spawn boundary; production exec/wait/output callbacks are real. */
export class ExecFixture extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = null;
	pid = 123;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	signals: NodeJS.Signals[] = [];
	autoExit = true;
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killed = true;
		this.signals.push(signal);
		if (this.autoExit) process.nextTick(this.finishSignal);
		return true;
	}
	private readonly finishSignal = (): void => this.finish(null, this.signals[this.signals.length - 1]);
	finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code; this.signalCode = signal;
		this.emit("exit", code, signal);
		this.stdout.emit("end"); this.stderr.emit("end");
		this.emit("close", code, signal);
	}
	assertReleased(): void {
		for (const event of ["spawn", "error", "exit", "close"]) assert.equal(this.listenerCount(event), 0, event);
		for (const pipe of [this.stdout, this.stderr]) {
			assert.equal(pipe.listenerCount("data"), 0); assert.equal(pipe.listenerCount("end"), 0);
			assert.equal(pipe.destroyed, true);
		}
	}
}

export function installExecFixture(child: ExecFixture, onSpawn?: (options: childProcess.SpawnOptions) => void): () => void {
	const original = childProcess.spawn;
	childProcess.spawn = ((_command: string, _args: string[], options: childProcess.SpawnOptions) => {
		onSpawn?.(options);
		return child as unknown as ChildProcess;
	}) as typeof childProcess.spawn;
	syncBuiltinESMExports();
	return () => { childProcess.spawn = original; syncBuiltinESMExports(); };
}
