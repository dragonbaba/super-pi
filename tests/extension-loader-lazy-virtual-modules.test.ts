import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	clearExtensionCache,
	loadExtensions,
	loadExtensionsCached,
} from "../packages/coding-agent/src/core/extensions/loader.ts";

const loaderSource = readFileSync("packages/coding-agent/src/core/extensions/loader.ts", "utf8");

test("virtual payload is absent from loader's startup static imports", () => {
	for (const specifier of [
		"@super-pi/agent-core",
		"@super-pi/ai/compat",
		"@super-pi/ai/oauth",
		"@super-pi/ai/providers/all",
		"typebox",
		"typebox/compile",
		"typebox/value",
		"../../index.ts",
	]) {
		assert.equal(loaderSource.includes(`from \"${specifier}\"`), false, specifier);
	}
	assert.doesNotMatch(loaderSource, /^import\s+\*\s+as\s+[^;]+from\s+\"@super-pi\/tui\"/m);
	assert.match(loaderSource, /loadVirtualModules/);
});

test("first extension load preserves aliases and concurrent cached loads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi087-extension-lazy-"));
	const extensionPath = join(directory, "extension.ts");
	await writeFile(extensionPath, `
import { Type } from "typebox";
import * as superAi from "@super-pi/ai";
import * as legacyAi from "@mariozechner/pi-ai";
export default (pi) => {
  const schema = Type.Object({ value: Type.Optional(Type.String()) });
  pi.registerFlag("lazy-aliases", { type: "boolean", default: Boolean(schema && superAi.getModelCapabilities === legacyAi.getModelCapabilities) });
};
`);
	try {
		clearExtensionCache();
		const [first, second] = await Promise.all([
			loadExtensionsCached([extensionPath], directory),
			loadExtensionsCached([extensionPath], directory),
		]);
		for (const result of [first, second]) {
			assert.equal(result.errors.length, 0, result.errors[0]?.error);
			assert.equal(result.extensions.length, 1);
			assert.equal(result.extensions[0]!.flags.get("lazy-aliases")?.default, true);
		}
	} finally {
		clearExtensionCache();
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed extension load does not poison a later retry or namespace identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi087-extension-retry-"));
	const extensionPath = join(directory, "retry.ts");
	try {
		await writeFile(extensionPath, "throw new Error('synthetic extension failure');\n");
		const failed = await loadExtensions([extensionPath], directory);
		assert.equal(failed.extensions.length, 0);
		assert.match(failed.errors[0]!.error, /synthetic extension failure/);
		await writeFile(extensionPath, `
import * as modernAi from "@super-pi/ai";
import * as compatAi from "@super-pi/ai/compat";
export default (pi) => pi.registerFlag("retry-alias", { type: "boolean", default: modernAi.getModelCapabilities === compatAi.getModelCapabilities });
`);
		const retried = await loadExtensions([extensionPath], directory);
		assert.equal(retried.errors.length, 0, retried.errors[0]?.error);
		assert.equal(retried.extensions[0]!.flags.get("retry-alias")?.default, true);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
