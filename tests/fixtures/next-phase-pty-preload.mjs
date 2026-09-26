// Explicit measurement preload only. Block all network and instrument the actual
// built InteractiveMode; production imports neither this file nor its wrappers.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let attempts = 0;
function record(phase, extra = {}) {
  appendFileSync(process.env.N4_PTY_REPORT, JSON.stringify({ phase, timestamp: Date.now(), processMs: performance.now(), cpu: process.cpuUsage(), heap: process.memoryUsage().heapUsed, ...extra }) + "\n");
}
function blocked() { attempts++; throw new Error("N4 PTY offline fixture forbids network."); }
globalThis.fetch = blocked; http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = tls.connect = blocked; syncBuiltinESMExports();
record("preload", { stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY });
const { InteractiveMode } = await import(pathToFileURL(join(process.env.N4_PTY_PROJECT, "packages/coding-agent/dist/modes/interactive/interactive-mode.js")).href);
const original = InteractiveMode.prototype.init;
InteractiveMode.prototype.init = async function measuredInit(...args) {
  const ready = await original.apply(this, args);
  if (!ready) { record("init-refused"); return ready; }
  const submit = this.editor.onSubmit;
  this.editor.onSubmit = function measuredSubmit(text) { record("editor-submit", { probe: text === "n4-probe", quit: text === "/quit" }); return submit.call(this, text); };
  record("input-ready", { activeTools: this.session.getActiveToolNames() });
  process.stderr.write("N4_PTY_INPUT_READY\n");
  return ready;
};
process.on("exit", function exited() { record("process-exit", { networkAttempts: attempts }); if (attempts) process.exitCode = 1; });
