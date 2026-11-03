import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
// Run the complete guest entry against owned temporary roots; no command or VM is launched.
const guest = source.statements.filter(node => !ts.isImportDeclaration(node)
    && !(ts.isVariableStatement(node) && ["SOURCE", "WORK", "EXCHANGE"].includes(node.declarationList.declarations[0]!.name.getText(source))))
    .map(node => node.getText(source)).join("\n");
const execute = new Function("fs", "path", "createHash", "isUtf8", "spawnSync", "process", "SOURCE", "WORK", "EXCHANGE", guest);

test("both sandbox modes search normalized directories and exact files without prefix collisions", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-search-scope-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const inputRoot = path.join(root, "input"), work = path.join(root, "work"), exchange = path.join(root, "exchange");
    for (const directory of [inputRoot, exchange, path.join(inputRoot, "src"), path.join(inputRoot, "src-other")]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(inputRoot, "src/example.txt"), "needle\n");
    fs.writeFileSync(path.join(inputRoot, "src-other/other.txt"), "needle\n");
    let runs = 0;
    function run(mode: string, operation: string, scope: string | undefined) {
        const processState = { exitCode: 0 };
        fs.writeFileSync(path.join(exchange, "request.json"), JSON.stringify({ id: "a".repeat(32), mode, operation,
            maxWriteBytes: 1024 * 1024, input: { path: scope, pattern: operation === "find" ? ".txt" : "needle" } }));
        execute(fs, path, createHash, isUtf8, () => assert.fail("search must not spawn"), processState, inputRoot, work, exchange);
        runs++;
        return JSON.parse(fs.readFileSync(path.join(exchange, "response.json"), "utf8"));
    }
    for (const mode of ["read-only", "sandbox-write"]) {
        for (const operation of ["grep", "find", "ls"]) {
            for (const scope of ["src", "./src", "src/", ".\\src\\", "src/../src", "src/example.txt", "./src/example.txt"]) {
                const result = run(mode, operation, scope);
                assert.equal(result.ok, true, JSON.stringify(result));
                assert.equal(result.text, operation === "grep" ? "src/example.txt:1:needle" : "src/example.txt");
            }
            for (const scope of [undefined, ".", "./"]) {
                const result = run(mode, operation, scope); assert.equal(result.ok, true);
                assert.match(result.text, /src\/example/); assert.match(result.text, /src-other\/other/);
            }
            for (const scope of ["../exchange", inputRoot, ".git", ".sp", "src/missing.txt"]) assert.equal(run(mode, operation, scope).ok, false, scope);
        }
    }
    t.diagnostic(JSON.stringify({ guestSearchInvocations: runs, commandSpawns: 0, maximumRows: 200 }));
});

test("catalog scope matching creates no per-entry closures, objects, regex or normalized strings", t => {
    const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "matchesScope") as ts.FunctionDeclaration;
    function inspect(node: ts.Node): void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)
            || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
        if (ts.isCallExpression(node)) assert.equal(node.expression.getText(source), "name.startsWith");
        if (ts.isBinaryExpression(node)) assert.notEqual(node.operatorToken.kind, ts.SyntaxKind.PlusToken);
        ts.forEachChild(node, inspect);
    }
    inspect(helper.body!);
    const match = new Function(helper.getText(source) + "\nreturn matchesScope;")();
    let matches = 0;
    for (let index = 0; index < 200000; index++) if (match(index % 2 ? "src-other/file" : "src/file", "src")) matches++;
    assert.equal(matches, 100000);
    t.diagnostic(JSON.stringify({ scopeChecks: 200000, matches, perEntryNormalization: 0, perEntryRegex: 0, perEntryObjects: 0 }));
});
