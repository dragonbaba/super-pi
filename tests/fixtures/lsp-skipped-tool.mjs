import { createJiti } from "jiti";
const { default: lsp } = await createJiti(import.meta.url).import("../../packages/lsp/src/pi-lsp.ts");
let diagnostics;
lsp({ registerTool(tool) { if (tool.name === "lsp_diagnostics") diagnostics = tool; }, registerCommand() {}, on() {} });
const root = process.argv[2];
const result = await diagnostics.execute("missing-default-commands", { paths: ["page.html"] }, undefined, undefined,
  { cwd: root, isProjectTrusted() { return false; }, ui: { setStatus() {} } });
console.log(JSON.stringify(result));
