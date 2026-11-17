import { parentPort, workerData } from "node:worker_threads";
import { refreshProject } from "./core.js";
import { INDEX_PROGRESS } from "./index-progress.js";

const { cwd, project, progress } = workerData;
const state = new BigInt64Array(progress);
const control = {
  check() {
    if (Atomics.load(state, INDEX_PROGRESS.cancelled)) throw new DOMException("Index build cancelled", "AbortError");
  },
  progress(stage, count) {
    Atomics.store(state, INDEX_PROGRESS.files, BigInt(count));
    Atomics.store(state, INDEX_PROGRESS.stage, stage);
  },
};

try {
  parentPort.postMessage({ ok: true, result: refreshProject(cwd, project, { control }) });
} catch (error) {
  parentPort.postMessage({ ok: false, cancelled: error?.name === "AbortError", message: error instanceof Error ? error.message : String(error) });
} finally { parentPort.close(); }
