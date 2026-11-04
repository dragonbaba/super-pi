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
    internal.root = root;
    t.mock.method(internal, "assertWorkspaceCurrent", async () => {});
    const received: any[] = [];
    internal.vm = { calls: [], async invoke() {
        const request = JSON.parse(await fs.readFile(path.join(exchange, "request.json"), "utf8")); received.push(request);
        await fs.writeFile(path.join(exchange, "response.json"), JSON.stringify({id:request.id,ok:true,text:"ok"}));
    } };
    try {
        const input = Object.freeze({ path: path.join(root, "src", "example.txt") });
        await backend.invoke("read", input); assert.equal(received.at(-1).input.path, "src/example.txt");
        assert.equal(input.path, path.join(root, "src", "example.txt"));
        await backend.invoke("ls", {path:root}); assert.equal(received.at(-1).input.path, ".");
        await backend.invoke("file_batch", {operations:[{operation:"move",path:input.path,destination:path.join(root,"new.txt")}]});
        assert.deepEqual(received.at(-1).input.operations, [{operation:"move",path:"src/example.txt",destination:"new.txt"}]);
    } finally {
        internal.vm=undefined;internal.root=undefined;await backend.close();
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

test("sandbox tool descriptions expose actual workspace, guest cwd and network policy", async () => {
    for(const mode of ["read-only","sandbox-write"] as const) {
        const owner = new WorkspaceSandboxTools(process.cwd(),process.cwd(),mode,() => {throw new Error("No execution");},{network:"enabled"});
        const tools:Record<string,any>={}; owner.install(tools);
        assert.ok(tools.ls.description.includes(process.cwd()));
        assert.ok(tools.powershell.description.includes(mode === "read-only" ? "C:\\SuperPiInput" : "C:\\SuperPiWorkspace"));
        assert.match(tools.powershell.description,/Network access: enabled/);
        assert.doesNotMatch(tools.powershell.description,/no network/);
        await owner.close();
    }
});

test("outside-workspace paths are rejected before VM startup", async t => {
    const backend = new WorkspaceSandboxBackend(process.cwd(), process.cwd(), "sandbox-write"), internal=backend as any;
    let starts=0;t.mock.method(internal,"start",async () => {starts++;throw new Error("Unexpected VM startup");});
    try {
        await assert.rejects(backend.invoke("ls", {path:path.resolve(process.cwd(),"../outside")}), /outside.*workspace/i);
        assert.equal(starts,0);
    } finally {await backend.close();}
});
