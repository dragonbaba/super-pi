// Run from the repository root with node --expose-gc. No VM or real project I/O.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { isProtectedWorkspaceName, isVmPrivatePath, parseSandboxPrivateDirectories } from '../../packages/coding-agent/src/core/sandbox/workspace-policy.mjs';

assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const helper = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["local", "need", "needInput"].includes(node.name?.text)
    || ts.isClassDeclaration(node) && node.name?.text === 'WorkspaceInputError')
    .map(node => node.getText(source)).join("\n");
const pattern = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations[0].name.getText(source) === "TRAILING_PATH_PATTERN").getText(source);
const profiler = new Session(); profiler.connect();
const weak = [], checks = 200000;
function run() {
    const io = { existsSync() { return false; } };
    const local = new Function("fs", "path", "isProtectedWorkspaceName", pattern + "\n" + helper + "\nreturn local;")(io, path, isProtectedWorkspaceName);
    weak.push(new WeakRef(io), new WeakRef(local));
    const root = path.resolve("fixture"); let length = 0;
    for (let i = 0; i < checks; i++) length += local(root, "src/example.txt").length;
    assert.equal(length, checks * path.join(root, "src/example.txt").length);
}
function runPrivate() {
    const directories = parseSandboxPrivateDirectories(['target', '.venv', '__pycache__', 'build/private']);
    weak.push(new WeakRef(directories));
    const names = ['src/TARGET/output.bin', 'build/private/file.txt', 'other/build/private/file.txt', 'target'];
    let privateCount = 0;
    for (let index = 0; index < checks; index++) if (isVmPrivatePath(names[index % names.length], directories)) privateCount++;
    assert.equal(privateCount, checks / 2);
}
try {
    const results = [];
    for (const operation of [run, runPrivate]) {
        await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        operation();
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        let bytes = 0; const sites = [];
        function inspect(node) {
            if (node.selfSize) { bytes += node.selfSize; sites.push({ name: node.callFrame.functionName, bytes: node.selfSize }); }
            for (const child of node.children ?? []) inspect(child);
        }
        inspect(profile.head); sites.sort((a, b) => b.bytes - a.bytes);
        results.push({ operation: operation.name, checks, sampledBytes: bytes, sampledBytesPerCheck: bytes / checks, sites: sites.slice(0, 12) });
    }
    for (let i = 0; i < 4; i++) { await setImmediate(); globalThis.gc(); }
    let live = 0; for (const ref of weak) if (ref.deref()) live++;
    assert.equal(live, 0);
    console.log(JSON.stringify({ results,
        structural: { componentClosures: 0, componentRegexObjects: 0, componentProtectedArrays: 0, pathComponentArraysPerCheck: 1,
            privateClassificationArrays: 0, privateClassificationWrappers: 0, privateClassificationPromises: 0, privateClassificationAbortControllers: 0 },
        lifecycle: { targets: weak.length, gcRounds: 4, live },
        note: "Actual local and private classification helpers, synthetic absent filesystem; includes path-library allocations and string normalization/slices, not VM or OS memory. Structural counts require the sandbox-search-scope AST test. Config owns one bounded frozen list outside entry loops." }));
} finally { profiler.disconnect(); }
