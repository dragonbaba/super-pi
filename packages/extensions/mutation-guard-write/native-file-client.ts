import { Worker } from "node:worker_threads";

interface Reply { id: number; value?: any; error?: { message: string; nativeCode?: number; commitOutcome?: string; nativeUnavailable?: boolean }; milliseconds: number }
interface Pending { resolve(value: any): void; reject(error: Error): void }
interface NativeOwner {
  worker?: Worker; sequence: number; loadFailure?: Error; releasing: boolean; workerCalls: number; workerStarts: number;
  pending: Map<number, Pending>;
  timings: { calls: number; totalNativeMilliseconds: number; maxNativeMilliseconds: number; pendingHighWaterMark: number };
}
// Source/Jiti resource reloads must reuse one process owner instead of retaining
// a new native worker for each Session. This stores no Session, request or content.
const OWNER = Symbol.for("pi.native-file-worker.owner.v1");
const root = globalThis as typeof globalThis & { [OWNER]?: NativeOwner };
const owner: NativeOwner = root[OWNER] ??= { sequence: 0, releasing: false, workerCalls: 0, workerStarts: 0, pending: new Map(),
  timings: { calls: 0, totalNativeMilliseconds: 0, maxNativeMilliseconds: 0, pendingHighWaterMark: 0 } };
const { pending, timings } = owner;

function rejectPending(error: Error): void {
  if (owner.workerCalls === 0) Object.assign(error, { nativeUnavailable: true });
  owner.loadFailure = error;
  for (const call of pending.values()) call.reject(error);
  pending.clear();
  owner.worker?.unref();
}

function receive(reply: Reply): void {
  const call = pending.get(reply.id);
  if (!call) return;
  pending.delete(reply.id);
  owner.workerCalls++;
  timings.calls++; timings.totalNativeMilliseconds += reply.milliseconds; timings.maxNativeMilliseconds = Math.max(timings.maxNativeMilliseconds, reply.milliseconds);
  if (!pending.size) owner.worker?.unref();
  if (reply.error) {
    const error = Object.assign(new Error(reply.error.message), { nativeCode: reply.error.nativeCode, commitOutcome: reply.error.commitOutcome, nativeUnavailable: reply.error.nativeUnavailable });
    call.reject(error);
  } else call.resolve(reply.value);
}

function exited(code: number): void {
  if (owner.worker) { rejectPending(new Error(`Native file worker exited (${code}); an in-flight replacement may have completed.`)); owner.worker = undefined; }
}

/** Only internal file commit callers use this fixed protocol. No tool exposes native symbols or pointers. */
export async function nativeFileRequest(operation: "inspect" | "protect" | "prepare" | "replace" | "remove" | "stats", input: Record<string, unknown> = {}): Promise<any> {
  if (owner.loadFailure) throw owner.loadFailure;
  if (owner.releasing) throw new Error("Native file worker release is in progress; no operation was submitted.");
  if (pending.size >= 16) throw new Error("Native file operation queue is full; no operation was submitted.");
  if (!owner.worker) {
    owner.workerCalls = 0; owner.workerStarts++;
    owner.worker = new Worker(new URL("./native-file-worker.mjs", import.meta.url), { execArgv: [] });
    owner.worker.on("message", receive); owner.worker.on("error", rejectPending); owner.worker.on("exit", exited);
    owner.worker.unref();
  }
  const id = ++owner.sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject }); owner.worker!.ref();
    timings.pendingHighWaterMark = Math.max(timings.pendingHighWaterMark, pending.size);
    try { owner.worker!.postMessage({ ...input, id, operation }); }
    catch (error) { pending.delete(id); if (!pending.size) owner.worker!.unref(); reject(error); }
  });
}

export function nativeFileDiagnostics() { return { loaded: owner.worker !== undefined, pending: pending.size, failed: owner.loadFailure !== undefined, releasing: owner.releasing, workerStarts: owner.workerStarts, ...timings }; }

function disposedWorkerError(): void { /* Dispose retains a late-error observer until termination settles. */ }

/** Test/process-owner release only; never terminate an in-flight OS operation to simulate cancellation. */
export async function disposeNativeFileWorker(): Promise<void> {
  if (pending.size) throw new Error("Cannot release native worker while a file operation is in flight.");
  if (owner.releasing) throw new Error("Native file worker release is already in progress.");
  const current = owner.worker; owner.worker = undefined; owner.releasing = true;
  try {
    if (current) {
      current.removeAllListeners("exit"); current.removeAllListeners("message"); current.removeAllListeners("error");
      current.on("error", disposedWorkerError);
      await current.terminate(); current.removeAllListeners();
    }
    owner.loadFailure = undefined;
  } finally { owner.releasing = false; }
}
