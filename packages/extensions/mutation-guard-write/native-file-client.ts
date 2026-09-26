import { Worker } from "node:worker_threads";

interface Reply { id: number; value?: any; error?: { message: string; nativeCode?: number; commitOutcome?: string; nativeUnavailable?: boolean }; milliseconds: number }
interface Pending { resolve(value: any): void; reject(error: Error): void }
let worker: Worker | undefined, sequence = 0;
let loadFailure: Error | undefined;
const pending = new Map<number, Pending>();
const timings = { calls: 0, totalNativeMilliseconds: 0, maxNativeMilliseconds: 0 };

function rejectPending(error: Error): void {
  if (timings.calls === 0) Object.assign(error, { nativeUnavailable: true });
  loadFailure = error;
  for (const call of pending.values()) call.reject(error);
  pending.clear();
  worker?.unref();
}

function receive(reply: Reply): void {
  const call = pending.get(reply.id);
  if (!call) return;
  pending.delete(reply.id);
  timings.calls++; timings.totalNativeMilliseconds += reply.milliseconds; timings.maxNativeMilliseconds = Math.max(timings.maxNativeMilliseconds, reply.milliseconds);
  if (!pending.size) worker?.unref();
  if (reply.error) {
    const error = Object.assign(new Error(reply.error.message), { nativeCode: reply.error.nativeCode, commitOutcome: reply.error.commitOutcome, nativeUnavailable: reply.error.nativeUnavailable });
    call.reject(error);
  } else call.resolve(reply.value);
}

function exited(code: number): void {
  if (worker) { rejectPending(new Error(`Native file worker exited (${code}); an in-flight replacement may have completed.`)); worker = undefined; }
}

/** Only internal file commit callers use this fixed protocol. No tool exposes native symbols or pointers. */
export async function nativeFileRequest(operation: "inspect" | "prepare" | "replace" | "remove" | "stats", input: Record<string, unknown> = {}): Promise<any> {
  if (loadFailure) throw loadFailure;
  if (pending.size >= 16) throw new Error("Native file operation queue is full; no operation was submitted.");
  if (!worker) {
    worker = new Worker(new URL("./native-file-worker.mjs", import.meta.url), { execArgv: [] });
    worker.on("message", receive); worker.on("error", rejectPending); worker.on("exit", exited);
    worker.unref();
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject }); worker!.ref();
    try { worker!.postMessage({ ...input, id, operation }); }
    catch (error) { pending.delete(id); if (!pending.size) worker!.unref(); reject(error); }
  });
}

export function nativeFileDiagnostics() { return { loaded: worker !== undefined, pending: pending.size, failed: loadFailure !== undefined, ...timings }; }

/** Test/process-owner release only; never terminate an in-flight OS operation to simulate cancellation. */
export async function disposeNativeFileWorker(): Promise<void> {
  if (pending.size) throw new Error("Cannot release native worker while a file operation is in flight.");
  const current = worker; worker = undefined;
  if (current) { current.removeListener("exit", exited); await current.terminate(); }
  loadFailure = undefined;
}
