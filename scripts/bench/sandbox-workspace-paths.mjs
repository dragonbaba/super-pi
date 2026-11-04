// Run from the repository root with node --expose-gc. No VM or real project I/O.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const helper = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["local", "need"].includes(node.name?.text))
    .map(node => node.getText(source)).join("\n");
const pattern = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations[0].name.getText(source) === "TRAILING_PATH_PATTERN").getText(source);
const profiler = new Session(); profiler.connect();
const weak = [], checks = 200000;
function run() {
    const io = { existsSync() { return false; } };
    const local = new Function("fs", "path", pattern + "\n" + helper + "\nreturn local;")(io, path);
    weak.push(new WeakRef(io), new WeakRef(local));
    const root = path.resolve("fixture"); let length = 0;
    for (let i = 0; i < checks; i++) length += local(root, "src/example.txt").length;
    assert.equal(length, checks * path.join(root, "src/example.txt").length);
}
try {
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    run();
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    let bytes = 0; const sites = [];
    function inspect(node) {
        if (node.selfSize) { bytes += node.selfSize; sites.push({ name: node.callFrame.functionName, bytes: node.selfSize }); }
        for (const child of node.children ?? []) inspect(child);
    }
    inspect(profile.head);
    for (let i = 0; i < 4; i++) { await setImmediate(); globalThis.gc(); }
    let live = 0; for (const ref of weak) if (ref.deref()) live++;
    assert.equal(live, 0); sites.sort((a, b) => b.bytes - a.bytes);
    console.log(JSON.stringify({ checks, sampledBytes: bytes, sampledBytesPerCheck: bytes / checks, sites: sites.slice(0, 12),
        structural: { componentClosures: 0, componentRegexObjects: 0, componentProtectedArrays: 0, pathComponentArraysPerCheck: 1 },
        lifecycle: { targets: weak.length, gcRounds: 4, live },
        note: "Real production local helper, synthetic absent filesystem; includes path-library allocations, not VM or OS memory. Structural counts require the sandbox-search-scope AST test." }));
} finally { profiler.disconnect(); }
