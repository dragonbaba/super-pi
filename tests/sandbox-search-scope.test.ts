import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import test from "node:test";
import ts from "typescript";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../packages/coding-agent/src/utils/image-signature.mjs";

const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
// Run the complete guest entry against owned temporary roots; no command or VM is launched.
const guest = source.statements.filter(node => !ts.isImportDeclaration(node)
    && !(ts.isFunctionDeclaration(node) && node.name?.text === "commandWorkspace")
    && !(ts.isVariableStatement(node) && ["SOURCE", "WORK", "EXCHANGE"].includes(node.declarationList.declarations[0]!.name.getText(source))))
    .map(node => node.getText(source)).join("\n");
const execute = new Function("detectSupportedImageMimeType", "IMAGE_TYPE_SNIFF_BYTES", "fs", "path", "createHash", "isUtf8", "spawnSync", "process", "SOURCE", "WORK", "EXCHANGE", "commandWorkspace", guest).bind(undefined, detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES);

test("both shell requests map every workspace drive independently of toolchain drives", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-workspace-drives-")));
    const inputRoot = path.join(root, "input"), exchange = path.join(root, "exchange");
    for (const directory of [inputRoot, inputRoot + "-1", inputRoot + "-2", inputRoot + "-3", exchange]) fs.mkdirSync(directory);
    try {
        for (const operation of ["powershell", "bash"]) {
            fs.writeFileSync(path.join(exchange, "request.json"), JSON.stringify({ id: "e".repeat(32), mode: "read-only",
                workspace: "C:\\primary", directories: ["Z:\\first", "Z:\\second", "D:\\third"], operation,
                maxWriteBytes: 1024 * 1024, input: { command: "fixture" } }));
            execute(fs, path, createHash, isUtf8, (_exe: string, args: string[]) => {
                assert.equal(args[3], "C:\\primary"); assert.equal(args[4], operation); assert.equal(args[5], "Z;D");
                fs.writeFileSync(path.join(exchange, "command-result.json"), JSON.stringify({ closed: true, timedOut: false, exitCode: 0, stdoutBase64: "", stderrBase64: "" }));
                return { status: 0 };
            }, { exitCode: 0 }, inputRoot, path.join(root, "work"), exchange, (_root: string, workspace: string) => workspace);
            assert.equal(JSON.parse(fs.readFileSync(path.join(exchange, "response.json"), "utf8")).ok, true);
        }
    } finally { fs.rmSync(root, { recursive: true }); }
});

test("command artifacts use metadata comparison and preserve exact collection failures", () => {
    for (const count of [48, 1025]) {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-artifact-contract-")));
        const inputRoot = path.join(root, "input"), work = path.join(root, "work"), exchange = path.join(root, "exchange");
        for (const directory of [inputRoot, work, exchange]) fs.mkdirSync(directory);
        fs.writeFileSync(path.join(work, "unchanged.bin"), Buffer.alloc(2 * 1024 * 1024, 83));
        let unchangedOpens = 0;
        const observed = Object.create(fs);
        observed.openSync = (file: string, ...args: any[]) => {
            if (file === path.join(work, "unchanged.bin")) unchangedOpens++;
            return (fs.openSync as any)(file, ...args);
        };
        fs.writeFileSync(path.join(exchange, "request.json"), JSON.stringify({ id: "c".repeat(32), mode: "sandbox-write", workspace: root,
            operation: "bash", maxWriteBytes: 1024 * 1024, input: { command: "fixture" } }));
        try {
            execute(observed, path, createHash, isUtf8, (_exe: string, args: string[]) => {
                assert.equal(args[4], "bash");
                for (let i = 0; i < count; i++) fs.writeFileSync(path.join(work, i + ".png"), Buffer.from([137, 80, 78, 71, 255, i % 256]));
                fs.writeFileSync(path.join(exchange, "command-result.json"), JSON.stringify({ closed: true, timedOut: false, exitCode: 0,
                    stdoutBase64: Buffer.from("generated=" + count).toString("base64"), stderrBase64: "" }));
                return { status: 0 };
            }, { exitCode: 0 }, inputRoot, work, exchange, (_root: string, workspace: string) => workspace);
            const result = JSON.parse(fs.readFileSync(path.join(exchange, "response.json"), "utf8"));
            assert.equal(unchangedOpens, 0, "unchanged asset bytes must not be hashed for each command");
            assert.equal(result.execution.exitCode, 0); assert.equal(result.execution.stdout, "generated=" + count);
            if (count === 48) {
                assert.equal(result.ok, true); assert.equal(result.changes.length, count);
                for (const change of result.changes) {
                    assert.equal(change.content, null);
                    const bytes = fs.readFileSync(path.join(exchange, change.artifact.name));
                    assert.equal(bytes[0], 137); assert.equal(bytes[4], 255);
                    assert.equal(createHash("sha256").update(bytes).digest("hex"), change.artifact.sha256);
                }
            } else {
                assert.equal(result.ok, false); assert.equal(result.phase, "collection"); assert.match(result.error, /files=1025\/1024/);
            }
        } finally { assert.equal(fs.realpathSync(root), root); fs.rmSync(root, { recursive: true }); }
    }
});

test("artifact enumeration and hashing introduce no nested callbacks or regular expressions", () => {
    for (const name of ["commandChanges", "changes", "catalog", "selected", "fileHash"]) {
        const method = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
        let callbacks = 0, regexes = 0;
        function visit(node: ts.Node) { if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) callbacks++; if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regexes++; ts.forEachChild(node, visit); }
        visit(method); assert.equal(callbacks, 0, name); assert.equal(regexes, 0, name);
    }
});

test("guest command workspace aliases preserve project spelling and reject collisions or redirection", () => {
    const helper=source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "commandWorkspace")!;
    const reserved=source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]!.name.getText(source) === "RESERVED_WORKSPACE_ROOTS")!;
    const create=new Function("fs","path","need","TRAILING_PATH_PATTERN",reserved.getText(source)+";return "+helper.getText(source));
    for(const workspace of ["D:\\Projects\\中文 space", "C:\\Projects\\example", "C:\\project"]) {
        const entries=new Map<string,{link?:string}>(),root="C:\\SuperPiWorkspace";
        let links=0;
        const io={existsSync(file:string){return entries.has(file);},mkdirSync(file:string){assert.ok(!entries.has(file));entries.set(file,{});},
            lstatSync(file:string){const row=entries.get(file)!;return {isDirectory:()=>!row.link,isSymbolicLink:()=>!!row.link};},
            realpathSync(file:string){return entries.get(file)?.link??file;},
            symlinkSync(target:string,file:string,type:string){assert.equal(type,"junction");assert.ok(!entries.has(file));links++;entries.set(file,{link:target});}};
        const prepare=create(io,path,(ok:boolean,reason:string)=>assert.ok(ok,reason),/[. ]$/);
        assert.equal(prepare(root,workspace),workspace);assert.equal(prepare(root,workspace),workspace);assert.equal(links,1);
        const alias=workspace[0]==="C"?workspace:"C:\\SuperPiToolchains\\D"+workspace.slice(2);
        entries.set(alias,{link:"C:\\other"});assert.throws(()=>prepare(root,workspace),/alias changed/);
        entries.set(alias,{});assert.throws(()=>prepare(root,workspace),/alias changed/);
        entries.delete(alias);
        if(path.win32.dirname(alias)!=="C:\\") {entries.set(path.win32.dirname(alias),{link:"C:\\other"});assert.throws(()=>prepare(root,workspace),/Redirected.*parent/);}
        for(const invalid of ["D:\\", "D:relative", "\\\\server\\share\\project", "C:\\SuperPiTools\\project", "D:\\Projects\\trailing.", "D:\\Projects\\..\\other"])
            assert.throws(()=>prepare(root,invalid));
        assert.equal(links,1);
    }
});

test("guest command path preparation adds no nested callbacks, regexes or asynchronous owners", () => {
    const helper=source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "commandWorkspace") as ts.FunctionDeclaration;
    function inspect(node:ts.Node):void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node)
            || ts.isNewExpression(node) || ts.isAwaitExpression(node),false,node.getText(source));
        ts.forEachChild(node,inspect);
    }
    inspect(helper.body!);
});

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
    const request = {id:"b".repeat(32),mode:"sandbox-write",workspace:root,operation:"powershell",maxWriteBytes:1024*1024,input:{command:"fixture only"}};
    const processState={exitCode:0};let spawns=0;
    try {
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(fs,path,createHash,isUtf8,(_exe:string,args:string[]) => {
            assert.equal(args[3],root);
            spawns++;
            fs.mkdirSync(path.join(work,"node_modules"));
            fs.writeFileSync(path.join(work,"node_modules","native.bin"),Buffer.alloc(3*1024*1024));
            fs.writeFileSync(path.join(work,"package.json"),'{}\n');
            fs.writeFileSync(path.join(exchange,"command-result.json"),JSON.stringify({closed:true,timedOut:false,exitCode:0,stdoutBase64:"",stderrBase64:""}));
            return {status:0};
        },processState,inputRoot,work,exchange,(_root:string,workspace:string)=>workspace);
        const reply=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
        assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(spawns,1);
        assert.deepEqual(reply.changes.map((item:any) => item.path),["package.json"]);
        assert.equal(reply.changes[0].content, null);
        assert.equal(fs.readFileSync(path.join(exchange, reply.changes[0].artifact.name), "utf8"), '{}\n');
        fs.unlinkSync(path.join(exchange, reply.changes[0].artifact.name));
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
