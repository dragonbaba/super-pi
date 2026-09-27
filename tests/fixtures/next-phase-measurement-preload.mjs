// Diagnostic-only probes. Do not preload this into the fair timing processes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Session } from "node:inspector/promises";
import { resolve, join, sep, basename, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.SP_N4_MODULE_FORBIDDEN_ROOT) {
  const forbidden = normalize(join(resolve(process.env.SP_N4_MODULE_FORBIDDEN_ROOT), "packages")) + sep;
  const violations = [], inspector = new Session(); let matchingScripts = 0;
  inspector.connect();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (!params.url) return;
    let path; try { path = normalize(params.url.startsWith("file:") ? fileURLToPath(params.url) : params.url); } catch { return; }
    if (path.toLowerCase().startsWith(forbidden.toLowerCase())) { matchingScripts++; if (violations.length < 16) violations.push(path); }
  });
  await inspector.post("Debugger.enable");
  process.once("exit", () => {
    fs.appendFileSync(process.env.SP_N4_MODULE_REPORT, JSON.stringify({ pid: process.pid, forbidden, matchingScripts, violations }) + "\n");
    inspector.disconnect(); if (matchingScripts) process.exitCode = 1;
  });
}
if (process.env.SP_N4_SETUP_RECORD) {
  const original = fs.mkdtempSync;
  fs.mkdtempSync = function recordRoot(prefix, ...args) {
    const root = original(prefix, ...args);
    if (basename(String(prefix)) === "sp-n4-matrix-" || basename(String(prefix)) === "sp-n4-session-") fs.appendFileSync(process.env.SP_N4_SETUP_RECORD, JSON.stringify({ root }) + "\n");
    return root;
  };
  if (process.env.SP_N4_SETUP_KIND === "spill" || process.env.SP_N4_SETUP_KIND === "io") {
    const write = fs.writeFileSync;
    fs.writeFileSync = function failFixtureWrite(path, ...args) {
      if (basename(String(path)) === (process.env.SP_N4_SETUP_KIND === "spill" ? "entry-0" : "file0")) throw new Error("N4 fixture loader setup failure");
      return write(path, ...args);
    };
  } else {
    const project = resolve(process.env.SP_COST_PROJECT_ROOT ?? ".");
    const { DefaultResourceLoader } = await import(pathToFileURL(join(project, "packages/coding-agent/src/core/resource-loader.ts")).href);
    DefaultResourceLoader.prototype.reload = async function failFixtureSetup() { throw new Error("N4 fixture loader setup failure"); };
  }
  syncBuiltinESMExports();
}
