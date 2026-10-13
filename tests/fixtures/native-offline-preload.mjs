import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import threads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
let attempts = 0;
function blocked() { attempts++; throw new Error("Offline delivery fixture forbids network access."); }
globalThis.fetch = blocked;
http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = tls.connect = blocked;
// Explicit source-CLI fixture only. Other users of this offline preload keep
// the original Worker; no observer is installed by production code.
if (threads.isMainThread && process.env.SP_SOURCE_CODEMODE_PROBE === "1") {
  const OriginalWorker = threads.Worker;
  const counts = { started: 0, stopped: 0, pooled: 0, scripts: 0, active: 0, peak: 0 };
  threads.Worker = class extends OriginalWorker {
    constructor(filename, options) {
      super(filename, options);
      this.codemodeProbe = String(filename).replaceAll("\\", "/").endsWith("/codemode/dist/runtime/worker.js");
      if (!this.codemodeProbe) return;
      counts.started++; counts.active++; counts.peak = Math.max(counts.peak, counts.active);
      if (options?.workerData?.pooled === true) counts.pooled++;
      this.once("exit", () => { counts.stopped++; counts.active--; });
    }
    postMessage(value, ...args) {
      if (this.codemodeProbe && value?.data && value?.port) counts.scripts++;
      return super.postMessage(value, ...args);
    }
  };
  process.on("exit", () => process.stderr.write(`SOURCE_CODEMODE_WORKERS:${JSON.stringify(counts)}\n`));
}
syncBuiltinESMExports();
process.on("exit", () => { process.stderr.write(`NATIVE_NETWORK_ATTEMPTS:${attempts}\n`); if (attempts) process.exitCode = 1; });
