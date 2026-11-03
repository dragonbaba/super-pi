import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExtensions } from "../packages/coding-agent/dist/core/extensions/loader.js";

test("statusline manifest uses the host version in SDK apps and preserves safe degradation", { timeout: 5000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "statusline-host-"));
	const previousEntry = process.argv[1];
	let loaded: Awaited<ReturnType<typeof loadExtensions>> | undefined;
	let requests = 0;
	t.after(async () => {
		try {
			if (loaded) {
				await loaded.runtime.executionBoundary.dispose(); await loaded.runtime.disposeProviderOwners();
				loaded.runtime.invalidate();
				assert.equal(loaded.runtime.executionBoundary.participantCount, 0);
				assert.equal(loaded.runtime.executionBoundary.hasDeadline, false);
			}
			assert.equal(requests, 0);
		} finally {
			process.argv[1] = previousEntry; t.mock.restoreAll();
			const target = resolve(root);
			assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("statusline-host-"));
			rmSync(target, { recursive: true, force: true }); assert.equal(existsSync(target), false);
		}
	});
	t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Fixture must remain offline"); });
	process.argv[1] = join(root, "sdk-app.mjs");
	writeFileSync(process.argv[1], "// ordinary SDK entry, outside the host package\n");
	const packageRoot = fileURLToPath(new URL("../packages/statusline/", import.meta.url));
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
	// Use the actual compiled entry and built Node host aliases, not a copied
	// implementation or a stub of registerStatusline. No footer is mounted here.
	loaded = await loadExtensions(manifest.pi.extensions.map((entry: string) => resolve(packageRoot, entry)), root);
	assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
	const handlers = loaded.extensions[0]!.handlers;
	for (const event of ["session_start", "session_shutdown", "message_end", "agent_settled"] as const) {
		assert.equal(handlers.get(event)?.length, 1, `actual statusline must register ${event}`);
	}

	// A plausible CLI location must not override a missing or unsupported loaded
	// host VERSION. Deliberately omit the implementation on both rejected hosts.
	process.argv[1] = fileURLToPath(new URL("../packages/coding-agent/dist/cli.js", import.meta.url));
	for (const [name, exports, reason] of [
		["missing-version", "export {};", /version is unavailable/],
		["unsupported-version", 'export const VERSION = "0.83.1";', /unsupported/],
		["implementation-failure", 'export const VERSION = "0.84.1";', /could not start on Pi 0\.84\.1: synthetic/],
	] as const) {
		const fixture = join(root, name), host = join(fixture, "node_modules/@super-pi/coding-agent");
		mkdirSync(host, { recursive: true });
		writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@super-pi/coding-agent", type: "module", exports: "./index.js" }));
		writeFileSync(join(host, "index.js"), exports);
		for (const file of ["index.js", "runtime-compat.js", "regex.js", "terminal-text.js"]) {
			copyFileSync(join(packageRoot, "dist", file), join(fixture, file));
		}
		if (name === "implementation-failure") {
			writeFileSync(join(fixture, "statusline.js"), `throw new Error(${JSON.stringify("\x1b[31msynthetic\x1b[0m " + "x".repeat(500))});`);
		}
		const entry = await import(pathToFileURL(join(fixture, "index.js")).href);
		const registered = new Map<string, (event: unknown, ctx: unknown) => unknown>(), warnings: string[] = [];
		await entry.default({ on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { registered.set(event, handler); } });
		assert.deepEqual([...registered.keys()], ["session_start"]);
		const notify = (message: string, level: string) => { assert.equal(level, "warning"); warnings.push(message); };
		await registered.get("session_start")!({}, { hasUI: false, ui: { notify } });
		assert.equal(warnings.length, 0);
		await registered.get("session_start")!({}, { hasUI: true, ui: { notify } });
		assert.equal(warnings.length, 1); assert.match(warnings[0]!, reason);
		assert.doesNotMatch(warnings[0]!, /[\x00-\x1f\x7f]/u); assert.ok(warnings[0]!.length < 320);
	}
});
