import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { workspaceInput } from "../packages/coding-agent/src/core/sandbox/workspace-paths.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";

test("production request translates in-workspace absolute paths without mutating authorized arguments", async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sp-workspace-path-")));
    const exchange = path.join(root, "exchange"); await fs.mkdir(exchange);
    const backend = new WorkspaceSandboxBackend(root, root, "sandbox-write"), internal = backend as any;
    internal.starts = 1; internal.roots.push(root); internal.tools = exchange; internal.exchange = exchange;
    t.mock.method(internal, "policy", async () => "fixture-policy");
    t.mock.method(internal, "assertWorkspaceCurrent", async () => {});
    const received: any[] = [];
    internal.runner.run = async () => {
        const request = JSON.parse(await fs.readFile(path.join(exchange, "request.json"), "utf8")); received.push(request);
        const read = request.operation === "read" ? { version: 1, offset: 1, limit: 2000, windowComplete: true,
            hasMore: false, lineTruncated: false, returnedLines: 1 } : undefined;
        const search = request.operation === "ls" ? { version: 1, operation: "ls", outputMode: "files", scanComplete: true, coverageComplete: true,
            outputTruncated: false, excerptTruncated: false, stopReason: "none", visitedEntries: 0, scannedFiles: 0,
            observedRecords: 0, returnedRecords: 0, outputUnits: 0, skippedTooLarge: 0, skippedNonUtf8: 0, skippedNul: 0,
            excludedProtected: 0, excludedLinks: 0 } : undefined;
        return {code:0,stdout:JSON.stringify({id:request.id,ok:true,text:"ok",read,search}),stderr:"",timedOut:false,truncated:false};
    };
    try {
        const input = Object.freeze({ path: path.join(root, "src", "example.txt") });
        await backend.invoke("read", input); assert.equal(received.at(-1).input.path, "src/example.txt");
        assert.equal(input.path, path.join(root, "src", "example.txt"));
        await backend.invoke("ls", {path:root}); assert.equal(received.at(-1).input.path, ".");
        await backend.invoke("file_batch", {operations:[{operation:"move",path:input.path,destination:path.join(root,"new.txt")}]});
        assert.deepEqual(received.at(-1).input.operations, [{operation:"move",path:"src/example.txt",destination:"new.txt"}]);
    } finally {
        internal.root=undefined;await backend.close();
        for(const name of ["request.json","response.json"]) await fs.unlink(path.join(exchange,name)).catch(() => {});
        await fs.rmdir(exchange);await fs.rmdir(root);
    }
});

test("path translation is bounded and preserves shell source and relative path grammar", () => {
    const cwd = process.cwd();
    const relative = Object.freeze({path:"./src/../src/file.txt"});
    assert.equal(workspaceInput(cwd,"read",relative),relative);
    const shell = Object.freeze({command:"Get-Content 'D:/project/source.txt'"});
    assert.equal(workspaceInput(cwd,"powershell",shell),shell);
    assert.equal(workspaceInput(cwd,"bash",shell),shell);
    assert.throws(() => workspaceInput(cwd,"read",{path:"file",workspaceIndex:1}), /assigned by the host/);
    assert.throws(() => workspaceInput(cwd,"file_batch",{operations:[{operation:"read",path:"file",workspaceIndex:1}]}), /assigned by the host/);
    const additional = path.resolve(cwd, "../additional");
    const command = 'printf "$PWD"; false || printf recovered';
    assert.deepEqual(workspaceInput(cwd, "bash", { command, cwd: "literal 中文 ' directory" }),
        { command, cwd: "literal 中文 ' directory", workspaceIndex: 0 });
    assert.deepEqual(workspaceInput(cwd, "powershell", { command, cwd: path.join(additional, "space") }, [additional]),
        { command, cwd: "space", workspaceIndex: 1 });
    assert.throws(() => workspaceInput(cwd, "bash", { command, cwd: "../outside" }), /outside/);
    assert.deepEqual(workspaceInput(cwd,"read",{path:path.join(additional,"file")},[additional]), {path:"file",workspaceIndex:1});
    assert.throws(() => workspaceInput(cwd,"move",{path:path.join(additional,"file"),destination:"primary.txt"},[additional]), /outside/);
    for(const value of [path.resolve(cwd,"../Pi-other/file"), "\\\\server\\share\\file", "\\\\?\\C:\\file", "D:file", "a\0b"])
        assert.throws(() => workspaceInput(cwd,"read",{path:value}), /SANDBOX_PATH/);
    assert.throws(() => workspaceInput(cwd,"file_batch",{operations:new Array(17).fill({path:"file"})}), /Invalid file batch/);
    assert.throws(() => workspaceInput(cwd,"file_batch",{operations:[null]}), /Invalid file operation/);
    assert.throws(() => new WorkspaceSandboxBackend(cwd,cwd,"sandbox-write",{network:"Enable" as any}), /Invalid global sandboxNetwork/);
    if(process.platform === "win32") {
        assert.equal(workspaceInput(cwd,"ls",{path:cwd.toUpperCase().replaceAll("\\","/")+"/"}).path,".");
        assert.throws(() => workspaceInput(cwd,"read",{path:"Z:\\outside\\file"}), /outside.*workspace/);
    }
});

test("sandbox tool descriptions expose actual workspace, cwd and network policy", async () => {
    for(const mode of ["read-only","sandbox-write"] as const) {
        const owner = new WorkspaceSandboxTools(process.cwd(),process.cwd(),mode,() => {throw new Error("No execution");},{network:"enabled"});
        const tools = owner.install({bash:{} as any}); assert.equal(tools.bash,undefined);
        assert.ok(tools.ls.description.includes(process.cwd()));
        assert.ok(tools.powershell.description.includes("Command cwd: " + process.cwd()));
        assert.doesNotMatch(tools.powershell.description, /C:\\SuperPiInput|C:\\SuperPiWorkspace/);
        assert.match(tools.powershell.description,/Network access: enabled/);
        assert.doesNotMatch(tools.powershell.description,/no network/);
        await owner.close();
    }
});

test("outside-workspace paths are rejected before MXC startup", async t => {
    const backend = new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "sandbox-write"), internal=backend as any;
    let starts=0;t.mock.method(internal,"start",async () => {starts++;throw new Error("Unexpected MXC startup");});
    try {
        await assert.rejects(backend.invoke("ls", {path:path.resolve(process.cwd(),"../outside")}), /outside.*workspace/i);
        assert.equal(starts,0);
    } finally {await backend.close();}
});
