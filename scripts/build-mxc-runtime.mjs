// Only controlled worker assets are bundled. The official executor is a pinned optional dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_FILE_RUNTIME_ASSETS, MXC_FILE_RUNTIME_ASSETS } from "../packages/coding-agent/src/core/files/file-runtime-assets.mjs";
const root = fileURLToPath(new URL("../packages/coding-agent/", import.meta.url));
// tsgo preserves outputs of deleted sources. Retire only known generated VM assets.
const sandbox = path.resolve(root, "dist/core/sandbox");
for (const name of ["windows-runtime", "session-sandbox.js", "session-sandbox.js.map", "session-sandbox.d.ts", "session-sandbox.d.ts.map",
    "workspace-worker.mjs", "workspace-policy.mjs", "workspace-policy.d.mts",
    "task-binding.js", "task-binding.js.map", "task-binding.d.ts", "task-binding.d.ts.map",
    "task-package.js", "task-package.js.map", "task-package.d.ts", "task-package.d.ts.map",
    "task-request.js", "task-request.js.map", "task-request.d.ts", "task-request.d.ts.map"]) {
    const target = path.resolve(sandbox, name);
    if (path.dirname(target) !== sandbox) throw new Error("Unexpected retired runtime path");
    fs.rmSync(target, { recursive: true, force: true });
}
const copied = new Set();
function copyAsset(relative) {
    const source = path.resolve(root, "src", relative), destination = path.resolve(root, "dist", relative);
    if (!source.startsWith(path.join(root, "src") + path.sep) || !destination.startsWith(path.join(root, "dist") + path.sep)) throw new Error("Runtime asset left package root");
    if (copied.has(destination)) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); copied.add(destination);
}
for (const relative of ["core/sandbox/mxc-file-limits.d.mts", "core/sandbox/mxc-toolchains.mjs", "core/sandbox/mxc-toolchains.d.mts", "utils/image-signature.d.mts"]) copyAsset(relative);
for (const name of NATIVE_FILE_RUNTIME_ASSETS) copyAsset(path.join("core/files", name));
for (const [relative] of MXC_FILE_RUNTIME_ASSETS) {
    copyAsset(path.relative(path.join(root, "src"), path.resolve(root, "src/core/sandbox", relative)));
}
console.log("Packaged MXC worker and tool discovery assets");
