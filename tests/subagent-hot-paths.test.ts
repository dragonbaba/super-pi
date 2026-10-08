import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../packages/extensions/subagent/index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("subagent/index.ts", source, ts.ScriptTarget.Latest, true);
const hot = new Set(["onStdoutData", "onStderrData", "processLine", "appendBoundedMessage", "boundedMessage", "boundedUsage", "finiteUsage", "boundedTextContent", "capText", "prefixEnd", "capTextHeadTail", "jsonEventLimitReason", "jsonTransportLimitReason", "renderAgentStatus", "refreshStatus", "formatAgentUsage", "formatTokens", "formatElapsedMs", "resultStateCounts"]);

test("child checkpoint guidance and IPC use only named intercepting/lifecycle hooks", () => {
	const text = readFileSync(new URL("../packages/extensions/subagent/child-control.ts", import.meta.url), "utf8");
	const child = ts.createSourceFile("child-control.ts", text, ts.ScriptTarget.Latest, true);
	const allowed = new Set(["session_start", "before_agent_start", "context", "tool_call", "turn_start", "turn_end", "session_shutdown"]);
	let count = 0;
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && node.expression.getText(child) === "pi.on") {
			const event = node.arguments[0];
			assert.ok(event && ts.isStringLiteral(event) && allowed.has(event.text), "no provider-delta, tool-progress or message-update hook may acquire checkpoint work");
			count++;
		}
		ts.forEachChild(node, visit);
	}
	visit(child); assert.ok(count > 0);
});

test("child event ingestion and status rendering allocate no callbacks, promises or batch copies", () => {
	const found = new Set<string>(); const failures: string[] = [];
	function inspect(node: ts.Node, name: string): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) failures.push(`${name}: inline callback`);
		if (ts.isNewExpression(node) && ["Promise", "AbortController", "Map", "Set"].includes(node.expression.getText(tree))) failures.push(`${name}: ${node.expression.getText(tree)}`);
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			if (["map", "filter", "flatMap", "bind", "then", "catch", "finally"].includes(node.expression.name.text)) failures.push(`${name}: ${node.expression.name.text}`);
			if (["send", "saveCheckpoint", "request", "settle"].includes(node.expression.name.text)) failures.push(`${name}: control/checkpoint work belongs to lifecycle/turn boundaries`);
		}
		if (name === "processLine" && ts.isCallExpression(node) && node.expression.getText(tree) === "emitSingleResultUpdate") failures.push("per-message progress publication");
		ts.forEachChild(node, child => inspect(child, name));
	}
	function visit(node: ts.Node): void {
		if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body) {
			const name = node.name.getText(tree);
			if (hot.has(name)) { found.add(name); inspect(node.body, name); }
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
	assert.deepEqual(failures, []);
	assert.deepEqual([...found].sort(), [...hot].sort(), "all named production bodies must be checked");
});

test("production retention passes measured line bytes and lifecycle publication is explicit", () => {
	let retentionCalls = 0; let progressCalls = 0;
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			if (node.expression.text === "appendBoundedMessage") {
				retentionCalls++;
				assert.equal(node.arguments[2]?.getText(tree), "lineBytes");
			}
			if (node.expression.text === "emitSingleResultUpdate") {
				progressCalls++;
				let owner: ts.Node | undefined = node.parent;
				while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
				assert.ok(owner && ts.isFunctionDeclaration(owner) && owner.name?.text === "runSingleAgent", "only explicit task startup/completion may publish snapshots");
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
	assert.equal(retentionCalls, 2);
	assert.equal(progressCalls, 3); // Startup, completion, and exceptional startup/cleanup failure.
});
