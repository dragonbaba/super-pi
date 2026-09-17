import { Worker } from "node:worker_threads";

/** Optional, operation-level diagnostics; never installed on ordinary input/render. */
export type ImageDecodeObserver = (event: { type: string; at?: number; elapsed?: number; active?: number; wasmBytes?: number; rss?: number }) => void;
const DECODE_TIMEOUT_MS = 10000;
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./image-decode-worker.ts" : "./image-decode-worker.js", import.meta.url);

/** Resolves/rejects only after worker exit, including cancel, error and timeout. */
export function decodeImageLocally(bytes: Uint8Array, signal: AbortSignal, observer?: ImageDecodeObserver): Promise<{ width: number; height: number }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const worker = new Worker(WORKER_URL, { workerData: { bytes, observe: Boolean(observer) },
			execArgv: import.meta.url.endsWith(".ts") ? ["--experimental-strip-types"] : [] });
		let dimensions: { width: number; height: number } | undefined;
		let failure: Error | undefined;
		const abort = () => { failure ??= new Error("图片校验已取消"); void worker.terminate().catch(observeTerminationFailure); };
		function observeTerminationFailure(error: Error) { failure ??= error; }
		const timeout = setTimeout(() => { failure = new Error("图片校验超时，请重新添加"); abort(); }, DECODE_TIMEOUT_MS);
		signal.addEventListener("abort", abort, { once: true });
		worker.on("message", (event) => {
			if (event.type === "result") dimensions = { width: event.width, height: event.height };
			else observer?.(event);
		});
		worker.once("error", (error) => { failure ??= error; });
		worker.once("exit", (code) => {
			clearTimeout(timeout); signal.removeEventListener("abort", abort); worker.removeAllListeners();
			observer?.({ type: "worker-exit", at: performance.now(), active: 0 });
			if (failure || code !== 0 || !dimensions) reject(failure ?? new Error(`图片校验器退出 (${code})`));
			else resolve(dimensions);
		});
		if (signal.aborted) abort();
	});
}
