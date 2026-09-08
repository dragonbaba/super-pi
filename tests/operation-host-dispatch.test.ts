import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Agent } from "../packages/agent/src/agent.ts";

test("host dispatch uses policy and real execution, never provider or sibling calls", async () => {
	let effects = 0;
	let providers = 0;
	const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); } });
	agent.state.tools = [{ name: "write", label: "write", description: "fixture", parameters: Type.Object({ content: Type.String() }),
		execute: async (_id, args) => { effects++; assert.equal((args as { content: string }).content, "changed"); return { content: [{ type: "text", text: "receipt" }], details: undefined }; } }];
	agent.beforeToolCall = async ({ args }) => { (args as { content: string }).content = "changed"; return undefined; };
	const events: string[] = [];
	agent.subscribe(event => { events.push(event.type); });
	await agent.dispatchHostTool({ type: "toolCall", id: "host-1", name: "write", arguments: { content: "original" } });
	assert.equal(effects, 1);
	assert.equal(providers, 0);
	assert.deepEqual(events, ["agent_start", "turn_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "message_start", "message_end", "turn_end", "agent_end"]);
	agent.beforeToolCall = async () => ({ block: true, reason: "denied" });
	await agent.dispatchHostTool({ type: "toolCall", id: "host-2", name: "write", arguments: { content: "original" } });
	assert.equal(effects, 1);
	assert.equal(providers, 0);
});

test("late mutation of canonical call metadata cannot select an unrelated tool", async () => {
	let writes = 0, unrelated = 0, executedContent = "";
	const agent = new Agent({ streamFn: () => { throw new Error("provider forbidden"); } });
	agent.state.tools = [
		{ name: "write", label: "write", description: "fixture", parameters: Type.Object({ content: Type.String() }), execute: async (_id, args) => { writes++; executedContent = (args as { content: string }).content; return { content: [], details: undefined }; } },
		{ name: "other", label: "other", description: "fixture", parameters: Type.Object({}), execute: async () => { unrelated++; return { content: [], details: undefined }; } },
	];
	let canonical: { name: string; arguments: Record<string, unknown> } | undefined;
	agent.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") canonical = event.message.content.find(block => block.type === "toolCall");
		if (event.type === "tool_execution_start") { canonical!.arguments.content = "redirected"; canonical!.name = "other"; canonical!.arguments = {}; }
	});
	const result = await agent.dispatchHostTool({ type: "toolCall", id: "selected-late", name: "write", arguments: { content: "original" } });
	assert.equal(writes, 1); assert.equal(unrelated, 0); assert.equal(result.toolName, "write");
	assert.equal(executedContent, "original");
	assert.equal(canonical!.name, "other", "canonical messages must remain mutable");
});

test("host busy exclusion and idle include final awaited delivery; failure does not fabricate assistant error", async () => {
	const agent = new Agent({ streamFn: () => { throw new Error("provider forbidden"); } });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let entered!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	agent.subscribe(async event => { if (event.type === "agent_end") { entered(); await gate; } });
	const call = { type: "toolCall" as const, id: "host-3", name: "missing", arguments: {} };
	const running = agent.dispatchHostTool(call);
	await ready;
	await assert.rejects(agent.dispatchHostTool({ ...call, id: "host-4" }), /already processing/);
	let idle = false;
	const waiting = agent.waitForIdle().then(() => { idle = true; });
	await Promise.resolve(); assert.equal(idle, false);
	release(); await running; await waiting;
	assert.equal(idle, true);
	assert.equal(agent.state.messages.some(m => m.role === "assistant" && m.stopReason === "error"), false);
});

test("host delivery failure and sibling injection clean up without an assistant retry or provider call", async () => {
	let providers = 0;
	const agent = new Agent({ streamFn: () => { providers++; throw new Error("provider forbidden"); } });
	const unsubscribe = agent.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			event.message.content.push({ type: "toolCall", id: "unrelated-sibling", name: "missing", arguments: {} });
		}
	});
	await assert.rejects(agent.dispatchHostTool({ type: "toolCall", id: "selected", name: "missing", arguments: {} }), /association changed/);
	await agent.waitForIdle();
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.pendingToolCalls.size, 0);
	assert.equal(agent.state.messages.some(m => m.role === "toolResult"), false);
	assert.equal(providers, 0);
	unsubscribe();
	agent.subscribe(event => { if (event.type === "agent_start") throw new Error("delivery failed"); });
	await assert.rejects(agent.dispatchHostTool({ type: "toolCall", id: "delivery-error", name: "missing", arguments: {} }), /delivery failed/);
	await agent.waitForIdle();
	assert.equal(providers, 0);
});

test("host start-event arguments are observational across an awaited permission hook", async () => {
 const agent = new Agent({ streamFn: () => { throw new Error("provider forbidden"); } });
 let observed: Record<string, unknown> | undefined;
 let actual = "";
 agent.state.tools = [{ name: "write", label: "write", description: "fixture", parameters: Type.Object({ content: Type.String() }), execute: async (_id, args) => { actual = (args as {content:string}).content; return {content: [], details: undefined}; } }];
 agent.subscribe(event => { if (event.type === "tool_execution_start") { observed = event.args as Record<string, unknown>; observed.content = "observer"; } });
 agent.beforeToolCall = async ({args}) => { assert.equal((args as {content:string}).content, "host"); await Promise.resolve(); observed!.content = "retained observer"; (args as {content:string}).content = "permission"; return undefined; };
 await agent.dispatchHostTool({type:"toolCall", id:"observational", name:"write", arguments:{content:"host"}});
 assert.equal(actual, "permission");
});
