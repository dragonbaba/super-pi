import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

for (const kind of ["text", "image"]) test(`immutable large MCP ${kind} is hashed once across artifact integrity reads`, () => {
	const text = kind === "text" ? "source ".repeat(150_000) : Buffer.concat([Buffer.from("\xff\xd8\xff", "latin1"), Buffer.alloc(128 * 1024)]).toString("base64");
	const createHash = crypto.createHash;
	let fullHashes = 0;
	crypto.createHash = ((...args: Parameters<typeof createHash>) => {
		const hash = createHash(...args);
		const update = hash.update;
		hash.update = function (value: any, ...rest: any[]) {
			if (value === text) fullHashes++;
			return update.call(this, value, ...rest as [any]);
		};
		return hash;
	}) as typeof createHash;
	syncBuiltinESMExports();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "hash-session")!;
	try {
		const content = convertMcpResult({ content: kind === "text" ? [{ type: "text", text }] : [{ type: "text", text: "recovery ".repeat(10_000) }, { type: "image", data: text, mimeType: "image/jpeg" }] });
		const view = owner.create(content, "hash-call");
		if (view?.version !== 2 || !view.artifact) assert.fail("artifact missing");
		for (let index = 0; index < 3; index++) owner.readArtifact(view.artifact.id, [{ role: "toolResult", toolCallId: "hash-call", content }]);
		assert.equal(fullHashes, 1);
	} finally { crypto.createHash = createHash; syncBuiltinESMExports(); owner.dispose(); }
});

test("restored typed source integrity includes its recovery requirement", () => {
	const content = convertMcpResult({ content: [], structuredContent: { text: "x".repeat(1024 * 1024) } });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "policy-session")!;
	try {
		const view = owner.create(content, "policy-call");
		if (view?.version !== 2 || !view.artifact) assert.fail("artifact missing");
		const messages = JSON.parse(JSON.stringify([{ role: "toolResult", toolCallId: "policy-call", content }]));
		messages[0].content[0].mcpSource.requiresRecovery = false;
		owner.clearProjectionRecords();
		assert.throws(() => owner.readArtifact(view.artifact!.id, messages));
	} finally { owner.dispose(); }
});
