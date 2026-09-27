import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mixed = process.argv[3] === "mixed";
const { default: lsp } = await jiti.import("../../packages/lsp/src/pi-lsp.ts");
let diagnostics;
let shutdown;
lsp({ registerTool(tool) { if (tool.name === "lsp_diagnostics") diagnostics = tool; }, registerCommand() {}, on(name, fn) { if (name === "session_shutdown") shutdown = fn; } });
const root = process.argv[2];
const ctx = { cwd: root, isProjectTrusted() { return false; }, ui: { setStatus() {} } };
try {
  const result = await diagnostics.execute("missing-default-commands", { paths: mixed ? ["example.ts", "uncovered.py"] : ["page.html"] }, undefined, undefined, ctx);
  console.log(JSON.stringify(result));
} finally { await shutdown({}, ctx); }
