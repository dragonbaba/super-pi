import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

for (const concurrentDiscard of [false, true]) test(`workspace cleanup has one artifact owner: discard=${concurrentDiscard}`, async t => {
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-shutdown-")));
	t.after(() => removeOwnedFixture(parent));
	const root = path.join(parent, "workspace"); await fs.mkdir(root);
	const file = path.join(root, "owned.txt"); await fs.writeFile(file, "fixture");
	const backend = new WorkspaceSandboxBackend(parent, parent, "sandbox-write"), internal = backend as any;
	const identity = await fs.lstat(root, { bigint: true });
	internal.root = root; internal.identity = identity.dev + ":" + identity.ino;
	await internal.remember(root); await internal.remember(file);
	let release!: () => void, cleanupCalls = 0, artifactCalls = 0;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const vm = { state: "open", cleanup() { cleanupCalls++; return gate; } };
	internal.vm = vm;
	const releaseArtifacts = internal.releaseArtifacts.bind(internal);
	t.mock.method(internal, "releaseArtifacts", async () => { artifactCalls++; await releaseArtifacts(); });
	const first = concurrentDiscard ? backend.discardSnapshot() : backend.close();
	const second = backend.close();
	const settled = Promise.allSettled([first, second]);
	vm.state = "closed"; release();
	const results = await settled;
	t.diagnostic(JSON.stringify({concurrentDiscard,cleanupCalls,artifactCalls,outcomes:results.map(result=>result.status === "fulfilled" ? {status:result.status} : {status:result.status,error:String(result.reason)})}));
	assert.ok(results.every(result => result.status === "fulfilled"), "concurrent cleanup must not race VM or artifact release");
	assert.equal(cleanupCalls, 1); assert.equal(artifactCalls, 1);
	if (!concurrentDiscard) assert.equal(first, second, "repeated close joins the exact completion promise");
	assert.equal(backend.diagnostics.vm, false); assert.equal(backend.diagnostics.ownedArtifacts, 0);
	assert.equal(backend.close(), second, "completed close reuses its settled completion");
	assert.equal(internal.discardOperation, undefined);
	await assert.rejects(backend.invoke("ls", {path:parent}), /SANDBOX_BUSY/);
});

for (const failure of ["vm", "artifacts"]) test(`failed ${failure} cleanup retains ownership and permits an explicit retry`, async t => {
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-shutdown-retry-")));
	t.after(() => removeOwnedFixture(parent));
	const root = path.join(parent, "workspace"); await fs.mkdir(root);
	const file = path.join(root, "owned.txt"); await fs.writeFile(file, "fixture");
	const backend = new WorkspaceSandboxBackend(parent, parent, "sandbox-write"), internal = backend as any;
	const stat = await fs.lstat(root, {bigint:true}); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
	await internal.remember(root); await internal.remember(file);
	const error = new Error("controlled cleanup failure"); let fail = true, vmCalls = 0, artifactCalls = 0;
	const vm = {state:"open", async cleanup() { vmCalls++; if (fail && failure === "vm") throw error; this.state = "closed"; }};
	internal.vm = vm;
	const releaseArtifacts = internal.releaseArtifacts.bind(internal);
	t.mock.method(internal, "releaseArtifacts", async () => {
		artifactCalls++; if (fail && failure === "artifacts") throw error; await releaseArtifacts();
	});
	const first = backend.close(); assert.equal(backend.close(), first);
	await assert.rejects(first, caught => caught === error);
	assert.equal(internal.closeOperation, undefined); assert.equal(internal.discardOperation, undefined);
	assert.equal(backend.diagnostics.closed, true); assert.equal(backend.diagnostics.ownedArtifacts, 2);
	assert.equal(backend.diagnostics.vm, failure === "vm"); assert.equal(await fs.readFile(file, "utf8"), "fixture");
	await assert.rejects(backend.invoke("ls", {}), /SANDBOX_BUSY/);
	fail = false; const retry = backend.close(); assert.notEqual(retry, first); await retry;
	assert.equal(vmCalls, failure === "vm" ? 2 : 1); assert.equal(artifactCalls, failure === "artifacts" ? 2 : 1);
	assert.equal(backend.diagnostics.ownedArtifacts, 0); assert.equal(backend.diagnostics.vm, false);
	assert.equal(backend.diagnostics.root, undefined); assert.equal(backend.close(), retry);
});

test("discard blocks new invocations until release and allows a fresh snapshot afterward", async t => {
	const backend = new WorkspaceSandboxBackend(os.tmpdir(), os.tmpdir(), "read-only"), internal = backend as any;
	let release!: () => void, calls = 0;
	const gate = new Promise<void>(resolve => {release = resolve;});
	internal.vm = {state:"closed", cleanup() {return gate;}};
	t.mock.method(internal, "run", async () => {calls++; return {id:"fresh",ok:true};});
	const discard = backend.discardSnapshot(); assert.equal(backend.discardSnapshot(), discard);
	await assert.rejects(backend.invoke("ls", {}), /SANDBOX_BUSY/); assert.equal(calls, 0);
	release(); await discard;
	assert.equal(backend.diagnostics.closed, false); assert.equal(internal.discardOperation, undefined);
	assert.equal((await backend.invoke("ls", {})).id, "fresh"); assert.equal(calls, 1); await backend.close();
});

for (const failed of [false, true]) test(`close joins a pending operation before releasing its owner: failed=${failed}`, async t => {
	const backend = new WorkspaceSandboxBackend(os.tmpdir(), os.tmpdir(), "read-only"), internal = backend as any;
	let resolve!: (value: any) => void, reject!: (error: Error) => void, cleanupCalls = 0;
	const operation = new Promise<any>((yes, no) => {resolve = yes; reject = no;});
	t.mock.method(internal, "run", () => operation);
	internal.vm = {state:"closed", async cleanup() {cleanupCalls++;}};
	const pending = backend.invoke("ls", {}), observed = Promise.allSettled([pending]);
	const close = backend.close(); assert.equal(close, backend.close());
	await Promise.resolve(); await Promise.resolve(); assert.equal(cleanupCalls, 0);
	assert.equal(backend.diagnostics.pending, true); await assert.rejects(backend.invoke("ls", {}), /SANDBOX_BUSY/);
	if (failed) reject(new Error("operation failed")); else resolve({id:"pending",ok:true});
	await close; assert.equal((await observed)[0]!.status, failed ? "rejected" : "fulfilled");
	assert.equal(cleanupCalls, 1); assert.equal(backend.diagnostics.pending, false); assert.equal(backend.diagnostics.vm, false);
});

test("workspace admission and shared close add no inline callbacks, regexes or wrapper allocations", () => {
	const source = ts.createSourceFile("workspace-backend.ts", readFileSync(new URL("../packages/coding-agent/src/core/sandbox/workspace-backend.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const methods = new Set(["invoke", "discardSnapshot", "performDiscardSnapshot", "close", "performClose", "closeVm"]);
	let checked = 0;
	function visit(node: ts.Node): void {
		if (ts.isMethodDeclaration(node) && methods.has(node.name.getText(source))) {
			checked++;
			const methodName = node.name.getText(source);
			function inspect(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isObjectLiteralExpression(child)
					|| ts.isArrayLiteralExpression(child) || child.kind === ts.SyntaxKind.RegularExpressionLiteral, false, methodName);
				if (ts.isNewExpression(child)) assert.equal(child.expression.getText(source), "Error", "Only refusal errors allocate explicitly");
				ts.forEachChild(child, inspect);
			}
			if (node.body) inspect(node.body);
		} else ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(checked, methods.size);
});
