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

test("workspace path validation has no per-component closures, regex literals or protected-name arrays", () => {
    const helper=source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "local") as ts.FunctionDeclaration;
    function inspect(node:ts.Node):void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node)
            || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node), false, node.getText(source));
        ts.forEachChild(node,inspect);
    }
    inspect(helper.body!);
});

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

test("guest npm dependencies stay private without traversal or writeback candidates", t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-guest-dependencies-")));
    const inputRoot=path.join(root,"input"),work=path.join(root,"work"),exchange=path.join(root,"exchange");
    for(const directory of [inputRoot,exchange]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(inputRoot,"fixture.txt"),"fixture\n");
    const request = {id:"b".repeat(32),mode:"sandbox-write",operation:"powershell",maxWriteBytes:1024*1024,input:{command:"fixture only"}};
    const processState={exitCode:0};let spawns=0;
    try {
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(fs,path,createHash,isUtf8,() => {
            spawns++;
            fs.mkdirSync(path.join(work,"node_modules"));
            fs.writeFileSync(path.join(work,"node_modules","native.bin"),Buffer.alloc(3*1024*1024));
            fs.writeFileSync(path.join(work,"package.json"),'{}\n');
            fs.writeFileSync(path.join(exchange,"command-result.json"),JSON.stringify({closed:true,timedOut:false,exitCode:0,stdoutBase64:"",stderrBase64:""}));
            return {status:0};
        },processState,inputRoot,work,exchange);
        const reply=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
        assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(spawns,1);
        assert.deepEqual(reply.changes.map((item:any) => item.path),["package.json"]);
        let dependencyReads=0;
        const observed=Object.create(fs);
        observed.readdirSync=(directory:string,...args:any[]) => {
            if(directory.includes("node_modules")) dependencyReads++;
            return (fs.readdirSync as any)(directory,...args);
        };
        request.operation="ls";request.input={} as any;
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(observed,path,createHash,isUtf8,() => assert.fail("ls must not spawn"),processState,inputRoot,work,exchange);
        assert.equal(dependencyReads,0);
        const listed=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
        assert.equal(listed.ok,true);assert.doesNotMatch(listed.text,/node_modules/);
        request.operation="read";request.input={path:"node_modules/native.bin"} as any;
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(fs,path,createHash,isUtf8,() => assert.fail("read must not spawn"),processState,inputRoot,work,exchange);
        assert.equal(JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8")).ok,false);
        t.diagnostic(JSON.stringify({dependencyDirectoryReads:dependencyReads,dependencyWritebacks:0,commandSpawns:spawns}));
    } finally {
        for(const file of ["input/fixture.txt","work/fixture.txt","work/package.json","work/node_modules/native.bin","exchange/request.json","exchange/response.json","exchange/command-result.json","exchange/command.txt"]) fs.unlinkSync(path.join(root,file));
        for(const directory of ["work/node_modules","work","input","exchange"]) fs.rmdirSync(path.join(root,directory));
        fs.rmdirSync(root);
    }
});
