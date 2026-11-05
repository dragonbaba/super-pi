// Package the exact shared runtime sources. Acceptance entry points are never run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(root, "scripts", "acceptance");
const destination = path.join(root, "packages", "coding-agent", "dist", "core", "sandbox", "windows-runtime");
const pending = ["windows-sandbox-task-runtime.mjs"], sources = new Map();
while (pending.length) {
    const name = pending.pop(); if (sources.has(name)) continue;
    if (!/^windows-sandbox-[a-z0-9.-]+\.mjs$/.test(name)) throw new Error("Unexpected sandbox module name");
    const source = fs.readFileSync(path.join(sourceRoot, name), "utf8"); sources.set(name, source);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.\/[^"']+\.mjs)\1/g)) pending.push(match[2].slice(2));
}
const resources = ["windows-sandbox-volume-native.cs", "windows-sandbox-volume-candidate-manifest.cs", "windows-sandbox-volume-candidate-batch.cs",
    "windows-sandbox-input-install.cs", "windows-sandbox-task-install.cs", "windows-sandbox-task-worker.cs",
    "windows-sandbox-volume-helper.ps1", "windows-sandbox-powershell7.config.json", "windows-sandbox-bootstrap.wsb"];
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(root, "packages/coding-agent/src/core/sandbox/workspace-worker.mjs"), path.join(destination, "..", "workspace-worker.mjs"));
for (const name of ["image-signature.mjs", "image-signature.d.mts"]) {
    fs.copyFileSync(path.join(root, "packages/coding-agent/src/utils", name), path.join(root, "packages/coding-agent/dist/utils", name));
}
const manifest = [];
for (const [name, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const emitted = source.replace(/\.\.\/\.\.\/packages\/coding-agent\/src\/core\/(files|sandbox)\/([a-z0-9-]+)\.ts/g,
        (_match, area, file) => area === "files" ? `../../files/${file}.js` : `../${file}.js`);
    if (emitted.includes("../../packages/")) throw new Error("Unpackaged sandbox dependency: " + name);
    fs.writeFileSync(path.join(destination, name), emitted);
    manifest.push([name, createHash("sha256").update(emitted).digest("hex")]);
}
for (const name of resources) {
    const bytes = fs.readFileSync(path.join(sourceRoot, name)); fs.writeFileSync(path.join(destination, name), bytes);
    manifest.push([name, createHash("sha256").update(bytes).digest("hex")]);
}
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ version: 1, files: manifest }));
console.log(`Packaged Windows Sandbox runtime: ${manifest.length} files`);
