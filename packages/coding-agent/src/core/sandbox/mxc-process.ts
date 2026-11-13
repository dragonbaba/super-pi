import type { ChildProcess } from "node:child_process";
import { WindowsShellJob } from "../../utils/windows-shell-job.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";

/** One fixed byte ring per stream. Appending a chunk allocates no wrappers or slices. */
export class MxcOutputTail {
  private readonly bytes: Buffer;
  private position = 0;
  private length = 0;
  seen = 0;
  constructor(capacity: number) { this.bytes = Buffer.allocUnsafe(capacity); }
  append(chunk: Buffer): void {
    this.seen += chunk.length;
    const capacity = this.bytes.length;
    if (chunk.length >= capacity) {
      chunk.copy(this.bytes, 0, chunk.length - capacity); this.position = 0; this.length = capacity; return;
    }
    const first = Math.min(chunk.length, capacity - this.position);
    chunk.copy(this.bytes, this.position, 0, first);
    if (first < chunk.length) chunk.copy(this.bytes, 0, first);
    this.position = (this.position + chunk.length) % capacity;
    this.length = Math.min(capacity, this.length + chunk.length);
  }
  finish(): string {
    const start = this.length < this.bytes.length ? 0 : this.position;
    const ordered = this.length === this.bytes.length && start !== 0 ? Buffer.allocUnsafe(this.length) : this.bytes;
    if (ordered !== this.bytes) { this.bytes.copy(ordered, 0, start); this.bytes.copy(ordered, this.length - start, 0, start); }
    // Skip an incomplete UTF-8 prefix only when the retained tail cut a character.
    let offset = 0;
    if (this.seen > this.length) while (offset < this.length && (ordered[offset]! & 0xc0) === 0x80) offset++;
    return ordered.toString("utf8", offset, this.length);
  }
  get truncated(): boolean { return this.seen > this.length; }
}

export interface MxcProcessResult { code: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; stdoutBytes?: number; stderrBytes?: number; }

/** One invocation owns one Job, deadline and pair of byte rings through physical cleanup. */
export class MxcProcess {
  private job?: WindowsShellJob;
  private child?: ChildProcess;
  private cleanup?: Promise<string | undefined>;
  private stdout?: MxcOutputTail;
  private stderr?: MxcOutputTail;
  private active = false;
  private timedOut = false;
  private cleanupFailure?: string;
  private readonly onStdout = (chunk: Buffer): void => { this.stdout!.append(chunk); };
  private readonly onStderr = (chunk: Buffer): void => { this.stderr!.append(chunk); };
  private readonly stop = (): void => { if (this.job) this.cleanup ??= this.job.stop(); };
  private readonly expire = (): void => { this.timedOut = true; this.stop(); };
  get diagnostics() { return { active: this.active, retainedStreams: Number(!!this.stdout) + Number(!!this.stderr), child: !!this.child, job: !!this.job, cleanupFailure: this.cleanupFailure }; }
  assertStopped(): void {
    if (this.cleanupFailure) throw new Error(this.cleanupFailure);
    if (this.active) throw new Error("[MXC_BUSY] Process owner is already active");
  }

  async run(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
    signal: AbortSignal, timeoutMs: number, capacity = 32768): Promise<MxcProcessResult> {
    this.assertStopped();
    signal.throwIfAborted(); this.active = true; this.timedOut = false; this.cleanup = undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      this.job = await WindowsShellJob.spawn(executable, args, cwd, env, false, signal);
      const child = this.child = this.job.child;
      this.stdout = new MxcOutputTail(capacity); this.stderr = new MxcOutputTail(capacity);
      child.stdout!.on("data", this.onStdout); child.stderr!.on("data", this.onStderr);
      child.on("exit", this.stop);
      signal.addEventListener("abort", this.stop, { once: true });
      // Controlled file RPCs use the invocation signal rather than a shell
      // deadline. The SDK defines zero as no absolute execution timeout.
      if (timeoutMs > 0) timer = setTimeout(this.expire, timeoutMs);
      const waiting = waitForChildProcess(child);
      if (signal.aborted) this.stop();
      const code = await waiting;
      this.stop();
      const failure = await this.cleanup;
      if (failure || this.job.launchError || this.job.dispatchError)
        throw new Error(failure ?? this.job.dispatchError ?? this.job.launchError!.message);
      signal.throwIfAborted();
      return { code: code ?? 1, stdout: this.stdout.finish(), stderr: this.stderr.finish(),
        stdoutBytes: this.stdout.seen, stderrBytes: this.stderr.seen,
        truncated: this.stdout.truncated || this.stderr.truncated, timedOut: this.timedOut };
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", this.stop); this.stop();
      try {
        const failure = await this.cleanup;
        if (failure) { this.cleanupFailure = failure; throw new Error(failure); }
      } catch (error) {
        this.cleanupFailure ??= error instanceof Error ? error.message : String(error); throw error;
      }
      finally {
        this.child?.removeListener("exit", this.stop);
        this.child?.stdout?.removeListener("data", this.onStdout); this.child?.stderr?.removeListener("data", this.onStderr);
        this.child?.stdout?.destroy(); this.child?.stderr?.destroy();
        this.stdout = undefined; this.stderr = undefined; this.child = undefined; this.job = undefined; this.cleanup = undefined; this.active = false;
      }
    }
  }
}
