import { installChildControl } from "../../packages/extensions/subagent/child-control.ts";
const mode = process.argv[2];
if (mode.startsWith("steer-real")) {
	await runSessionGuidance();
} else {
const hooks = new Map();
const initialMessageListeners = process.listenerCount("message");
const initialDisconnectListeners = process.listenerCount("disconnect");
let aborted = 0;
let toolsDisabled = 0;
let followUps = 0;
installChildControl({ on(name, hook) { hooks.set(name, hook); }, setActiveTools(names) { if (names.length) throw new Error("Unexpected tools"); toolsDisabled++; },
	sendMessage(message, options) { if (options.deliverAs !== "followUp" || !options.triggerTurn || !message.content.includes("HANDOFF NOW")) throw new Error("Bad handoff follow-up"); followUps++; } });
await hooks.get("session_start")({}, { abort() { aborted++; } });
const initial = [{ role: "user", content: "new instruction", timestamp: 3 }];
const context = await hooks.get("context")({ messages: initial });
const prompt = await hooks.get("before_agent_start")({ systemPrompt: "fixture" });
const startupDisabled = toolsDisabled;
for (let i = 0; i < 2; i++) {
	await hooks.get("turn_start")({});
	if (aborted) break;
	const message = { role: "assistant", api: "test", provider: "test", model: "fixture", timestamp: 4 + i, stopReason: "stop",
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: mode === "bad-checkpoint" ? [{ type: "image", data: "unsupported" }] : [{ type: "text", text:
			i === 0 && mode === "large-turn" ? "x".repeat(800_000) : i === 0 && mode === "transport-overflow" ? "€".repeat(800_000)
			: i === 0 && mode === "checkpoint-overflow" ? "€".repeat(400_000) : toolsDisabled ? "handoff: done; remaining inspection belongs to a fresh bounded assignment" : "done" }] };
	const toolResults = [];
	if (i === 0 && mode === "large-tool-result") {
		message.stopReason = "toolUse";
		message.content = [{ type: "toolCall", id: "large-read", name: "read", arguments: { path: "fixture.txt" } }];
		toolResults.push({ role: "toolResult", toolCallId: "large-read", toolName: "read", isError: false, timestamp: 5, content: [{ type: "text", text: "x".repeat(800_000) }] });
	}
	await hooks.get("turn_end")({ message, toolResults });
	if (aborted) break;
}
const lastContext = await hooks.get("context")({ messages: initial });
const summary = { seedRoles: context?.messages.map(message => message.role), initialCount: initial.length, prompt: prompt?.systemPrompt, aborted,
	startupDisabled, toolsDisabled, followUps, toolBlocked: (await hooks.get("tool_call")({ toolName: "read" }))?.block === true,
	capacityNotice: lastContext?.messages.at(-1)?.content };
await hooks.get("session_shutdown")();
summary.messageListeners = process.listenerCount("message") - initialMessageListeners;
summary.disconnectListeners = process.listenerCount("disconnect") - initialDisconnectListeners;
process.stdout.write(JSON.stringify(summary));
}

// Real session/extension/Agent steering queue with an offline model; same IPC owner as other modes.
async function runSessionGuidance() {
	const { default: assert } = await import("node:assert/strict");
	const { Type } = await import("typebox");
	const { createAgentSession } = await import("../../packages/coding-agent/src/core/sdk.ts");
	const { DefaultResourceLoader } = await import("../../packages/coding-agent/src/core/resource-loader.ts");
	const { SessionManager } = await import("../../packages/coding-agent/src/core/session-manager.ts");
	const { SettingsManager } = await import("../../packages/coding-agent/src/core/settings-manager.ts");
	const { AssistantMessageEventStream } = await import("../../packages/ai/src/utils/event-stream.ts");
	const initialMessageListeners = process.listenerCount("message"), initialDisconnectListeners = process.listenerCount("disconnect");
	const cwd = process.cwd();
	const model = { id: "offline", name: "Offline", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
	let requests = 0, inspections = 0;
	const errors = [];
	const runtime = {
		hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), getAuth: async () => undefined, isUsingOAuth: () => false, getModel: () => model,
		registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
		streamSimple(_model, context) {
			assert.ok(requests < 2, "correction must not create extra model turns");
			const guidance = context.messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("PARENT TASK GUIDANCE"));
			assert.equal(guidance.length, requests);
			if (requests) {
				assert.match(JSON.stringify(guidance[0].content), /user_input=false.*Correction:/s);
				assert.match(JSON.stringify(guidance[0].content), /report only the verified path/);
				if (mode.endsWith("tool")) {
					assert.equal(inspections, 1);
					const index = context.messages.findIndex(m => m.role === "toolResult");
					assert.equal(context.messages[index - 1].role, "assistant");
					assert.equal(context.messages[index + 1], guidance[0], "guidance cannot split a tool call/result pair");
				}
			}
			const useTool = requests++ === 0 && mode.endsWith("tool");
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: useTool ? "toolUse" : "stop", timestamp: Date.now(),
				content: useTool ? [{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} }] : [{ type: "text", text: "verified path" }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
		},
	};
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resources = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings, extensionFactories: [installChildControl],
		noExtensions: true, noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true, systemPrompt: "Offline task guidance fixture." });
	await resources.reload();
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime, settingsManager: settings,
		sessionManager: SessionManager.inMemory(cwd), resourceLoader: resources, noMcp: true, tools: ["inspect"], customTools: [{
			name: "inspect", modelOnly: true, label: "Inspect", description: "Offline inspection", parameters: Type.Object({}),
			execute: async () => { inspections++; return { content: [{ type: "text", text: "verified path" }], details: {} }; },
		}] });
	try {
		await session.bindExtensions({ onError: error => errors.push(error) });
		await session.prompt("Inspect and report the path.");
		assert.equal(requests, 2); assert.deepEqual(errors, []);
		assert.equal(session.agent.hasQueuedMessages(), false);
	} finally { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
	process.stdout.write(JSON.stringify({ requests, inspections, errors, messageListeners: process.listenerCount("message") - initialMessageListeners,
		disconnectListeners: process.listenerCount("disconnect") - initialDisconnectListeners }));
}
