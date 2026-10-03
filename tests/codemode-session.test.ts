import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { createAgentSession, type CreateAgentSessionOptions } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage, Context } from "../packages/ai/src/types.ts";
import type { InlineExtension, ExtensionFactory } from "../packages/coding-agent/src/core/extensions/types.ts";
import { CODEMODE_STORE_ENTRY } from "../packages/coding-agent/src/core/codemode-constants.ts";
import { CodemodeStore } from "../packages/coding-agent/src/core/codemode-store.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { CODEMODE_RESULT_ENTRY } from "../packages/coding-agent/src/core/codemode-constants.ts";
import { convertResponsesTools } from "../packages/ai/src/api/openai-responses-shared.ts";
import { CODEMODE_PARAMETERS, CODEMODE_SAMPLING } from "../packages/coding-agent/src/core/codemode-constants.ts";
// @ts-expect-error JavaScript bridge
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<{ default: InlineExtension }>("../packages/extensions/mutation-guard-write/index.ts");
const { collectChanges } = await jiti.import<typeof import("../packages/extensions/mutation-guard-write/changes.ts")>("../packages/extensions/mutation-guard-write/changes.ts");
const { default: planMode } = await jiti.import<{ default: ExtensionFactory }>("../packages/plan-mode/src/index.ts");
const MODEL = { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as const;
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t: TestContext, options: Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludeTools" | "toolResultPresentation" | "extensionRunnerOptions"> = {}, factories: InlineExtension[] = [], bundle = false, persist = false) {
	const root = mkdtempSync(join(tmpdir(), "sp-codemode-session-"));
	const cwd = join(root, "work"), agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(cwd, "file.txt"), "hello\nworld\n");
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, ...(bundle ? { packages: [resolve("packages/extensions")] } : {}) });
	const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: !bundle,
		noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: factories });
	await resources.reload();
	assert.deepEqual(resources.getExtensions().errors, []);
	if (bundle) assert.equal(resources.getExtensions().extensions.length, 9 + factories.length);
	const manager = persist ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: resources, settingsManager: settings, sessionManager: manager,
		model: { ...MODEL, input: ["text"] }, modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
			isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as never, ...options });
	await session.bindExtensions({});
	t.after(async () => { session.agent.abort(); await session.agent.waitForIdle(); session.dispose(); rmSync(root, { recursive: true, force: true }); });
	let id = 0;
	// An array entry is one assistant response carrying several Codemode calls.
	async function run(scripts: (string | string[])[], project?: (context: Context) => void, rawCode = false) {
		const wires: Context[] = [];
		let index = 0;
		session.agent.streamFunction = (_model, context) => {
			wires.push(context); project?.(context);
			const code = scripts[index++];
			const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", usage: USAGE,
				content: code === undefined ? [{ type: "text", text: "done" }] : (typeof code === "string" ? [code] : code).map(source =>
					({ type: "toolCall" as const, id: `script-${++id}`, name: "codemode", arguments: (rawCode ? source : { code: source }) as never })),
				stopReason: code === undefined ? "stop" : "toolUse", timestamp: id };
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			return stream;
		};
		await session.agent.prompt("run offline fixture");
		return { wires, results: session.agent.state.messages.filter(m => m.role === "toolResult") };
	}
	return { session, cwd, manager, run };
}

test("SDK defaults to Codemode declarations and native control tools, retaining callable tools", async t => {
	const f = await fixture(t);
	(f.session as any)._providerRequestPayloadBuilder = (input: any) => ({ tools: input.tools.map((tool: any) => tool.name) });
	const preview = await f.session.buildProviderRequestPayload({ messages: [], systemPrompt: "fixture" });
	assert.deepEqual((preview?.tools as string[]).sort(), ["ask_user", "codemode"], "provider compaction/preview uses the model-facing catalog too");
	assert.ok(f.session.getActiveToolNames().includes("read"));
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"}); await show(r.ref);']);
	assert.deepEqual(outcome.wires[0]!.tools?.map(tool => tool.name).sort(), ["ask_user", "codemode"]);
	const prompt = outcome.wires[0]!.systemPrompt!;
	const toolsSection = prompt.slice(prompt.indexOf("Available tools:"), prompt.indexOf("Guidelines:"));
	assert.match(toolsSection, /- codemode:/);
	assert.doesNotMatch(toolsSection, /- (read|bash|powershell|edit|write):/);
	assert.match(prompt, /For read inside codemode:/);
	assert.match(prompt, /for file operations/, "shell guidance counts Codemode children as callable tools");
	assert.equal(outcome.results[0]?.isError, false);
	assert.match(JSON.stringify(outcome.results[0]?.content), /hello/);
	assert.deepEqual(outcome.results.map(r => r.toolName), ["codemode"]);
});

test("default extension bundle allows sequential verification after an authorized edit", async t => {
	const f = await fixture(t, {}, [], true);
	const outcome = await f.run([
		'const r=await tools.read({path:"file.txt"});await show(r.ref)',
		'await tools.read({path:"file.txt"});await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]});const r=await tools.read({path:"file.txt"});await show(r.ref)',
	]);
	assert.ok(outcome.results.every(r => !r.isError), JSON.stringify(outcome.results));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "changed\nworld\n");
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /changed/);
});

test("default extension bundle still requires a completed prior visible read", async t => {
	const f = await fixture(t, {}, [], true);
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"});await show(r.ref);await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]), /READ_REQUIRED/);
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("SDK allowlist constrains children while adding the default transport; no-tools stays empty", async t => {
	const f = await fixture(t, { tools: ["read"] });
	assert.deepEqual(f.session.getActiveToolNames().sort(), ["codemode", "read"]);
	const outcome = await f.run(['try { await callTool("write",{path:"forbidden.txt",content:"bad"}); } catch {} text("success")']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.deepEqual(outcome.wires[0]!.tools?.map(tool => tool.name), ["codemode"]);
	const empty = await fixture(t, { noTools: "all" });
	assert.deepEqual(empty.session.getActiveToolNames(), []);
	assert.deepEqual(empty.session.agent.state.modelTools, []);
});

test("successful state writes persist as a versioned branch entry; failed script writes do not", async t => {
	const f = await fixture(t, { tools: ["read"] });
	const outcome = await f.run(['store("n",3)', 'store("n",4); throw new Error("fail")', 'text(load("n"))']);
	assert.equal(outcome.results[0]?.isError, false);
	assert.equal(outcome.results[1]?.isError, true);
	assert.match(JSON.stringify(outcome.results[2]?.content), /3/);
	const saved = f.manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY);
	assert.equal(saved.length, 1);
});

for (const [label, code, allowed] of [
	["shown native read", 'const r=await tools.read({path:"file.txt"}); await show(r.ref)', true],
	["hidden native read", 'await tools.read({path:"file.txt"})', false],
	["printed copy", 'const r=await tools.read({path:"file.txt"}); text(r.content)', false],
	["forged reference", 'try { await show("forged") } catch {}', false],
] as const) {
	test(`mutation evidence: ${label}`, async t => {
		const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
		const outcome = await f.run([code, 'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]})']);
		assert.equal(outcome.results[1]?.isError, !allowed, JSON.stringify(outcome.results));
		if (!allowed) assert.match(JSON.stringify(outcome.results[1]), /READ_REQUIRED/);
		assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), allowed ? "changed\nworld\n" : "hello\nworld\n");
	});
}

test("same-script shown read cannot authorize an edit", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	const outcome = await f.run(['const r=await tools.read({path:"file.txt"});await show(r.ref);await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]), /READ_REQUIRED/);
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "hello\nworld\n");
});

test("tool discovery changes are callable within the same script through the current catalog", async t => {
	const extra: InlineExtension = pi => {
		pi.registerTool({ name: "activate", label: "activate", description: "fixture", parameters: Type.Object({}), execute: async () => {
			pi.setActiveTools([...pi.getActiveTools(), "conditional"]); return { content: [], details: {} };
		} });
		pi.registerTool({ name: "conditional", label: "conditional", description: "fixture", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "activated" }], details: {} }) });
	};
	const f = await fixture(t, {}, [extra]);
	f.session.setActiveToolsByName(["activate"]);
	const outcome = await f.run(['await tools.activate({}); const r=await callTool("conditional",{}); text(r.content)']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.match(JSON.stringify(outcome.results[0]?.content), /activated/);
});

test("Codemode store ownership isolates branches and preserves prototype keys", () => {
	const store = new CodemodeStore();
	store.restore(JSON.parse('{"__proto__":{"v":1},"a":2}'));
	const first = store.snapshot;
	store.apply({ set: { a: 3 }, delete: [] });
	assert.equal(first.a, 2);
	assert.equal(store.snapshot.a, 3);
	assert.deepEqual(store.snapshot.__proto__, { v: 1 });
	store.restore(first);
	assert.equal(store.snapshot.a, 2);
	store.reset();
	assert.equal(Object.keys(store.snapshot).length, 0);
});

test("numeric store values survive host commit, reload and VM transfer", async t => {
	const f = await fixture(t);
	let outcome = await f.run(['store("numbers",Array(20000).fill(0))']);
	assert.equal(outcome.results[0]?.isError, false);
	await f.session.reload();
	outcome = await f.run(['text(load("numbers").length)']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /20000/);
});

test("invalid saved store reports an explicit failure before executing tools", async t => {
	const f = await fixture(t);
	f.manager.appendCustomEntry(CODEMODE_STORE_ENTRY, { version: 1, values: { oversized: "x".repeat(262145) } });
	await f.session.reload();
	const outcome = await f.run(['await tools.read({path:"file.txt"})', 'text(load("oversized")===undefined)']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]?.content), /STORE_RESTORE_FAILED.*No tools were executed/);
	assert.equal(outcome.results[1]?.isError, false);
});

for (const truncated of [false, true]) test(`store persistence failure removes ${truncated ? "truncated" : "full"} OK summary and preserves previous snapshot`, async t => {
	const f = await fixture(t);
	await f.run(['store("n",7)']);
	const original = f.manager.appendCustomEntry.bind(f.manager);
	f.manager.appendCustomEntry = (kind, data) => { if (kind === CODEMODE_STORE_ENTRY) throw new Error("fixture storage failure"); return original(kind, data); };
	const code = truncated ? '// @options: {"max_output_tokens":256}\nfor(let i=0;i<96;i++) await tools.read({path:"file.txt"}); store("n",9)' : 'store("n",9)';
	const outcome = await f.run([code, 'text(load("n"))']);
	const failed = outcome.results.at(-2)!;
	assert.equal(failed.isError, true);
	assert.doesNotMatch(JSON.stringify(failed.content), /CODEMODE_OK/);
	assert.match(JSON.stringify(failed.content), /CODEMODE_FAILED.*storage failure/);
	if (truncated) assert.match(JSON.stringify(failed.content), /Codemode output truncated/);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"7"/);
});

test("mutation result serialization failure records the completed outcome without replay", async t => {
	let writes = 0;
	const large: InlineExtension = pi => pi.registerTool({ name: "write", label: "fixture write", description: "fixture", parameters: Type.Object({}),
		execute: async () => { writes++; return { content: [], details: { huge: "x".repeat(1024 * 1024 + 1) } }; } });
	const f = await fixture(t, {}, [large]);
	const outcome = await f.run(['await tools.write({})']);
	assert.equal(writes, 1);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[0]?.content), /RESULT_PROCESSING_FAILED/);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_RESULT_ENTRY);
	assert.equal(saved.length, 1);
	const result = (saved[0] as any).data.result;
	assert.equal(result.isError, false, "preserve actual child outcome separately from result processing failure");
	assert.equal(result.details.requiresVerification, true);
	assert.match(result.details.codemodeResultError, /limit/);
});

test("a completed write stays recoverable in /changes when its end event times out", async t => {
	const stalled: InlineExtension = pi => { pi.on("tool_execution_end", async event => { if (event.toolName === "write") await new Promise(() => {}); }); };
	const f = await fixture(t, { tools: ["read", "write"], extensionRunnerOptions: { hookTimeouts: { lifecycle: { timeoutMs: 20, onTimeout: "fail-closed" } } } },
		[mutation, stalled], false, true);
	const outcome = await f.run(['await tools.write({path:"new.txt",content:"created\\n"})']);
	assert.equal(readFileSync(join(f.cwd, "new.txt"), "utf8"), "created\n");
	assert.equal(outcome.results[0]?.isError, true, "the parent still reports the observation failure");
	assert.match(JSON.stringify(outcome.results[0]?.content), /Child calls: 1[\s\S]*TOOL_OBSERVATION_FAILED/);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_RESULT_ENTRY);
	assert.equal(saved.length, 1);
	assert.equal((saved[0] as any).data.result.isError, false, "the persisted receipt keeps the tool's own outcome");
	assert.match((saved[0] as any).data.observationError, /tool_execution_end.*timed out after 20ms/);
	const sha256 = createHash("sha256").update("created\n").digest("hex");
	for (const branch of [f.manager.getBranch(), SessionManager.open(f.manager.getSessionFile()!).getBranch()]) {
		const changes = collectChanges(branch, f.cwd);
		assert.equal(changes.length, 1, JSON.stringify(changes));
		assert.equal(changes[0]!.operation, "write");
		assert.equal(changes[0]!.status, "succeeded");
		assert.equal(changes[0]!.receipt?.sha256, sha256, "the receipt matches the file's current state");
	}
});

test("Codemode store checkpoint waits for final result hooks", async t => {
	const reject: InlineExtension = pi => { pi.on("tool_result", event => event.toolName === "codemode" && event.toolCallId === "script-1" ? { isError: true } : undefined); };
	const f = await fixture(t, {}, [reject]);
	const outcome = await f.run(['store("n",99)', 'text(load("n") === undefined)']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.match(JSON.stringify(outcome.results[1]?.content), /true/);
	assert.doesNotMatch(JSON.stringify(outcome.results[0]?.content), /CODEMODE_OK/);
	assert.equal(f.manager.getBranch().filter(e => e.type === "custom" && e.customType === CODEMODE_STORE_ENTRY).length, 0);
});

test("Codemode state restores after resource reload and navigation to an earlier branch", async t => {
	const f = await fixture(t);
	await f.run(['store("n",1)']);
	const first = f.manager.getLeafId()!;
	await f.run(['store("n",2)']);
	await f.session.reload();
	let outcome = await f.run(['text(load("n"))']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"2"/);
	await f.session.navigateTree(first);
	outcome = await f.run(['text(load("n"))']);
	assert.match(JSON.stringify(outcome.results.at(-1)?.content), /"text":"1"/);
});

test("actual Plan mode retains Codemode with read-only child authorization", async t => {
	const planning: InlineExtension = pi => planMode({ ...pi, getFlag: name => name === "plan" ? true : pi.getFlag(name) });
	const f = await fixture(t, {}, [planning]);
	const names = f.session.agent.state.modelTools!.map(tool => tool.name);
	assert.ok(names.includes("codemode"));
	assert.ok(names.includes("plan_mode_complete"));
	assert.equal(f.session.getActiveToolNames().includes("write"), false);
	const outcome = await f.run(['text((await tools.read({path:"file.txt"})).content)', 'try { await callTool("write",{path:"bad",content:"bad"}) } catch {}']);
	assert.equal(outcome.results[0]?.isError, false);
	assert.equal(outcome.results[1]?.isError, true);
});

test("Goal/interaction controls remain model-only and cannot be called through a script", async t => {
	const controls: InlineExtension = pi => {
		for (const name of ["goal_complete", "goal_blocked", "plan_mode_question"]) pi.registerTool({ name, label: name, description: "control fixture", parameters: Type.Object({}), execute: async () => { throw new Error("control was invoked indirectly"); } });
	};
	const f = await fixture(t, {}, [controls]);
	const names = f.session.agent.state.modelTools!.map(tool => tool.name);
	for (const name of ["goal_complete", "goal_blocked", "plan_mode_question"]) assert.ok(names.includes(name));
	const outcome = await f.run(['try { await callTool("goal_complete",{}) } catch {}']);
	assert.equal(outcome.results[0]?.isError, true);
	assert.doesNotMatch(JSON.stringify(outcome.results[0]?.content), /control was invoked indirectly/);
});

test("real MCP adapter discovery executes in Codemode and ignores self-reported read concurrency", async t => {
	let runtime: any, active = 0, maximum = 0, calls = 0;
	const extension: InlineExtension = pi => {
		runtime = new McpBridgeRuntime(pi, "fixture");
		const state = { status: "connected", config: { id: "fixture", toolTimeoutMs: 1000 }, client: {
			async callTool() { calls++; maximum = Math.max(maximum, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return { content: [{ type: "text", text: "native MCP result" }] }; }, async close() {} } };
		runtime.registerRemoteTool(state, { name: "lookup", description: "lookup", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } });
		pi.registerTool({ name: "mcp_search_tools", label: "search", description: "discovery fixture", parameters: Type.Object({}), execute: async () => {
			pi.setActiveTools([...pi.getActiveTools(), ...runtime.searchTools("lookup")]); return { content: [], details: {} };
		} });
		pi.on("session_shutdown", async () => { await runtime.close(); });
	};
	const f = await fixture(t, { toolResultPresentation: { enabled: true, budgetTokens: 8000 } }, [extension]);
	t.after(() => runtime.close());
	f.session.setActiveToolsByName(["mcp_search_tools"]);
	const outcome = await f.run(['await tools.mcp_search_tools({}); const r=await Promise.all([callTool("mcp__fixture__lookup",{}),callTool("mcp__fixture__lookup",{})]);text(r[0].content);']);
	assert.equal(outcome.results[0]?.isError, false, JSON.stringify(outcome.results));
	assert.equal(calls, 2); assert.equal(maximum, 1);
	assert.match(JSON.stringify(outcome.results[0]?.content), /native MCP result/);
	assert.equal(runtime.activeCalls.size, 0);
});

test("mandatory Codemode rejects exclusion before creating resources", async () => {
	await assert.rejects(createAgentSession({ excludeTools: ["codemode"] }), /required default tool transport/);
});

test("MCP activation keeps inline declarations stable; overflow remains explicitly discoverable", async () => {
	const owner = new CodemodeController(() => {});
	let schemaVisits = 0;
	const schema = Type.Object({});
	Object.defineProperty(schema, "properties", { get() { schemaVisits++; return {}; } });
	const local = { name: "local", label: "local", description: "local", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) };
	try {
		owner.setTools([local]);
		const description = owner.definition.description;
		owner.setTools([local, { ...local, name: "mcp__fixture__remote", parameters: schema }]);
		assert.equal(owner.definition.description, description);
		assert.equal(schemaVisits, 0, "deferred remote schemas are not rendered just to omit them");
		const largeSchema = Type.Object({ value: Type.Union(Array.from({ length: 70 }, (_, index) => Type.Literal(`long_literal_${index}`))) });
		owner.setTools(Array.from({ length: 100 }, (_, index) => ({ ...local, name: `tool_${index}`, parameters: largeSchema })));
		assert.ok(owner.definition.description.length < 32768);
		assert.match(owner.definition.description, /\d+ local declarations omitted.*ALL_TOOLS/);
	} finally { await owner.close(); }
});

test("grammar and JSON models use the same Codemode runtime", async t => {
	const definition = { name: "codemode", description: "execute", parameters: CODEMODE_PARAMETERS, constrainedSampling: CODEMODE_SAMPLING };
	assert.equal(convertResponsesTools([definition], { supportsOpenAIGrammarTools: true })[0]?.type, "custom");
	assert.equal(convertResponsesTools([definition], { supportsOpenAIGrammarTools: false })[0]?.type, "function");
	const f = await fixture(t, { tools: ["read"] });
	const result = await f.run(['text((await tools.read({path:"file.txt"})).content)'], undefined, true);
	assert.equal(result.results[0]?.isError, false);
});

for (const boundary of ["truncated", "changed-file", "context-filter", "payload-unproven"] as const) test(`read evidence rejects ${boundary}`, async t => {
	const filter: InlineExtension = pi => pi.on("context", event => ({ messages: event.messages.filter(m => m.role !== "toolResult") }));
	const f = await fixture(t, { tools: ["read", "edit"] }, boundary === "context-filter" ? [mutation, filter] : [mutation]);
	if (boundary === "truncated") writeFileSync(join(f.cwd, "file.txt"), "hello\n" + "visible-data\n".repeat(500));
	let requests = 0;
	const outcome = await f.run([
		(boundary === "truncated" ? '// @options: {"max_output_tokens":256}\n' : '') + 'await show((await tools.read({path:"file.txt"})).ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})',
	], () => {
		if (++requests !== 2) return;
		if (boundary === "changed-file") writeFileSync(join(f.cwd, "file.txt"), "hello\nchanged externally\n");
		if (boundary === "payload-unproven") f.session.discardPendingToolResultBudgetSources();
	});
	assert.equal(outcome.results[1]?.isError, true, JSON.stringify(outcome.results));
	assert.ok(readFileSync(join(f.cwd, "file.txt"), "utf8").startsWith("hello\n"));
});

test("read evidence needs the shown block at its own position, not an equal copy elsewhere", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	writeFileSync(join(f.cwd, "file.txt"), "hello\n" + "visible-data\n".repeat(300));
	const outcome = await f.run([
		'// @options: {"max_output_tokens":1800}\nconst r=await tools.read({path:"file.txt"}); text(r.content[0].text); await show(r.ref)',
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"bad"}]})',
	]);
	const parent = outcome.results[0]!.content as Array<{ type: string; text: string }>;
	// Precondition: the printed copy survives intact while the native shown block is truncated.
	assert.ok(parent[2]!.text.length < parent[1]!.text.length && parent[1]!.text.startsWith(parent[2]!.text), JSON.stringify(parent.map(b => b.text.length)));
	assert.match(parent.at(-1)!.text, /Codemode output truncated/);
	assert.equal(outcome.results[1]?.isError, true, JSON.stringify(outcome.results[1]));
	assert.match(JSON.stringify(outcome.results[1]), /READ_REQUIRED/);
	assert.ok(readFileSync(join(f.cwd, "file.txt"), "utf8").startsWith("hello\n"));
});

test("shown reads from every Codemode call in one assistant batch stay admissible", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	const outcome = await f.run([
		['await show((await tools.read({path:"file.txt"})).ref)', 'text("second call in the same batch")'],
		'await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"changed"}]})',
	]);
	assert.equal(outcome.results.length, 3);
	assert.equal(outcome.results[2]?.isError, false, JSON.stringify(outcome.results[2]));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "changed\nworld\n");
});

for (const tampered of [false, true]) test(`an admitted Codemode read ${tampered ? "with a tampered receipt is not" : "is"} restored after reload`, async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	await f.run(['await show((await tools.read({path:"file.txt"})).ref)', 'text("admits the displayed read")']);
	const saved = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === "codemode-read-evidence-v1") as any[];
	assert.equal(saved.length, 1);
	// The producer binding names the original nested call; a receipt re-pointed elsewhere must fail closed.
	if (tampered) saved[0].data.toolCallId = `${saved[0].data.parentToolCallId}:nested:99`;
	// Reload emits session_start only for a bound host, as in interactive and RPC modes.
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"edited"}]})']);
	assert.equal(outcome.results.at(-1)?.isError, tampered, JSON.stringify(outcome.results.at(-1)));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), tampered ? "hello\nworld\n" : "edited\nworld\n");
});

test("a nested tool that ignores cancellation cannot wedge Codemode past its deadline", async t => {
	const hang: InlineExtension = pi => pi.registerTool({ name: "hang", label: "hang", description: "ignores abort", parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}) });
	const f = await fixture(t, {}, [hang]);
	const started = Date.now();
	const outcome = await f.run(['// @options: {"timeout_ms":200}\nawait tools.hang({})']);
	assert.ok(Date.now() - started < 15_000, "bounded by the timeout plus the cancellation grace period");
	const parent = outcome.results[0]!;
	assert.equal(parent.isError, true);
	assert.match(JSON.stringify(parent.content), /CODEMODE_TIMEOUT/);
	assert.match(JSON.stringify(parent.content), /NESTED_TOOL_ABANDONED\] 1 child call/);
});

test("colliding tool names get distinct declared identifiers that scripts and describeTools accept", async t => {
	const tools: InlineExtension = pi => {
		for (const name of ["foo-bar", "foo_bar"]) pi.registerTool({ name, label: name, description: `fixture ${name}`, parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: `ran ${name}` }], details: {} }) });
	};
	const f = await fixture(t, {}, [tools]);
	const outcome = await f.run(['text(await describeTools(["foo_bar_2"])); text((await tools.foo_bar_2({})).content[0].text); text((await tools.foo_bar({})).content[0].text)']);
	const declared = outcome.wires[0]!.tools!.find(tool => tool.name === "codemode")!.description;
	assert.match(declared, /\nfoo_bar\(args/);
	assert.match(declared, /\nfoo_bar_2\(args/);
	const text = JSON.stringify(outcome.results[0]?.content);
	assert.equal(outcome.results[0]?.isError, false, text);
	assert.match(text, /fixture foo-bar/);
	assert.match(text, /ran foo-bar/);
	assert.match(text, /ran foo_bar/);
});

test("a shown read answered by a final text response is persisted before reload", async t => {
	const f = await fixture(t, { tools: ["read", "edit"] }, [mutation]);
	// The run ends with the model's text answer; no later tool call admits the read.
	await f.run(['await show((await tools.read({path:"file.txt"})).ref)']);
	assert.equal(f.manager.getBranch().filter(e => e.type === "custom" && e.customType === "codemode-read-evidence-v1").length, 1);
	// Reload emits session_start only for a bound host, as in interactive and RPC modes.
	const errors: unknown[] = [];
	await f.session.bindExtensions({ onError: error => errors.push(error) });
	await f.session.reload();
	assert.deepEqual(errors, []);
	const outcome = await f.run(['await tools.edit({path:"file.txt",edits:[{oldText:"hello",newText:"edited"}]})']);
	assert.equal(outcome.results.at(-1)?.isError, false, JSON.stringify(outcome.results.at(-1)));
	assert.equal(readFileSync(join(f.cwd, "file.txt"), "utf8"), "edited\nworld\n");
});
