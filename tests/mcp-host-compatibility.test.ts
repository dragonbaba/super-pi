import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error JavaScript extension package.
import { checkRuntimeCompatibility } from "../packages/mcp-bridge/src/runtime-compat.js";

test("host version without typed-source export is rejected before runtime load", () => {
	const result = checkRuntimeCompatibility("0.84.1", false);
	assert.equal(result.compatible, false);
	assert.match(result.reason, /adapter/i);
	assert.equal(checkRuntimeCompatibility("0.84.1", true).compatible, true);
	assert.equal(checkRuntimeCompatibility("0.84.1").compatible, true, "current host must pass the actual capability probe");
});

test("an older host can load the extension entry and reach the capability gate", async () => {
	const root = mkdtempSync(join(tmpdir(), "mcp-host-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		const host = join(root, "node_modules", "@super-pi", "coding-agent");
		mkdirSync(host, { recursive: true });
		writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@super-pi/coding-agent", version: "0.84.1", type: "module", exports: { ".": "./index.js" } }));
		writeFileSync(join(host, "index.js"), "export {};\n");
		const extension = join(root, "extension");
		mkdirSync(extension);
		for (const file of ["index.js", "config.js", "runtime-compat.js", "security.js", "lifecycle.js", "regex.js"]) {
			copyFileSync(new URL(`../packages/mcp-bridge/src/${file}`, import.meta.url), join(extension, file));
		}
		const entry = await import(pathToFileURL(join(extension, "index.js")).href);
		assert.equal(typeof entry.default, "function");
		const compat = await import(pathToFileURL(join(extension, "runtime-compat.js")).href);
		const compatibility = compat.checkRuntimeCompatibility("0.84.1");
		assert.equal(compatibility.compatible, false);
		assert.match(compatibility.reason, /adapter/i);
	} finally {
		const target = resolve(root);
		assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("mcp-host-"));
		rmSync(target, { recursive: true, force: true });
	}
});
