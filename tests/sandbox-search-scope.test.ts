import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import test from "node:test";
import ts from "typescript";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../packages/coding-agent/src/utils/image-signature.mjs";
import { isVmPrivateName, isVmPrivatePath, isProtectedWorkspaceName, isVmPrivateDirectory, parseSandboxPrivateDirectories } from "../packages/coding-agent/src/core/sandbox/workspace-policy.mjs";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";

const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
// Run the complete guest entry against owned temporary roots; no command or VM is launched.
const guest = source.statements.filter(node => !ts.isImportDeclaration(node)
    && !(ts.isFunctionDeclaration(node) && node.name?.text === "commandWorkspace")
    && !(ts.isVariableStatement(node) && ["SOURCE", "WORK", "EXCHANGE"].includes(node.declarationList.declarations[0]!.name.getText(source))))
    .map(node => node.getText(source)).join("\n");
const execute = new Function("isVmPrivateName", "isVmPrivatePath", "isProtectedWorkspaceName", "isVmPrivateDirectory", "parseSandboxPrivateDirectories", "detectSupportedImageMimeType", "IMAGE_TYPE_SNIFF_BYTES", "fs", "path", "createHash", "isUtf8", "spawnSync", "process", "SOURCE", "WORK", "EXCHANGE", "commandWorkspace", guest).bind(undefined, isVmPrivateName, isVmPrivatePath, isProtectedWorkspaceName, isVmPrivateDirectory, parseSandboxPrivateDirectories, detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES);

test("both shell requests map every workspace drive independently of toolchain drives", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sp-workspace-drives-")));
    const inputRoot = path.join(root, "input"), exchange = path.join(root, "exchange");
    for (const directory of [inputRoot, inputRoot + "-1", inputRoot + "-2", inputRoot + "-3", exchange]) fs.mkdirSync(directory);
    try {
        for (const operation of ["powershell", "bash"]) for (const workspaceIndex of [0, 1]) {
            fs.writeFileSync(path.join(exchange, "request.json"), JSON.stringify({ id: "e".repeat(32), mode: "read-only",
                workspace: "C:\\primary", directories: ["Z:\\first", "Z:\\second", "D:\\third"], operation,
                maxWriteBytes: 1024 * 1024, input: { command: "fixture", workspaceIndex } }));
            execute(fs, path, createHash, isUtf8, (_exe: string, args: string[]) => {
                assert.equal(args[1], inputRoot, "runtime identity stays primary even with an additional cwd");
                assert.equal(args[3], workspaceIndex ? "Z:\\first" : "C:\\primary"); assert.equal(args[4], operation); assert.equal(args[5], "Z;D");
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
    fs.mkdirSync(path.join(inputRoot, ".git")); fs.writeFileSync(path.join(inputRoot, ".git/config"), "metadata");
    fs.mkdirSync(path.join(inputRoot, "empty"));
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
                if (operation === "ls") assert.deepEqual(result.text.split("\n").sort(), ["empty/", "src-other/", "src/"]);
                else { assert.match(result.text, /src\/example/); assert.match(result.text, /src-other\/other/); }
            }
            for (const scope of ["../exchange", inputRoot, ".git", ".sp", "src/missing.txt"]) assert.equal(run(mode, operation, scope).ok, false, scope);
        }
    }
    t.diagnostic(JSON.stringify({ guestSearchInvocations: runs, commandSpawns: 0, maximumRows: 200 }));
});

test("scoped search has no per-entry callbacks, regular expressions or result wrappers", () => {
    function inspect(node: ts.Node): void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node)
            || ts.isNewExpression(node) || ts.isRegularExpressionLiteral(node) || ts.isAwaitExpression(node), false, node.getText(source));
        ts.forEachChild(node, inspect);
    }
    for (const name of ["search", "searchScope", "local", "read", "grepRows"]) {
        const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
        inspect(helper.body!);
    }
    const policy = ts.createSourceFile("workspace-policy.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/workspace-policy.mjs", "utf8"), ts.ScriptTarget.Latest, true);
    // Explicit configuration boundary owns one bounded immutable array; never called per entry.
    for (const node of policy.statements) if (ts.isFunctionDeclaration(node) && node.name?.text !== "parseSandboxPrivateDirectories") inspect(node.body!);
});

test("guest private metadata, dependencies and configured directories stay out of command and native writeback", t => {
    const owned = createOwnedTaskFixture("sandbox-private-");
    const root = fs.realpathSync.native(owned.root);
    const inputRoot=path.join(root,"input"),work=path.join(root,"work"),exchange=path.join(root,"exchange");
    for(const directory of [inputRoot,exchange]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(inputRoot,"fixture.txt"),"fixture\n");
    const request = {id:"b".repeat(32),mode:"sandbox-write",workspace:root,operation:"powershell",maxWriteBytes:1024*1024,
        privateDirectories:[...parseSandboxPrivateDirectories(undefined), "build/private"], input:{command:"fixture only"}};
    const processState={exitCode:0};let spawns=0;
    try {
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(fs,path,createHash,isUtf8,(_exe:string,args:string[]) => {
            assert.equal(args[3],root);
            spawns++;
            fs.mkdirSync(path.join(work,"node_modules"));
            fs.writeFileSync(path.join(work,"node_modules","native.bin"),Buffer.alloc(3*1024*1024));
            for (const name of [".artifacts", ".codegraph", "nested/.git", "nested/.sp", "nested/TARGET", ".venv", "__pycache__", "build/private"]) {
                fs.mkdirSync(path.join(work, name), { recursive: true });
                fs.writeFileSync(path.join(work, name, "private.txt"), "VM only");
            }
            fs.writeFileSync(path.join(work,"package.json"),'{}\n');
            fs.writeFileSync(path.join(work,"target"),'ordinary file\n');
            fs.mkdirSync(path.join(work,"other/build/private"),{recursive:true});
            fs.writeFileSync(path.join(work,"other/build/private/visible.txt"),'ordinary file\n');
            fs.writeFileSync(path.join(exchange,"command-result.json"),JSON.stringify({closed:true,timedOut:false,exitCode:0,stdoutBase64:"",stderrBase64:""}));
            return {status:0};
        },processState,inputRoot,work,exchange,(_root:string,workspace:string)=>workspace);
        const reply=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
        assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(spawns,1);
        assert.deepEqual(reply.changes.map((item:any) => item.path).sort(),["other/build/private/visible.txt", "package.json", "target"]);
        for (const change of reply.changes) {
            assert.equal(change.content, null);
            assert.equal(fs.readFileSync(path.join(exchange, change.artifact.name), "utf8"), change.path === "package.json" ? '{}\n' : 'ordinary file\n');
            fs.unlinkSync(path.join(exchange, change.artifact.name));
        }
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
        assert.match(listed.text, /\.artifacts\//);
        for (const name of [".artifacts/new.txt", "nested/TARGET/new.txt", "build/private/new.txt"]) {
            request.operation="write";request.input={path:name,content:"private write"} as any;
            fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
            execute(fs,path,createHash,isUtf8,() => assert.fail("write must not spawn"),processState,inputRoot,work,exchange);
            const written=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
            assert.equal(written.ok,true);assert.deepEqual(written.changes,[]);
            assert.equal(fs.readFileSync(path.join(work,name),"utf8"),"private write");
        }
        request.operation="read";request.input={path:"node_modules/native.bin"} as any;
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify(request));
        execute(fs,path,createHash,isUtf8,() => assert.fail("read must not spawn"),processState,inputRoot,work,exchange);
        assert.equal(JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8")).ok,false);
        t.diagnostic(JSON.stringify({dependencyDirectoryReads:dependencyReads,dependencyWritebacks:0,commandSpawns:spawns}));
    } finally { owned.cleanup(); }
});

test("scoped search avoids unrelated trees and reports only actual row overflow", () => {
    const owned = createOwnedTaskFixture("sandbox-search-limit-"), root = fs.realpathSync.native(owned.root);
    const input = path.join(root,"input"), exchange = path.join(root,"exchange"), work = path.join(root,"work");
    for (const directory of [input, exchange, path.join(input,"scope"), path.join(input,"outside")]) fs.mkdirSync(directory);
    for (let index = 0; index < 200; index++) fs.writeFileSync(path.join(input,"scope",index+".txt"),"hit\n");
    const observed = Object.create(fs);
    observed.readdirSync = (directory: string, ...args: any[]) => {
        assert.notEqual(directory, input, "scoped search must not enumerate the workspace root");
        assert.notEqual(directory, path.join(input,"outside"));
        return (fs.readdirSync as any)(directory, ...args);
    };
    function run(operation: string) {
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify({id:"d".repeat(32),mode:"read-only",operation,
            maxWriteBytes:1024*1024,input:{path:"scope",pattern:operation==="find"?".txt":"hit"}}));
        execute(observed,path,createHash,isUtf8,() => assert.fail("search must not spawn"),{exitCode:0},input,work,exchange);
        const result=JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
        assert.equal(result.ok,true,JSON.stringify(result));return result.text as string;
    }
    try {
        for (const operation of ["ls","find","grep"]) {
            const text=run(operation);assert.equal(text.split("\n").length,200);assert.doesNotMatch(text,/truncated/);
        }
        fs.writeFileSync(path.join(input,"scope","overflow.txt"),"hit\n");
        for (const operation of ["ls","find","grep"]) {
            const text=run(operation);assert.equal(text.split("\n").length,201);assert.match(text,/Results truncated at 200 rows/);
        }
    } finally { owned.cleanup(); }
});

test("guest no-effects evidence stops at the first mutation or command launch", () => {
    const owned=createOwnedTaskFixture("sandbox-failure-phase-"), root=fs.realpathSync.native(owned.root);
    const input=path.join(root,"input"),work=path.join(root,"work"),exchange=path.join(root,"exchange");
    fs.mkdirSync(input);fs.mkdirSync(exchange);fs.writeFileSync(path.join(input,"existing.txt"),"original");
    function run(operation:string,args:Record<string,unknown>,io=fs) {
        fs.writeFileSync(path.join(exchange,"request.json"),JSON.stringify({id:"f".repeat(32),mode:"sandbox-write",workspace:root,
            operation,maxWriteBytes:1024*1024,input:args}));
        execute(io,path,createHash,isUtf8,() => ({status:1}),{exitCode:0},input,work,exchange,(_root:string,workspace:string)=>workspace);
        return JSON.parse(fs.readFileSync(path.join(exchange,"response.json"),"utf8"));
    }
    try {
        const missing=run("read",{path:"missing.txt"});assert.equal(missing.ok,false);assert.equal(missing.noEffects,true);
        const stale=run("write",{path:"existing.txt",content:"bad",snapshot:"stale"});assert.equal(stale.noEffects,true);
        assert.equal(fs.readFileSync(path.join(work,"existing.txt"),"utf8"),"original");
        const partial=run("file_batch",{operations:[{operation:"write",path:"created.txt",content:"partial"},{operation:"write",path:"existing.txt",content:"bad",snapshot:"stale"}]});
        assert.equal(partial.noEffects,false);assert.equal(partial.phase,"mutation");
        assert.equal(fs.readFileSync(path.join(work,"created.txt"),"utf8"),"partial");
        const launched=run("bash",{command:"fixture"});assert.equal(launched.noEffects,false);assert.equal(launched.phase,"launch");
        const redirected=Object.create(fs);
        redirected.lstatSync=(file:string,...args:any[]) => file===path.join(work,"existing.txt")
            ? {isSymbolicLink:()=>true} : (fs.lstatSync as any)(file,...args);
        const identity=run("read",{path:"existing.txt"},redirected);assert.equal(identity.noEffects,false);assert.match(identity.error,/Redirected/);
    } finally {owned.cleanup();}
});

test("host rejects a private candidate before publishing an earlier ordinary candidate", async t => {
    const owned=createOwnedTaskFixture("sandbox-candidate-"), boundary=new SessionExecutionBoundary();
    const runtime: any={executionBoundary:boundary,nativePermissions:{mode:"sandbox-write"}};
    const config=[...parseSandboxPrivateDirectories(undefined),"build/private"];
    const owner=new WorkspaceSandboxTools(owned.root,owned.root,"sandbox-write",() => runtime,{privateDirectories:config});
    config.length=0; // Caller mutation cannot replace the owner-bound classification.
    const internal=owner as any;let published=0,discarded=0;
    let privatePath="";
    t.mock.method(internal.backend,"invoke",async () => ({id:"fixture",ok:true,execution:{exitCode:0,timedOut:false,closed:true,stdout:"",stderr:""},
        changes:[{path:"ordinary.txt",before:null,content:"b2s="},{path:privatePath,before:null,content:"b2s="}]}));
    t.mock.method(internal,"publish",async () => {published++;});
    t.mock.method(internal.backend,"discardSnapshot",async () => {discarded++;});
    try {
        for (privatePath of [".artifacts/private.txt","nested/TARGET/private.txt","build/private/output.txt"]) {
            const result:any=await owner.definition("bash")!.execute("fixture",{command:"fixture"},boundary.signal,undefined,{cwd:owned.root} as any);
            assert.equal(result.isError,true);assert.equal(result.details.published,0);
            assert.match(result.content[0].text,/Protected candidate path.*VM-private/);assert.equal(published,0);
        }
        assert.equal(discarded,3);
    } finally {await owner.close();await boundary.dispose();owned.cleanup();}
});
