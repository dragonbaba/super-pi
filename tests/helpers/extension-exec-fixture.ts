import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { WindowsShellJob } from "../../packages/coding-agent/src/utils/windows-shell-job.ts";

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
	cleanupGate: Promise<string | undefined> | undefined;
	cleanupFailure: string | undefined;
	stopCount = 0;
	readonly ready: Promise<void>;
	constructor() {
		super();
		const output = this.stdout;
		this.ready = new Promise(resolve => {
			function onListener(event: string): void {
				if (event !== "data" || output.listenerCount("data") !== 1) return;
				output.removeListener("newListener", onListener); resolve();
			}
			output.on("newListener", onListener);
		});
	}
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
	const originalJob = WindowsShellJob.spawn, originalKill = process.kill;
	let groupGone = false, cleanup: Promise<string | undefined> | undefined;
	// The exact fake PGID must never reach the OS.
	process.kill = ((pid: number, signal: NodeJS.Signals | number = "SIGTERM") => {
		if (pid !== -child.pid) return originalKill(pid, signal);
		if (groupGone || child.exitCode !== null || child.signalCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		if (signal === 0) return true;
		if (signal === "SIGKILL") groupGone = true;
		return child.kill(signal as NodeJS.Signals);
	}) as typeof process.kill;
	WindowsShellJob.spawn = (async (_command, _args, cwd, _env, _stdin, signal, beforeSpawn) => {
		signal?.throwIfAborted(); beforeSpawn?.(cwd);
		onSpawn?.({ cwd, shell: false, windowsHide: true });
		return { child, stop() {
			if (cleanup) return cleanup;
			child.stopCount++;
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			return cleanup = child.cleanupGate ?? Promise.resolve(child.cleanupFailure);
		} } as unknown as WindowsShellJob;
	}) as typeof WindowsShellJob.spawn;
	childProcess.spawn = ((_command: string, _args: string[], options: childProcess.SpawnOptions) => {
		onSpawn?.(options);
		return child as unknown as ChildProcess;
	}) as typeof childProcess.spawn;
	syncBuiltinESMExports();
	return () => { childProcess.spawn = original; WindowsShellJob.spawn = originalJob; process.kill = originalKill; syncBuiltinESMExports(); };
}
