import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { checkRuntimeCompatibility } from "../packages/mcp-bridge/src/runtime-compat.js";

test("host version without typed-source export is rejected before runtime load", () => {
	const result = checkRuntimeCompatibility("0.84.1", false);
	assert.equal(result.compatible, false);
	assert.match(result.reason, /adapter/i);
	assert.equal(checkRuntimeCompatibility("0.84.1", true).compatible, true);
});
