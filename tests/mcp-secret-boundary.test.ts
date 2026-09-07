import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

test("MCP failed connection never retains server stderr or error causes", async () => {
	const runtime = new McpBridgeRuntime({ registerTool() {} }, process.cwd());
	const secret = "CANARY_MCP_STDERR_SECRET";
	try {
		await assert.rejects(runtime.connect({ id: "fixture", transport: "stdio", command: process.execPath,
			args: ["-e", `process.stderr.write('${secret}');process.exit(1)`], startupTimeoutMs: 3000, maxTools: 1 }), (error: Error) => {
			assert.equal(error.cause, undefined);
			assert.equal(error.message.includes(secret), false);
			return true;
		});
		const state = runtime.states.get("fixture");
		assert.equal(String(state.stderr).includes(secret), false);
		assert.equal(state.client, null);
		assert.equal(state.transport, null);
	} finally { await runtime.close(); }
});
