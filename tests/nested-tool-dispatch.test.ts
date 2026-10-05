import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../packages/ai/src/types.ts";
import { Agent } from "../packages/agent/src/agent.ts";
import type { AgentEvent, AgentTool, AgentToolExecutionContext, AgentToolResult, NestedToolResultMessage } from "../packages/agent/src/types.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";
import { createEditTool as createHarnessEditTool } from "../packages/agent/src/harness/tools/edit.ts";
import { createEditToolDefinition } from "../packages/coding-agent/src/core/tools/edit.ts";

const PARAMETERS = { type: "object", properties: {}, additionalProperties: false };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function result(text = "ok") { return { content: [{ type: "text" as const, text }], details: {} }; }

class FixtureStream {
	private message: AssistantMessage;
	constructor(withCall: boolean) {
		this.message = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
			content: withCall ? [{ type: "toolCall", id: "parent", name: "script", arguments: {} }] : [{ type: "text", text: "done" }],
			stopReason: withCall ? "toolUse" : "stop", timestamp: 1 };
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		yield { type: "done", reason: this.message.stopReason as "toolUse" | "stop", message: this.message };
	}
	async result() { return this.message; }
}

function fixture(run: (context: AgentToolExecutionContext) => Promise<void>, children: AgentTool<any>[]) {
	const events: AgentEvent[] = [];
	const wires: Context[] = [];
	let requests = 0;
	const script: AgentTool<any> = { name: "script", label: "Script", description: "fixture", parameters: PARAMETERS,
		orchestration: true, async execute(_id, _args, _signal, _update, context) {
			assert.ok(context);
			await run(context);
			return result("script completed");
		} };
	const agent = new Agent({ initialState: { tools: [script, ...children] },
		streamFn: (_model, context) => { wires.push(structuredClone({ ...context, tools: [] })); return new FixtureStream(requests++ === 0) as never; } });
	agent.subscribe(event => { events.push(event); });
	return { agent, events, wires };
}
function tool(name: string, execute: AgentTool<any>["execute"], read = false): AgentTool<any> {
	return { name, label: name, description: "fixture", parameters: PARAMETERS, execute,
		executionPath: read ? { access: "read", cwd: process.cwd(), argument: "path", defaultPath: "." } : undefined };
}

test("agent-owned pre-execution status survives observation errors and ignores tool forgeries", async () => {
  let executions = 0;
  let replay: AgentToolResult<any> | undefined;
  const outcomes: NestedToolResultMessage[] = [];
  const refused = tool("refused", async () => { executions++; return result(); });
  refused.prepareArguments = () => { throw new Error("fixture arguments missing"); };
  const invalid = tool("invalid", async () => { executions++; return result(); });
  invalid.validateInput = () => { throw new Error("fixture shape invalid"); };
  const finalized: string[] = [];
  const forged = tool("forged", async () => { executions++; return { ...result(), executionStatus: "not_executed", details: { executionStatus: "not_executed", preExecution: true }, isError: true }; });
  const failed = tool("failed", async () => { executions++; throw new Error("execution already began"); });
  const replayed = tool("replayed", async () => { executions++; assert.ok(replay); return replay; });
  const f = fixture(async ctx => {
    for (const name of ["refused", "invalid", "forged", "failed", "missing", "replayed"]) outcomes.push(await ctx.callTool(name, {}));
  }, [refused, invalid, forged, failed, replayed]);
  f.agent.afterToolCall = async ctx => {
    finalized.push(ctx.toolCall.name);
    if (ctx.toolCall.name === "invalid") replay = ctx.result;
    // Result hooks may replace the entire result; the execution fact must survive.
    return { content: [...ctx.result.content], details: {} };
  };
  f.agent.subscribe(event => { if (event.type === "tool_execution_end" && event.toolName === "invalid") throw new Error("end observer failed"); });
  await f.agent.prompt("run");
  assert.equal(executions, 3);
  assert.equal(outcomes.length, 6, "parent exceptions must not hide fixture assertions");
  assert.deepEqual(outcomes.map(value => value.executionStatus), ["not_executed", "not_executed", undefined, undefined, "not_executed", undefined]);
  assert.deepEqual(finalized, ["invalid", "forged", "failed", "replayed", "script"]);
  assert.equal(outcomes[0]!.isError, true);
  assert.equal(outcomes[1]!.observationFailure?.executionIsError, true);
});

test("both native edit definitions reject empty arrays before execution but retain legacy normalization", () => {
  for (const definition of [createHarnessEditTool(), createEditToolDefinition(process.cwd())]) {
    assert.ok(definition.prepareArguments);
    assert.ok(definition.validateInput);
    const empty = definition.prepareArguments!({ path: "unused.txt", edits: [] });
    assert.deepEqual(empty, { path: "unused.txt", edits: [] });
    assert.throws(() => definition.validateInput!(empty), /edits must contain at least one replacement/);
    assert.equal(definition.prepareArguments!(null), null);
    const normalized = definition.prepareArguments!({ path: "unused.txt", edits: [], oldText: "a", newText: "b" });
    assert.deepEqual(normalized.edits, [{ oldText: "a", newText: "b" }]);
    definition.validateInput!(normalized);
  }
});

test("input validation follows final authorization and retains result hooks without executing", async () => {
  for (const denied of [false, true]) {
    const order: string[] = [];
    const outcomes: NestedToolResultMessage[] = [];
    const authorized = {};
    const child = tool("checked", async () => { order.push("execute"); return result(); });
    child.validateInput = args => { order.push("validate"); assert.equal(args, authorized); throw new Error("shape rejected"); };
    const f = fixture(async ctx => { outcomes.push(await ctx.callTool("checked", {})); }, [child]);
    f.agent.beforeToolCall = async ctx => {
      if (ctx.toolCall.name !== "checked") return;
      order.push("tool_call");
      return { finalAuthorization: {
        consume() { order.push("consume"); if (denied) throw new Error("authorization rejected"); return authorized; },
        release() { order.push("release"); },
      } };
    };
    f.agent.afterToolCall = async ctx => { if (ctx.toolCall.name === "checked") order.push("tool_result"); return undefined; };
    await f.agent.prompt("run");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.executionStatus, "not_executed");
    assert.match(JSON.stringify(outcomes[0]!.content), denied ? /authorization rejected/ : /shape rejected/);
    assert.deepEqual(order, denied ? ["tool_call", "consume", "release"] : ["tool_call", "consume", "validate", "release", "tool_result"]);
  }
});

test("model tool exposure is cached while nested-only tools remain callable", async () => {
	const child = tool("read", async () => result(), true);
	child.modelExposure = "nested";
	const f = fixture(async ctx => { assert.equal((await ctx.callTool("read", {})).isError, false); }, [child]);
	const snapshot = f.agent.state.modelTools;
	assert.deepEqual(snapshot?.map(t => t.name), ["script"]);
	assert.equal(f.agent.state.modelTools, snapshot);
	let conversionTools: AgentTool<any>[] | undefined;
	f.agent.convertToLlm = (messages, _prompt, tools) => { conversionTools = tools; return messages as never; };
	await f.agent.prompt("run");
	assert.deepEqual(conversionTools?.map(t => t.name), ["script"]);
	f.agent.state.tools = [];
	assert.notEqual(f.agent.state.modelTools, snapshot);
});

test("nested-only tools reject direct model calls", async () => {
	let invoked = 0;
	const script = tool("script", async () => { invoked++; return result(); });
	script.modelExposure = "nested";
	let request = 0;
	const agent = new Agent({ initialState: { tools: [script] }, streamFn: (_model, context) => {
		assert.deepEqual(context.tools, []);
		return new FixtureStream(request++ === 0) as never;
	} });
	await agent.prompt("run");
	assert.equal(invoked, 0);
	const outcome = agent.state.messages.find(m => m.role === "toolResult");
	assert.ok(outcome?.role === "toolResult" && outcome.isError);
	assert.match(JSON.stringify(outcome), /TOOL_NESTED_ONLY/);
});

test("nested outcomes stay failed when a result hook tries to erase the failure", async () => {
	const f = fixture(async ctx => { assert.equal((await ctx.callTool("write", {})).isError, true); },
		[tool("write", async () => ({ ...result("partially committed"), isError: true }))]);
	f.agent.afterToolCall = async () => ({ isError: false });
	await f.agent.prompt("run");
	assert.ok(f.agent.state.messages.some(m => m.role === "toolResult" && m.isError));
});

test("nested eligibility is rechecked after asynchronous policy evaluation", async () => {
	let invoked = 0;
	const child = tool("read", async () => { invoked++; return result(); }, true);
	const f = fixture(async ctx => { assert.equal((await ctx.callTool("read", {})).isError, true); }, [child]);
	f.agent.beforeToolCall = async ctx => { if (ctx.toolCall.name === "read") child.modelOnly = true; return undefined; };
	await f.agent.prompt("run");
	assert.equal(invoked, 0);
});

test("nested dispatch shares hooks and events without orphan protocol messages or a second run", async () => {
	const before: string[] = [], after: string[] = [];
	const f = fixture(async ctx => {
		const value = await ctx.callTool("read", {});
		assert.equal(value.isError, false);
		assert.equal("observationFailure" in value, false);
		assert.equal(value.toolCallId, "parent:nested:1");
	}, [tool("read", async (_id, _args, _signal, update) => {
		for (let index = 0; index < 100; index++) update?.(result("progress"));
		return result("file content");
	}, true)]);
	f.agent.beforeToolCall = async ctx => { before.push(`${ctx.toolCall.name}:${ctx.parentToolCallId ?? "root"}`); return undefined; };
	f.agent.afterToolCall = async ctx => { after.push(`${ctx.toolCall.name}:${ctx.parentToolCallId ?? "root"}`); return undefined; };
	await f.agent.prompt("run");
	assert.deepEqual(before, ["script:root", "read:parent"]);
	assert.deepEqual(after, ["read:parent", "script:root"]);
	assert.equal(f.events.filter(e => e.type === "agent_start").length, 1);
	const childEvents = f.events.filter(e => "toolCallId" in e && e.toolCallId === "parent:nested:1");
	assert.equal(childEvents.filter(e => e.type === "tool_execution_start").length, 1);
	assert.equal(childEvents.filter(e => e.type === "tool_execution_end").length, 1);
	for (const event of childEvents) assert.equal("parentToolCallId" in event && event.parentToolCallId, "parent");
	assert.equal(f.agent.state.pendingToolCalls.size, 0);
	assert.deepEqual(f.agent.state.messages.filter(m => m.role === "toolResult").map(m => m.toolName), ["script"]);
	assert.equal(f.wires.length, 2);
	assert.deepEqual(f.wires[1]!.messages.filter(m => m.role === "toolResult").map(m => m.toolName), ["script"]);
});

test("nested permission refusal remains a parent error even if the script and parent hook ignore it", async () => {
	let executions = 0;
	const f = fixture(async ctx => { assert.equal((await ctx.callTool("write", {})).isError, true); },
		[tool("write", async () => { executions++; return result(); })]);
	f.agent.beforeToolCall = async ctx => ctx.toolCall.name === "write" ? { block: true, reason: "fixture permission denied" } : undefined;
	f.agent.afterToolCall = async () => ({ isError: false });
	await f.agent.prompt("run");
	assert.equal(executions, 0);
	const parent = f.agent.state.messages.find(m => m.role === "toolResult");
	assert.ok(parent?.role === "toolResult" && parent.isError);
	assert.match(JSON.stringify(parent.content), /NESTED_TOOL_ERRORS/);
});

test("nested reads are bounded and a queued write separates read groups", async () => {
	let active = 0, maxActive = 0, writes = 0;
	const events: string[] = [];
	const read = tool("read", async () => {
		active++; maxActive = Math.max(maxActive, active); events.push("read-start");
		await nextTask(); active--; events.push("read-end"); return result();
	}, true);
	const write = tool("write", async () => { assert.equal(active, 0); writes++; events.push("write"); await nextTask(); return result(); });
	const f = fixture(async ctx => {
		await Promise.all([...Array.from({ length: 6 }, () => ctx.callTool("read", {})), ctx.callTool("write", {}), ctx.callTool("read", {})]);
	}, [read, write]);
	await f.agent.prompt("run");
	assert.equal(maxActive, 4);
	assert.equal(writes, 1);
	assert.equal(events.filter(e => e === "read-start").length, 7);
	assert.equal(events.at(-3), "write");
	assert.equal(active, 0);
});

test("tool removal or implementation replacement while awaiting policy prevents invocation", async () => {
	for (const replacement of [false, true]) {
		let executions = 0;
		const child = tool("write", async () => { executions++; return result(); });
		const f = fixture(async ctx => { assert.equal((await ctx.callTool("write", {})).isError, true); }, [child]);
		f.agent.beforeToolCall = async ctx => {
			if (ctx.parentToolCallId) {
				if (replacement) child.execute = async () => { executions++; return result(); };
				else f.agent.state.tools = f.agent.state.tools.filter(t => t !== child);
			}
			return undefined;
		};
		await f.agent.prompt("run");
		assert.equal(executions, 0);
	}
});

test("recursion, model-only controls and interaction boundaries cannot execute inside scripts", async () => {
	let executions = 0;
	const control = tool("control", async () => { executions++; return result(); }); control.modelOnly = true;
	const question = tool("question", async () => { executions++; return result(); }); question.interactionBoundary = true;
	const f = fixture(async ctx => {
		for (const name of ["script", "control", "question", "missing"]) assert.equal((await ctx.callTool(name, {})).isError, true);
	}, [control, question]);
	await f.agent.prompt("run");
	assert.equal(executions, 0);
});

test("unawaited child is cancelled and settled before the parent finishes; escaped context is retired", async () => {
	let escaped: AgentToolExecutionContext | undefined;
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	let cancelled = false;
	const child = tool("read", async (_id, _args, signal) => {
		started();
		await new Promise<void>(resolve => signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
		return { ...result("cancelled"), isError: true };
	}, true);
	const f = fixture(async ctx => { escaped = ctx; void ctx.callTool("read", {}); await ready; }, [child]);
	await f.agent.prompt("run");
	assert.equal(cancelled, true);
	assert.deepEqual(escaped!.getTools(), []);
	await assert.rejects(escaped!.callTool("read", {}), /closed/);
	assert.equal(f.agent.state.pendingToolCalls.size, 0);
	const ends = f.events.filter(e => e.type === "tool_execution_end");
	assert.deepEqual(ends.map(e => e.toolCallId), ["parent:nested:1", "parent"]);
});

test("nested argument validation and the aggregate call limit remain enforced", async () => {
	let executions = 0;
	const child = tool("write", async () => { executions++; return result(); });
	const f = fixture(async ctx => {
		assert.equal((await ctx.callTool("write", { extra: true })).isError, true);
		for (let index = 0; index < 255; index++) await ctx.callTool("write", {});
		await assert.rejects(ctx.callTool("write", {}), /256-call limit/);
	}, [child]);
	await f.agent.prompt("run");
	assert.equal(executions, 255);
});

for (const mixed of [false, true]) test(`nested stop requests retain the existing all-results rule, mixed=${mixed}`, async () => {
	const f = fixture(async ctx => { await ctx.callTool("stop", {}); if (mixed) await ctx.callTool("continue", {}); }, [
		tool("stop", async () => ({ ...result(), terminate: true })), tool("continue", async () => result()),
	]);
	await f.agent.prompt("run");
	assert.equal(f.wires.length, mixed ? 2 : 1);
	assert.equal(f.agent.state.pendingToolCalls.size, 0);
});

for (const field of ["access", "executionMode"] as const) test(`concurrent read eligibility cannot change while awaiting policy: ${field}`, async () => {
	let executed = 0;
	const child = tool("read", async () => { executed++; return result(); }, true);
	const f = fixture(async ctx => { assert.equal((await ctx.callTool("read", {})).isError, true); }, [child]);
	f.agent.beforeToolCall = async ctx => {
		if (ctx.toolCall.name === "read") {
			await nextTask();
			if (field === "access") child.executionPath!.access = "write";
			else child.executionMode = "sequential";
		}
		return undefined;
	};
	await f.agent.prompt("run");
	assert.equal(executed, 0);
});

test("a completed nested child keeps its result when execution end delivery fails", async () => {
	let executions = 0;
	let observed: Awaited<ReturnType<AgentToolExecutionContext["callTool"]>> | undefined;
	const f = fixture(async ctx => { observed = await ctx.callTool("write", {}); },
		[tool("write", async () => { executions++; return { ...result("written"), details: { receipt: "r1" } }; })]);
	f.agent.subscribe(event => {
		if (event.type === "tool_execution_end" && event.toolCallId === "parent:nested:1") throw new Error("fixture end failure");
	});
	await f.agent.prompt("run");
	assert.equal(executions, 1);
	assert.equal(observed?.isError, true);
	const content = observed?.content as Array<{ type: string; text?: string }>;
	assert.match(content[0]?.text ?? "", /^\[TOOL_OBSERVATION_FAILED\] .*fixture end failure/);
	assert.equal(content[1]?.text, "written");
	assert.equal((observed?.details as { receipt?: string } | undefined)?.receipt, "r1");
	assert.equal(observed?.observationFailure?.executionIsError, false, "the tool's own outcome stays separate");
	assert.equal(observed?.observationFailure?.error, content[0]?.text);
});

test("next-turn tool replacement rebuilds model declarations carried by a spread context", async () => {
	const script = tool("script", async () => result());
	const added = tool("added", async () => result());
	const declared: string[][] = [];
	let request = 0;
	const agent = new Agent({ initialState: { tools: [script] }, streamFn: (_model, context) => {
		declared.push((context.tools ?? []).map(t => t.name));
		return new FixtureStream(request++ === 0) as never;
	} });
	agent.prepareNextTurnWithContext = async ({ context }) => ({ context: { ...context, tools: [...context.tools!, added] } });
	await agent.prompt("run");
	assert.deepEqual(declared, [["script"], ["script", "added"]]);
});

test("model declarations follow next-turn spread replacement and in-place state mutation with nested tools present", async () => {
	const script = tool("script", async () => result());
	const hidden = tool("hidden", async () => result());
	hidden.modelExposure = "nested";
	const added = tool("added", async () => result());
	const later = tool("later", async () => result());
	const declared: string[][] = [];
	let request = 0;
	const agent = new Agent({ initialState: { tools: [script, hidden] }, streamFn: (_model, context) => {
		declared.push((context.tools ?? []).map(t => t.name));
		return new FixtureStream(request++ === 0) as never;
	} });
	// A nested tool makes the cached projection a separate array, so a spread context carries a stale one.
	agent.prepareNextTurnWithContext = async ({ context }) => ({ context: { ...context, tools: [...context.tools!, added] } });
	await agent.prompt("run");
	assert.deepEqual(declared, [["script"], ["script", "added"]]);
	// The state contract allows mutating the returned array in place.
	agent.prepareNextTurnWithContext = undefined;
	agent.state.tools.push(later);
	assert.deepEqual(agent.state.modelTools?.map(t => t.name), ["script", "later"]);
	agent.state.tools.splice(0, 1);
	assert.deepEqual(agent.state.modelTools?.map(t => t.name), ["later"]);
	const cached = agent.state.modelTools;
	assert.equal(agent.state.modelTools, cached, "an unchanged projection keeps its identity");
	request = 0;
	await agent.prompt("again");
	assert.deepEqual(declared.at(-2), ["later"]);
});

test("a child that ignores cancellation is abandoned after the grace period instead of wedging close", async () => {
	let aborted = false, settle!: () => void;
	const late = new Promise<void>(resolve => { settle = resolve; });
	const dispatch = new NestedToolDispatch("parent", () => [tool("hang", async () => result())],
		async (call, _tool, signal) => {
			signal.addEventListener("abort", () => { aborted = true; }, { once: true });
			await late; // ignores the abort signal
			return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [], isError: false, timestamp: 0 } as never;
		}, undefined, 30);
	const call = dispatch.callTool("hang", {});
	const started = Date.now();
	assert.equal(await dispatch.finish(), true);
	assert.ok(Date.now() - started < 2000);
	assert.equal(aborted, true);
	assert.equal(dispatch.abandonedCalls, 1);
	await assert.rejects(call, /ignored cancellation for 30 ms/);
	await dispatch.close(); // a later close never waits on the abandoned child again
	settle();
	await nextTask();
	assert.equal(dispatch.abandonedCalls, 1);
});

test("a queued nested call to a tool removed in place from agent state is refused", async () => {
	let victimRuns = 0, agent!: Agent;
	const victim = tool("victim", async () => { victimRuns++; return result("victim ran"); });
	const first = tool("first", async () => {
		// The supported state contract allows in-place mutation; the array identity stays the same.
		agent.state.tools.splice(agent.state.tools.indexOf(victim), 1);
		return result();
	});
	let outcomes: boolean[] = [];
	const f = fixture(async ctx => {
		// "first" is a write, so "victim" queues behind it and resolves only after the removal.
		const calls = [ctx.callTool("first", {}), ctx.callTool("victim", {})];
		outcomes = (await Promise.all(calls)).map(message => message.isError);
	}, [first, victim]);
	agent = f.agent;
	await f.agent.prompt("run");
	assert.deepEqual(outcomes, [false, true]);
	assert.equal(victimRuns, 0);
});

test("an orchestrator that throws still reports a child that ignored cancellation", async () => {
	let started!: () => void, settle!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const late = new Promise<void>(resolve => { settle = resolve; });
	const child = tool("hang", async () => { started(); await late; return result(); }); // ignores the abort signal
	const f = fixture(async ctx => {
		ctx.callTool("hang", {}).catch(() => undefined);
		await ready;
		throw new Error("parent failed after starting a child");
	}, [child]);
	try {
		await f.agent.prompt("run");
		const parent = f.agent.state.messages.find(m => m.role === "toolResult" && m.toolCallId === "parent");
		assert.ok(parent?.role === "toolResult" && parent.isError);
		const text = JSON.stringify(parent.content);
		assert.match(text, /parent failed after starting a child/);
		assert.match(text, /NESTED_TOOL_ABANDONED\] 1 child call/);
	} finally { settle(); }
});

class CallStream {
	private message: AssistantMessage;
	constructor(name: string | undefined, id: string) {
		this.message = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
			content: name ? [{ type: "toolCall", id, name, arguments: {} }] : [{ type: "text", text: "done" }],
			stopReason: name ? "toolUse" : "stop", timestamp: 1 };
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		yield { type: "done", reason: this.message.stopReason as "toolUse" | "stop", message: this.message };
	}
	async result() { return this.message; }
}

test("nested authorization follows a next-turn tool replacement that leaves agent state untouched", async () => {
	let victimRuns = 0, addedRuns = 0, lateRuns = 0, agent!: Agent;
	const victim = tool("victim", async () => { victimRuns++; return result(); });
	const added = tool("added", async () => { addedRuns++; return result(); });
	const late = tool("late", async () => { lateRuns++; return result(); });
	const warmup = tool("warmup", async () => result());
	let outcomes: boolean[] = [];
	const script: AgentTool<any> = { name: "script", label: "Script", description: "fixture", parameters: PARAMETERS,
		orchestration: true, async execute(_id, _args, _signal, _update, context) {
			outcomes.push((await context!.callTool("victim", {})).isError, (await context!.callTool("added", {})).isError);
			agent.state.tools.push(late); // a live activation made during the script still applies
			outcomes.push((await context!.callTool("late", {})).isError);
			// A registry refresh re-wraps every live tool without changing which names are active.
			agent.state.tools = agent.state.tools.map(tool => ({ ...tool }));
			outcomes.push((await context!.callTool("victim", {})).isError, (await context!.callTool("added", {})).isError,
				(await context!.callTool("late", {})).isError);
			return result("script completed");
		} };
	const calls = ["warmup", "script"];
	let request = 0;
	agent = new Agent({ initialState: { tools: [warmup, script, victim] },
		streamFn: () => new CallStream(calls[request], `call-${request++}`) as never });
	// The host replaces the turn's tools without mutating agent.state.tools.
	agent.prepareNextTurnWithContext = async ({ context }) => ({ context: { ...context, tools: [warmup, script, added] } });
	await agent.prompt("run");
	assert.deepEqual(outcomes, [true, false, false, true, false, false]);
	assert.deepEqual([victimRuns, addedRuns, lateRuns], [0, 2, 2]);
});
