// Counts real directory IO in a private process before Jiti/native imports capture fs functions.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = process.argv[2], scan = join(root, "scan");
const originalRead = fs.readdirSync;
let directoryReads = 0;
fs.readdirSync = function (...args) {
  if (args[0] === scan || args[0] === join(scan, "sub")) directoryReads++;
  return Reflect.apply(originalRead, fs, args);
};
syncBuiltinESMExports();
try {
  const jiti = createJiti(import.meta.url);
  const { loadRuntime } = await jiti.import("../../packages/lsp/src/adapters.ts");
  const { selectDiagnosticRoutes } = await jiti.import("../../packages/lsp/src/routes.ts");
  const { adapters } = loadRuntime(root, { projectTrusted: true });
  const live = adapters.find(adapter => adapter.name === "fixture");
  const missing = Array.from({ length: 20 }, (_, index) => ({ ...live, name: `missing-${index}`, isDefault: true,
    extensions: [`.missing${index}`], skipDirectories: new Set([`ignored${index}`]),
    isSupportedFile(file) { return file.endsWith(`.missing${index}`); },
    defaultCommand: { command: "sp-nonexistent-lsp-fixture", args: [] },
  }));
  const selected = selectDiagnosticRoutes([live, ...missing], { root, paths: ["scan"] }, 50);
  console.log(JSON.stringify({ directoryReads, routes: selected.routes.length, skipped: selected.skipped.length, incomplete: selected.incomplete }));
} finally {
  fs.readdirSync = originalRead;
  syncBuiltinESMExports();
}
