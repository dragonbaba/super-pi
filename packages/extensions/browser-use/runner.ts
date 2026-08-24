import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

const FORCE_KILL_DELAY_MS = 2_000;
const TERMINATION_SETTLE_MS = 5_000;
const IGNORE_ERROR = () => undefined;

type RunResolve = (result: BrowserUseRunResult) => void;
type RunReject = (error: Error) => void;
type TerminationReason = "timeout" | "abort";

function signalOwnedProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (!pid) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to the direct child if the process group has already exited.
    }
  }
  return child.kill(signal);
}

export interface BrowserUseRunOptions {
  command: string;
  args?: readonly string[];
  code: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytesPerStream: number;
  signal?: AbortSignal;
}

export interface BrowserUseRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

class BoundedStream {
  readonly #chunks: Buffer[] = [];
  readonly #maxBytes: number;
  #retainedBytes = 0;
  totalBytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += chunk.byteLength;
    const remaining = this.#maxBytes - this.#retainedBytes;
    if (remaining <= 0) return;
    const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    this.#chunks.push(retained);
    this.#retainedBytes += retained.byteLength;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#retainedBytes).toString("utf8");
  }

  get truncated(): boolean {
    return this.totalBytes > this.#retainedBytes;
  }
}

function handleDeadline(run: BrowserUseProcessRun): void {
  run.terminate("timeout");
}

function handleForceKill(run: BrowserUseProcessRun): void {
  run.forceKill();
}

function handleTerminationSettle(run: BrowserUseProcessRun): void {
  run.finishTermination();
}

class BrowserUseProcessRun {
  #child: ChildProcessWithoutNullStreams | undefined;
  #killer: ChildProcess | undefined;
  #signal: AbortSignal | undefined;
  #stdout: BoundedStream | undefined;
  #stderr: BoundedStream | undefined;
  #resolve: RunResolve | undefined;
  #reject: RunReject | undefined;
  #deadlineTimeout: NodeJS.Timeout | undefined;
  #forceKillTimeout: NodeJS.Timeout | undefined;
  #terminationSettleTimeout: NodeJS.Timeout | undefined;
  #closeCode: number | null | undefined;
  #settled = false;
  #killed = false;
  #timedOut = false;
  #aborted = false;
  #spawnCompleted = false;
  #terminationRequested = false;
  #abortAttached = false;
  #killerDone = false;

  readonly #onAbort = this.onAbort.bind(this);
  readonly #onStdout = this.onStdout.bind(this);
  readonly #onStderr = this.onStderr.bind(this);
  readonly #onSpawn = this.onSpawn.bind(this);
  readonly #onChildError = this.onChildError.bind(this);
  readonly #onClose = this.onClose.bind(this);
  readonly #onKillerError = this.onKillerError.bind(this);
  readonly #onKillerClose = this.onKillerClose.bind(this);

  constructor(options: BrowserUseRunOptions, resolve: RunResolve, reject: RunReject) {
    this.#signal = options.signal;
    this.#stdout = new BoundedStream(options.maxBytesPerStream);
    this.#stderr = new BoundedStream(options.maxBytesPerStream);
    this.#resolve = resolve;
    this.#reject = reject;
    this.#child = spawn(options.command, options.args ? [...options.args] : [], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.start(options.code, options.timeoutMs);
  }

  terminate(reason: TerminationReason): void {
    const child = this.#child;
    if (!child || this.#settled || this.#terminationRequested) return;
    this.#terminationRequested = true;
    this.clearDeadline();
    this.detachAbort();
    this.#timedOut = reason === "timeout";
    this.#aborted = reason === "abort";
    if (process.platform === "win32") {
      this.startWindowsTreeKill(child);
      return;
    }
    this.#killed = signalOwnedProcessTree(child, "SIGTERM");
    this.#forceKillTimeout = setTimeout(handleForceKill, FORCE_KILL_DELAY_MS, this);
    this.#forceKillTimeout.unref();
  }

  forceKill(): void {
    this.#forceKillTimeout = undefined;
    const child = this.#child;
    if (child && !this.#settled) this.#killed = signalOwnedProcessTree(child, "SIGKILL") || this.#killed;
    if (this.#closeCode !== undefined) this.finishTermination();
    else this.armTerminationSettle();
  }

  finishTermination(): void {
    if (this.#settled) return;
    const killer = this.#killer;
    if (killer && !this.#killerDone) {
      this.#stderr?.append("\n[tree termination timed out]");
      killer.kill("SIGKILL");
    }
    const child = this.#child;
    if (child && this.#closeCode === undefined) {
      const directKilled = child.kill("SIGKILL");
      if (process.platform !== "win32") this.#killed = directKilled || this.#killed;
    }
    this.settle(this.#closeCode ?? 1);
  }

  private start(code: string, timeoutMs: number): void {
    const child = this.#child!;
    child.stdout.on("data", this.#onStdout);
    child.stderr.on("data", this.#onStderr);
    child.stdin.on("error", IGNORE_ERROR);
    child.once("spawn", this.#onSpawn);
    child.on("error", this.#onChildError);
    child.once("close", this.#onClose);

    if (this.#signal) {
      this.#signal.addEventListener("abort", this.#onAbort, { once: true });
      this.#abortAttached = true;
    }
    if (this.#signal?.aborted) this.terminate("abort");
    if (!this.#terminationRequested) {
      this.#deadlineTimeout = setTimeout(handleDeadline, timeoutMs, this);
      this.#deadlineTimeout.unref();
    }
    child.stdin.end(code, "utf8");
  }

  private startWindowsTreeKill(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) {
      child.kill("SIGKILL");
      this.armTerminationSettle();
      return;
    }
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    this.#killer = killer;
    killer.once("error", this.#onKillerError);
    killer.once("close", this.#onKillerClose);
    this.armTerminationSettle();
  }

  private onAbort(): void {
    this.terminate("abort");
  }

  private onStdout(chunk: Buffer | string): void {
    this.#stdout?.append(chunk);
  }

  private onStderr(chunk: Buffer | string): void {
    this.#stderr?.append(chunk);
  }

  private onSpawn(): void {
    this.#spawnCompleted = true;
  }

  private onChildError(error: Error): void {
    if (this.#settled) return;
    if (this.#spawnCompleted) {
      this.#stderr?.append(`\n[process error] ${error.message}`);
      return;
    }
    this.#settled = true;
    const reject = this.#reject;
    this.dispose();
    reject?.(error);
  }

  private onClose(code: number | null): void {
    if (this.#settled) return;
    this.#closeCode = code;
    if (!this.#terminationRequested) {
      this.settle(code ?? 1);
      return;
    }
    if (process.platform === "win32") {
      if (this.#killerDone) this.finishTermination();
      return;
    }
    if (!this.#forceKillTimeout) this.finishTermination();
  }

  private onKillerError(error: Error): void {
    if (this.#settled || this.#killerDone) return;
    this.#killerDone = true;
    this.#stderr?.append(`\n[tree termination error] ${error.message}`);
    const child = this.#child;
    if (child && this.#closeCode === undefined) child.kill("SIGKILL");
    if (this.#closeCode !== undefined) this.finishTermination();
  }

  private onKillerClose(code: number | null): void {
    if (this.#settled || this.#killerDone) return;
    this.#killerDone = true;
    if (code === 0) this.#killed = true;
    else {
      this.#stderr?.append(`\n[tree termination exit ${code ?? 1}]`);
      const child = this.#child;
      if (child && this.#closeCode === undefined) child.kill("SIGKILL");
    }
    if (this.#closeCode !== undefined) this.finishTermination();
  }

  private settle(code: number): void {
    if (this.#settled) return;
    this.#settled = true;
    const stdout = this.#stdout!;
    const stderr = this.#stderr!;
    const result: BrowserUseRunResult = {
      stdout: stdout.text(),
      stderr: stderr.text(),
      exitCode: code,
      killed: this.#killed,
      timedOut: this.#timedOut,
      aborted: this.#aborted,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
    };
    const resolve = this.#resolve;
    this.dispose();
    resolve?.(result);
  }

  private armTerminationSettle(): void {
    if (this.#terminationSettleTimeout) return;
    this.#terminationSettleTimeout = setTimeout(handleTerminationSettle, TERMINATION_SETTLE_MS, this);
    this.#terminationSettleTimeout.unref();
  }

  private clearDeadline(): void {
    if (!this.#deadlineTimeout) return;
    clearTimeout(this.#deadlineTimeout);
    this.#deadlineTimeout = undefined;
  }

  private detachAbort(): void {
    if (!this.#abortAttached) return;
    this.#signal!.removeEventListener("abort", this.#onAbort);
    this.#abortAttached = false;
  }

  private dispose(): void {
    this.clearDeadline();
    if (this.#forceKillTimeout) {
      clearTimeout(this.#forceKillTimeout);
      this.#forceKillTimeout = undefined;
    }
    if (this.#terminationSettleTimeout) {
      clearTimeout(this.#terminationSettleTimeout);
      this.#terminationSettleTimeout = undefined;
    }
    this.detachAbort();
    const killer = this.#killer;
    if (killer) {
      killer.removeListener("error", this.#onKillerError);
      killer.removeListener("close", this.#onKillerClose);
    }
    const child = this.#child;
    if (child) {
      child.stdout.removeListener("data", this.#onStdout);
      child.stderr.removeListener("data", this.#onStderr);
      child.stdin.removeListener("error", IGNORE_ERROR);
      child.removeListener("spawn", this.#onSpawn);
      child.removeListener("error", this.#onChildError);
      child.removeListener("close", this.#onClose);
    }
    this.#killer = undefined;
    this.#child = undefined;
    this.#signal = undefined;
    this.#stdout = undefined;
    this.#stderr = undefined;
    this.#resolve = undefined;
    this.#reject = undefined;
  }
}

export function runBrowserUse(options: BrowserUseRunOptions): Promise<BrowserUseRunResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      stdout: "", stderr: "", exitCode: 1, killed: false, timedOut: false, aborted: true,
      stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0,
    });
  }
  return new Promise((resolve, reject) => {
    new BrowserUseProcessRun(options, resolve, reject);
  });
}
