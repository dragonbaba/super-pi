import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime, convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

for (const outcome of ["success", "error", "abort", "dispose"]) {
	test(`four parallel MCP calls release progress on ${outcome}`, async () => {
		const pending: any[] = [];
		const runtime = new McpBridgeRuntime({ registerTool() {} }, "parallel-workspace");
		const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
			callTool(_params: any, _schema: any, options: any) {
				return new Promise((resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
					pending.push({ options, resolve, reject });
				});
			}, async close() {},
		} };
		const controller = new AbortController();
		const updates = [0, 0, 0, 0];
		const results = Array.from({ length: 4 }, (_, index) => runtime.callRemoteTool(state, "fixture", { index }, controller.signal, () => { updates[index]!++; }));
		const settled = Promise.allSettled(results);
		assert.equal(runtime.activeCalls.size, 4);
		for (const call of pending) { call.options.onprogress({ progress: 1 }); call.options.onprogress({ progress: 2 }); }
		assert.deepEqual(updates, [2, 2, 2, 2]);
		if (outcome === "abort") controller.abort();
		else if (outcome === "dispose") await runtime.close();
		else for (let index = 0; index < pending.length; index++) {
			if (outcome === "error") pending[index].reject(new Error("CANARY_PROTOCOL_SECRET"));
			else pending[index].resolve({ content: [{ type: "text", text: String(index) }] });
		}
		const final = await settled;
		assert.equal(runtime.activeCalls.size, 0);
		for (const call of pending) call.options.onprogress({ progress: 3, message: "CANARY_LATE_SECRET" });
		assert.deepEqual(updates, [2, 2, 2, 2]);
		assert.equal(final.length, 4);
		for (let index = 0; index < final.length; index++) {
			const result = final[index]!;
			assert.equal(result.status, outcome === "success" ? "fulfilled" : "rejected");
			if (result.status === "fulfilled") assert.equal(result.value.content[0].text, String(index));
			else assert.equal(String(result.reason).includes("CANARY"), false);
		}
		await runtime.close();
	});
}

test("typed MCP recovery stays in session and active branch across restore", () => {
	const source = { type: "resource", resource: { uri: "fixture://blob", blob: "YQ==", mimeType: "application/octet-stream" } };
	const content = convertMcpResult({ content: [source] });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "session-a")!;
	const foreign = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "session-b")!;
	try {
		const view = owner.create(content, "call-a");
		if (view?.version !== 2 || !view.artifact) assert.fail("artifact missing");
		const messages = JSON.parse(JSON.stringify([{ role: "toolResult", toolCallId: "call-a", content }]));
		owner.clearProjectionRecords();
		const restored = owner.readArtifact(view.artifact.id, messages);
		assert.equal((restored.content[0] as any).mcpSource.value.resource.blob, "YQ==");
		assert.throws(() => foreign.readArtifact(view.artifact!.id, messages));
		assert.throws(() => owner.readArtifact(view.artifact!.id, []));
		assert.throws(() => owner.readArtifact(view.artifact!.id, [{ role: "toolResult", toolCallId: "foreign-call", content }]));
	} finally { owner.dispose(); foreign.dispose(); }
});
