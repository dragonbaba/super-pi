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
	await assert.rejects(backend.invoke("ls", {path:parent}), /SANDBOX_CLOSED/);
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
	await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/);
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
	assert.equal(backend.diagnostics.pending, true); await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/);
	if (failed) reject(new Error("operation failed")); else resolve({id:"pending",ok:true});
	await close; assert.equal((await observed)[0]!.status, failed ? "rejected" : "fulfilled");
	assert.equal(cleanupCalls, 1); assert.equal(backend.diagnostics.pending, false); assert.equal(backend.diagnostics.vm, false);
});

test("pre-start timeout preserves the original error, releases artifacts and permits another invocation and shutdown", async t => {
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-prestart-")));
	t.after(() => removeOwnedFixture(parent));
	const backend = new WorkspaceSandboxBackend(parent, parent, "sandbox-write"), internal = backend as any;
	const original = new Error("CLI list: timeout; ownership retained");
	let starts = 0, cleanupCalls = 0;
	t.mock.method(internal, "start", async () => {
		starts++;
		const root = await fs.mkdtemp(path.join(parent, "owned-"));
		const stat = await fs.lstat(root, {bigint:true}); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
		await internal.remember(root);
		internal.vm = {state:"preflight", async cleanup() { cleanupCalls++; this.state = "closed-before-start"; return true; }};
		throw original;
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(backend.invoke("ls", {}), error => error === original);
		assert.equal(backend.diagnostics.closed, false); assert.equal(backend.diagnostics.vm, false);
		assert.equal(backend.diagnostics.ownedArtifacts, 0); assert.equal(backend.diagnostics.root, undefined);
	}
	assert.equal(starts, 2); assert.equal(cleanupCalls, 2);
	await backend.close(); await backend.close(); assert.equal(cleanupCalls, 2);
});

test("unresolved cleanup retains owners and reports both the operation and cleanup cause", async t => {
	const backend = new WorkspaceSandboxBackend(os.tmpdir(), os.tmpdir(), "read-only"), internal = backend as any;
	const vm = {state:"blocked-cleanup", cleanupError:"CLI remains physically pending", active:{}, async cleanup() { return false; }};
	t.mock.method(internal, "start", async () => {internal.vm = vm; throw new Error("CLI list: timeout");});
	await assert.rejects(backend.invoke("ls", {}), /CLI list: timeout[\s\S]*CLI remains physically pending/);
	assert.equal(internal.vm, vm);
	await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED.*Waiting or retrying tools cannot reopen/);
	// A terminal state alone cannot release a still-owned physical process.
	vm.state = "closed-before-start";
	await assert.rejects(backend.close(), /cleanup unresolved/);
	vm.active = undefined as any; await backend.close(); assert.equal(internal.vm, undefined);
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
