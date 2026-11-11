// Only controlled worker assets are bundled. The official executor is a pinned optional dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
for (const relative of ["core/sandbox/mxc-file-worker.mjs", "core/sandbox/mxc-file-limits.mjs", "core/sandbox/mxc-file-limits.d.mts", "core/sandbox/mxc-toolchains.mjs", "core/sandbox/mxc-toolchains.d.mts",
    "utils/image-signature.mjs", "utils/image-signature.d.mts"]) {
    const destination = path.join(root, "dist", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, "src", relative), destination);
}
console.log("Packaged MXC worker and tool discovery assets");
