import { Worker } from "node:worker_threads";
import { BorderedLoader, CONFIG_DIR_NAME } from "./pi-compat.js";
import { INDEX_PROGRESS } from "./index-progress.js";

const PROGRESS_KEY = "project-context-index";
const PROGRESS_MS = 150;
const STAGE_LABELS = ["Preparing project index", "Scanning project files", "Sorting and writing index", "Publishing project context"];

function startIndexWorker(cwd, project, ui, signal) {
  if (signal?.aborted) return Promise.resolve(cancelledOutcome());
  const progress = new SharedArrayBuffer(INDEX_PROGRESS.size * BigInt64Array.BYTES_PER_ELEMENT);
  const state = new BigInt64Array(progress);
  return new Promise(resolve => {
    let worker;
    try {
      worker = new Worker(new URL("./index-worker.js", import.meta.url), {
        workerData: { cwd, project, progress, projectContextDir: CONFIG_DIR_NAME }, execArgv: [],
      });
    } catch (error) {
      resolve({ ok: false, message: error.message });
      return;
    }
    let outcome;
    let stage = -1n;
    let files = -1n;
    function abort() { Atomics.store(state, INDEX_PROGRESS.cancelled, 1n); }
    function report() {
      const nextStage = Atomics.load(state, INDEX_PROGRESS.stage);
      const nextFiles = Atomics.load(state, INDEX_PROGRESS.files);
      if (nextStage === stage && nextFiles === files) return;
      stage = nextStage;
      files = nextFiles;
      ui.setStatus(PROGRESS_KEY, stage === 0n ? STAGE_LABELS[0] : `${STAGE_LABELS[Number(stage)]} · ${files} files`);
    }
    const interval = typeof ui.setStatus === "function" ? setInterval(report, PROGRESS_MS) : undefined;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", result => { outcome = result; });
    worker.once("error", error => { outcome = { ok: false, message: error.message }; });
    worker.once("exit", code => {
      signal?.removeEventListener("abort", abort);
      if (interval !== undefined) {
        clearInterval(interval);
        if (stage !== -1n) ui.setStatus(PROGRESS_KEY, undefined);
      }
      resolve(code === 0 && outcome ? outcome : { ok: false, message: outcome?.message ?? `Index Worker exited with code ${code}` });
    });
  });
}

function cancelledOutcome() {
  return { ok: false, cancelled: true, message: "Index build cancelled" };
}

export async function runIndexTask(cwd, project, ctx) {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function" || typeof BorderedLoader !== "function") {
    return startIndexWorker(cwd, project, ctx.ui, ctx.signal);
  }
  const lifetime = new AbortController();
  let job;
  let outcome;
  try {
    outcome = await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Building project index");
      const signals = [loader.signal, lifetime.signal];
      if (ctx.signal) signals.push(ctx.signal);
      job = startIndexWorker(cwd, project, ctx.ui, AbortSignal.any(signals));
      void job.then(done);
      return loader;
    });
  } finally {
    if (outcome === undefined) {
      lifetime.abort();
      if (job) outcome = await job;
    }
  }
  return outcome ?? cancelledOutcome();
}
