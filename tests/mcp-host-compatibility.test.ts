import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
// @ts-expect-error JavaScript extension package.
import { checkRuntimeCompatibility } from "../packages/mcp-bridge/src/runtime-compat.js";

test("host version without typed-source export is rejected before runtime load", () => {
	const result = checkRuntimeCompatibility("0.84.1", false);
	assert.equal(result.compatible, false);
	assert.match(result.reason, /adapter/i);
	assert.equal(checkRuntimeCompatibility("0.84.1", true).compatible, true);
});

test("an older host can load the extension entry and reach the capability gate", async () => {
	const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
		if (specifier === "@super-pi/coding-agent/internal/tool-result-source") {
			const error = new Error("fixture missing export");
			Object.assign(error, { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
			throw error;
		}
		return nextResolve(specifier, context);
	} });
	try {
		// @ts-expect-error JavaScript extension entry.
		await import("../packages/mcp-bridge/src/index.js");
		const compatibility = checkRuntimeCompatibility("0.84.1");
		assert.equal(compatibility.compatible, false);
		assert.match(compatibility.reason, /adapter/i);
	} finally { hooks.deregister(); }
});
