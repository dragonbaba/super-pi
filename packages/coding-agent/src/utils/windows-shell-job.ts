import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { waitForChildProcess } from "./child-process.ts";

// The host cannot launch a command until the parent has assigned it to its job.
// OS stdio handles go straight to the shell: no JS output forwarding or polling.
const HOST_SOURCE = `
const {spawn} = require('node:child_process');
process.once('message', ({shell,args,env}) => {
  const child = spawn(shell,args,{env,stdio:[process.stdin,process.stdout,process.stderr],windowsHide:true});
  child.once('error', error => process.send({error:error.message,code:error.code}, () => process.exit(1)));
  child.once('exit', code => process.exit(code === null ? 1 : code));
});
process.once('disconnect', () => process.exit(1));
`;
let handles = 0, processHandles = 0, created = 0, cleanupChecks = 0;

async function loadBindings() {
	const { default: koffi } = await import("koffi");
	// kernel32 is a KnownDLL. No request controls the library or symbol names.
	const kernel = koffi.load("kernel32.dll");
	return {
		create: kernel.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)"),
		set: kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32_t size)"),
		open: kernel.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
		assign: kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)"),
		terminate: kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t code)"),
		query: kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *info, uint32_t size, void *needed)"),
		close: kernel.func("int __stdcall CloseHandle(void *handle)"),
		error: kernel.func("uint32_t __stdcall GetLastError(void)"),
	};
}
type Bindings = Awaited<ReturnType<typeof loadBindings>>;
let bindings: Promise<Bindings> | undefined;

/** One Windows background invocation; job membership survives MSYS reparenting. */
export class WindowsShellJob {
	readonly child: ChildProcess;
	launchError: NodeJS.ErrnoException | undefined;
	dispatchError: string | undefined;
	private job: unknown;
	private readonly native: Bindings;
	private cleanup: Promise<string | undefined> | undefined;
	private readonly accounting = Buffer.alloc(48);
	private readonly onMessage = (message: unknown): void => {
		const value = message as { error?: unknown; code?: unknown } | null;
		if (!value || typeof value.error !== "string") return;
		this.launchError = new Error(value.error.slice(0, 1000));
		if (typeof value.code === "string") this.launchError.code = value.code;
	};
	private readonly onSend = (error: Error | null): void => {
		if (!error) return;
		// A failed IPC write cannot prove whether the host received the request.
		this.dispatchError = `Managed shell dispatch failed: ${error.message}`.slice(0, 1000);
		void this.stop();
	};
	private constructor(native: Bindings, job: unknown, child: ChildProcess) {
		this.native = native; this.job = job; this.child = child;
		child.on("message", this.onMessage);
	}

	static async spawn(shell: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stdin: boolean, signal?: AbortSignal, beforeSpawn?: (cwd: string) => void): Promise<WindowsShellJob> {
		if (process.platform !== "win32" || process.arch !== "x64" && process.arch !== "arm64") throw new Error("Managed Windows shells require a 64-bit Windows runtime.");
		const native = await (bindings ??= loadBindings());
		signal?.throwIfAborted(); beforeSpawn?.(cwd);
		const job = native.create(null, null);
		if (!job) throw new Error(`CreateJobObject failed (${native.error()}).`);
		handles++; created++;
		let child: ChildProcess | undefined;
		try {
			// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, 64-bit ABI. Kill on last close;
			// no breakaway flags. Child jobs remain inside this job's ownership.
			const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
			if (!native.set(job, 9, limits, limits.length)) throw new Error(`SetInformationJobObject failed (${native.error()}).`);
			child = spawn(process.execPath, ["--input-type=commonjs", "-e", HOST_SOURCE], {
				cwd, env: { ...env, NODE_OPTIONS: "", NODE_PATH: "" }, windowsHide: true,
				stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe", "ipc"],
			});
			if (child.pid) {
				const processHandle = native.open(0x101, 0, child.pid); // SET_QUOTA | TERMINATE
				if (!processHandle) throw new Error(`OpenProcess failed (${native.error()}).`);
				processHandles++;
				try { if (!native.assign(job, processHandle)) throw new Error(`AssignProcessToJobObject failed (${native.error()}).`); }
				finally {
					if (native.close(processHandle)) processHandles--;
					else throw new Error(`CloseHandle(process) failed (${native.error()}).`);
				}
			}
			const owner = new WindowsShellJob(native, job, child);
			if (child.pid) child.send({ shell, args, env }, owner.onSend);
			return owner;
		} catch (error) {
			if (child) {
				const exit = waitForChildProcess(child);
				child.kill();
				try { await exit; } catch { /* Preserve the admission error. */ }
			}
			if (native.close(job)) handles--;
			throw error;
		}
	}

	stop(): Promise<string | undefined> { return this.cleanup ??= this.close(); }
	private async close(): Promise<string | undefined> {
		let failure: string | undefined;
		try {
			if (!this.native.terminate(this.job, 1)) failure = `TerminateJobObject failed (${this.native.error()})`;
			// Bounded cancellation deadline only; no timer while output is delivered.
			const deadline = performance.now() + 5000;
			for (;;) {
				cleanupChecks++;
				if (!this.native.query(this.job, 1, this.accounting, this.accounting.length, null)) { failure ??= `QueryInformationJobObject failed (${this.native.error()})`; break; }
				if (this.accounting.readUInt32LE(40) === 0) break;
				if (performance.now() >= deadline) { failure ??= "job still has active processes after 5000ms"; break; }
				await delay(10);
			}
		} catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
		finally {
			try { if (this.native.close(this.job)) handles--; else failure ??= `CloseHandle failed (${this.native.error()})`; }
			catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
			this.job = undefined;
			this.child.removeListener("message", this.onMessage);
		}
		return failure === undefined ? undefined : `Process-tree cleanup failed: ${failure}`.slice(0, 1000);
	}
}

/** Explicit diagnostics/test boundary, never used during output delivery. */
export function windowsShellJobDiagnostics() { return { handles, processHandles, created, cleanupChecks }; }
