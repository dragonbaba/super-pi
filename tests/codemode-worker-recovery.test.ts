import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";
import { MAX_ERROR_CHARS } from "../packages/codemode/src/limits.ts";

async function verifyWorkerReplacement(extension: "ts" | "js"): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "sp-codemode-worker-recovery-"));
	const installed = join(root, "installed");
	const displaced = join(root, "displaced");
	const worker = join(installed, `worker.${extension}`);
	const dependency = join(installed, "dependency.mjs");
	const actualWorker = new URL(`../packages/codemode/${extension === "ts" ? "src" : "dist"}/runtime/worker.${extension}`, import.meta.url).href;
	let calls = 0;
	const sandbox = new CodemodeSandbox({ workerUrl: pathToFileURL(worker), tools: [{ name: "touch", execute: () => ++calls }] });
	const controller = new AbortController();
	try {
		mkdirSync(installed);
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		writeFileSync(worker, 'import "./dependency.mjs";');
		writeFileSync(dependency, `import ${JSON.stringify(actualWorker)};`);
		assert.equal((await sandbox.execute("return await tools.touch({})")).ok, true);
		assert.equal(calls, 1);
		assert.equal(dirname(installed), root);
		assert.equal(dirname(displaced), root);
		renameSync(installed, displaced);
		for (const missing of ["entry", "dependency"]) {
			if (missing === "dependency") {
				mkdirSync(installed);
				writeFileSync(worker, 'import "./dependency.mjs";');
			}
			const failed = await sandbox.execute('store("lost", 1); return await tools.touch({})', { signal: controller.signal });
			assert.equal(failed.ok, false);
			if (!failed.ok) {
				assert.equal(failed.error.kind, "sandbox");
				assert.match(failed.error.message, /restart the application/i);
				assert.match(failed.error.message, /rebuild or reinstall/i);
				assert.ok(failed.error.message.includes(missing === "entry" ? `worker.${extension}` : "dependency.mjs"));
				assert.ok(failed.error.message.length <= MAX_ERROR_CHARS);
			}
			assert.deepEqual(failed.calls, []);
			assert.deepEqual(failed.output, []);
			assert.equal("storeWrites" in failed, false);
			assert.equal(calls, 1, "a failed worker load must not replay a script or tool");
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			assert.equal(sandbox.stats.activeExecutions, 0);
			assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		}
		writeFileSync(dependency, `import ${JSON.stringify(actualWorker)};`);
		const recovered = await sandbox.execute('return [load("lost"), await tools.touch({})]');
		assert.equal(recovered.ok, true, JSON.stringify(recovered));
		if (recovered.ok) assert.deepEqual(recovered.value, [null, 2]);
	} finally {
		await sandbox.close();
		assert.equal(dirname(root), tmpdir());
		rmSync(root, { recursive: true, force: true });
	}
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 4, workersStopped: 4 });
	assert.equal(existsSync(root), false);
}

test("Codemode reports replaced worker files and recovers only on a later explicit execution", async t => {
	await t.test("source", () => verifyWorkerReplacement("ts"));
	await t.test("dist", () => verifyWorkerReplacement("js"));
});

test("Codemode worker recovery hints use error codes and stay within the diagnostic limit", async () => {
	const root = mkdtempSync(join(tmpdir(), "sp-codemode-worker-errors-"));
	const worker = join(root, "worker.mjs");
	// These workers throw before VM startup, so no compiled WASM is needed.
	const sandbox = new CodemodeSandbox({ workerUrl: pathToFileURL(worker), wasm: {} });
	const invalid = new CodemodeSandbox({ workerUrl: "invalid-worker", wasm: {} });
	try {
		const unrelated = "Cannot find module is just diagnostic text";
		writeFileSync(worker, `throw new Error(${JSON.stringify(unrelated)});`);
		const failed = await sandbox.execute("return 1");
		assert.equal(failed.ok, false);
		if (!failed.ok) {
			assert.equal(failed.error.kind, "sandbox");
			assert.equal(failed.error.message, unrelated);
		}
		writeFileSync(worker, `throw Object.assign(new Error("x".repeat(${MAX_ERROR_CHARS * 2})), {code:"ENOENT"});`);
		const bounded = await sandbox.execute("return 1");
		assert.equal(bounded.ok, false);
		if (!bounded.ok) {
			assert.match(bounded.error.message, /restart the application/);
			assert.match(bounded.error.message, /Original error: x+$/);
			assert.equal(bounded.error.message.length, MAX_ERROR_CHARS);
		}
		const badPath = await invalid.execute("return 1");
		assert.equal(badPath.ok, false);
		if (!badPath.ok) {
			assert.match(badPath.error.message, /^Failed to start worker:/);
			assert.doesNotMatch(badPath.error.message, /restart the application/);
		}
	} finally {
		await sandbox.close();
		await invalid.close();
		assert.equal(dirname(root), tmpdir());
		rmSync(root, { recursive: true, force: true });
	}
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 2, workersStopped: 2 });
	assert.deepEqual(invalid.stats, { activeExecutions: 0, workersStarted: 0, workersStopped: 0 });
	assert.equal(existsSync(root), false);
});
