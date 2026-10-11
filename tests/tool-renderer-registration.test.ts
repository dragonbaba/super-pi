import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Text, type Component, type TUI } from "@super-pi/tui";
import type { AssistantMessage } from "@super-pi/ai";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../packages/coding-agent/src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionFactory, ToolRendererResolver, ToolRenderers } from "../packages/coding-agent/src/core/extensions/types.ts";
import type { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createToolHtmlRenderer } from "../packages/coding-agent/src/core/export-html/tool-renderer.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { ToolExecutionComponent, ReadToolGroupComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { initTheme, theme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

async function runnerFixture(t: TestContext, ...factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const extensions = [];
	for (const factory of factories) extensions.push(await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime));
	const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), {} as ModelRegistry);
	t.after(() => runner.invalidate());
	return { runner, extensions, runtime };
}

function renderers(label: string): ToolRenderers {
	return { renderCallStability: "args-only", renderShell: "self",
		renderCall(_args, _theme, ctx) {
			const component = ctx.lastComponent as Text | undefined ?? new Text("", 0, 0);
			component.setText(`call:${label}`); return component;
		},
		renderResult(result, options, _theme, ctx) {
			const component = ctx.lastComponent as Text | undefined ?? new Text("", 0, 0);
			component.setText(`${options.expanded ? "expanded" : "result"}:${label}:${result.content[0]?.type === "text" ? result.content[0].text : ""}`);
			return component;
		} };
}

test("renderer resolvers preserve order, repeated next and nested resolution without execution registration", async t => {
	const calls: string[] = [], base = renderers("base"), missing = renderers("missing");
	let runner!: ExtensionRunner, api!: ExtensionAPI, refreshes = 0;
	const f = await runnerFixture(t, pi => {
		api = pi;
		pi.registerToolRenderer((name, next) => {
			calls.push(`first:${name}`);
			if (name === "outer") assert.equal(runner.resolveToolRenderers("inner", base), base);
			const value = next(); assert.equal(next(), value); return value;
		});
	}, pi => pi.registerToolRenderer((name, next) => { calls.push(`second:${name}`); return next() ?? missing; }));
	runner = f.runner; f.runtime.refreshTools = () => { refreshes++; };
	assert.equal(runner.resolveToolRenderers("outer", base), base);
	assert.deepEqual(calls, ["first:outer", "first:inner", "second:inner", "second:inner", "second:outer", "second:outer"]);
	assert.equal(runner.resolveToolRenderers("unknown", undefined), missing);
	api.registerToolRenderer((_name, next) => next());
	assert.equal(refreshes, 0); assert.deepEqual(runner.getAllRegisteredTools(), []);
	assert.equal(runner.getToolDefinition("unknown"), undefined);
	const state = runner as unknown as { rendererBase?: ToolRenderers; rendererToolName?: string; rendererDepth: number };
	assert.equal(state.rendererBase, undefined); assert.equal(state.rendererToolName, undefined); assert.equal(state.rendererDepth, 0);
});

test("renderer errors, invalid async returns and recursion fall back and clear traversal state", async t => {
	const base = renderers("base"), errors: string[] = [];
	let runner!: ExtensionRunner, savedNext!: () => ToolRenderers | undefined;
	const f = await runnerFixture(t, pi => pi.registerToolRenderer((name, next) => {
		savedNext = next;
		if (name === "throw") throw new Error("fixture failure");
		if (name === "async") return Promise.reject(new Error("late fixture rejection")) as never;
		if (name === "recursive") return runner.resolveToolRenderers(name, base);
		return next();
	}));
	runner = f.runner; runner.onError(error => errors.push(error.error));
	for (const name of ["throw", "async", "recursive", "healthy"]) assert.equal(runner.resolveToolRenderers(name, base), base);
	assert.equal(savedNext(), undefined, "continuation retains no completed query");
	assert.equal(errors.length, 3);
	assert.match(errors.join("\n"), /fixture failure[\s\S]*synchronously[\s\S]*128 frames/);
	await new Promise<void>(resolve => setImmediate(resolve));
	runner.invalidate();
	assert.throws(() => runner.resolveToolRenderers("stale", base), /stale/);
});

test("renderer registration is bounded and failed loads revoke their API", async () => {
	const runtime = createExtensionRuntime();
	let failedApi!: ExtensionAPI;
	try {
		await assert.rejects(loadExtensionFromFactory(pi => {
			failedApi = pi;
			assert.throws(() => pi.registerToolRenderer(null as never), /resolver function/);
			for (let index = 0; index < 64; index++) pi.registerToolRenderer((_name, next) => next());
			pi.registerToolRenderer((_name, next) => next());
		}, process.cwd(), createEventBus(), runtime), /at most 64/);
		assert.throws(() => failedApi.registerToolRenderer((_name, next) => next()), /failed to load/);
	} finally { runtime.invalidate(); }
});

async function sessionFixture(t: TestContext, resolver: ToolRendererResolver) {
	initTheme("dark");
	const root = mkdtempSync(join(tmpdir(), "sp-tool-renderers-"));
	t.diagnostic(`ownedFixture=${root}`);
	const settings = SettingsManager.inMemory({});
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [pi => pi.registerToolRenderer(resolver)] });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	t.after(() => { try { session?.dispose(); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } });
	await resources.reload();
	({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: resources, settingsManager: settings,
		sessionManager: SessionManager.create(root, root), tools: ["read"], noMcp: true,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "http://unused",
			reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
			getModel: () => undefined, getAuth: async () => undefined } as never }));
	await session.bindExtensions({});
	return { session, root };
}

function modeFixture(session: Awaited<ReturnType<typeof sessionFixture>>["session"]) {
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session }, isInitialized: true, pendingTools: new Map(), streamedToolIds: new Set(),
		deferredReadPlaceholders: new Map(), deferredReadExecutions: new Map(), chatContainer: new RetainedContainer(),
		nextTranscriptItemNumber: 0, toolOutputExpanded: false, ui: { requestRender() {} } as TUI,
		footer: { invalidate() {} },
		addMessageToChat() {}, // Only assistant prose is omitted; production tool/history paths remain intact.
	});
	return mode as { createTrackedToolComponent(name: string, id: string, args: unknown, placeholder?: undefined, group?: boolean): Component;
		handleEvent(event: unknown): void; renderSessionItems(items: unknown[]): void; chatContainer: RetainedContainer };
}

test("real session renders absent tools live and in history/HTML without adding execution authority", async t => {
	const view = renderers("archived"), name = "mcp__offline__inspect";
	let lookups = 0;
	const { session, root } = await sessionFixture(t, (toolName, next) => { lookups++; return toolName === name ? view : next(); });
	assert.equal(session.getToolDefinition(name), undefined);
	assert.equal(session.getAllTools().some(tool => tool.name === name), false);
	session.setActiveToolsByName([name]);
	assert.equal(session.getActiveToolNames().includes(name), false);
	const mode = modeFixture(session);
	t.after(() => mode.chatContainer.clear());
	const row = mode.createTrackedToolComponent(name, "live", {}) as ToolExecutionComponent;
	assert.match(row.render(100).join("\n"), /call:archived/);
	const initialLookups = lookups;
	for (let index = 0; index < 100; index++) mode.handleEvent({ type: "tool_execution_update", toolCallId: "live", toolName: name,
		partialResult: { content: [{ type: "text", text: "progress" }], details: {} } });
	assert.equal(lookups, initialLookups, "100 progress updates never rerun resolution");
	mode.handleEvent({ type: "tool_execution_end", toolCallId: "live", toolName: name, isError: false,
		result: { content: [{ type: "text", text: "done" }], details: {} } });
	assert.match(row.render(100).join("\n"), /result:archived:done/);
	const assistant = { role: "assistant", content: [{ type: "toolCall", id: "history", name, arguments: {} }], api: "openai-responses",
		provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 } as AssistantMessage;
	const result = { role: "toolResult" as const, toolCallId: "history", toolName: name,
		content: [{ type: "text" as const, text: "recovered" }], details: {}, isError: false, timestamp: 2 };
	mode.renderSessionItems([assistant, result]);
	assert.match(mode.chatContainer.render(100).join("\n"), /result:archived:recovered/);
	session.sessionManager.appendMessage(assistant); session.sessionManager.appendMessage(result);
	const output = await session.exportToHtml(join(root, "history.html"));
	const html = readFileSync(output, "utf8");
	const encoded = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)?.[1];
	assert.ok(encoded, "export contains embedded session data");
	assert.match(Buffer.from(encoded, "base64").toString("utf8"), /expanded:archived:recovered/);
	assert.equal(session.getToolDefinition(name), undefined);
});

test("explicit read and Codemode renderers bypass specialized rows while default read grouping remains", async t => {
	const view = renderers("override"); let override = true;
	const { session } = await sessionFixture(t, (name, next) => override && (name === "read" || name === "codemode") ? view : next());
	const mode = modeFixture(session); t.after(() => mode.chatContainer.clear());
	const read = mode.createTrackedToolComponent("read", "read-one", { path: "a.ts" }, undefined, true);
	assert.ok(read instanceof ToolExecutionComponent); assert.match(read.render(100).join("\n"), /call:override/);
	const code = mode.createTrackedToolComponent("codemode", "code", {});
	assert.match(code.render(100).join("\n"), /call:override/);
	assert.equal((code as ToolExecutionComponent).startNestedTool("nested", "read", {}), false);
	override = false;
	const grouped = mode.createTrackedToolComponent("read", "read-two", { path: "b.ts" }, undefined, true);
	assert.ok(grouped instanceof ReadToolGroupComponent);
});

test("HTML retains legacy definition lookup and supports independent renderer context", () => {
	initTheme("dark");
	const view = renderers("legacy");
	const html = createToolHtmlRenderer({ getToolDefinition: () => view as never, cwd: process.cwd(), theme });
	assert.match(html.renderCall("legacy", "gone", {} )!, /call:legacy/);
	assert.match(html.renderResult("legacy", "gone", [{ type: "text", text: "done" }], {}, false)!.expanded!, /expanded:legacy:done/);
});
