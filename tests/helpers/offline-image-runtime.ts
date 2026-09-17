import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stream } from "../../packages/ai/src/api/openai-responses.ts";
import { registerApiProvider, unregisterApiProviders } from "@super-pi/ai/compat";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import auxiliaryVision from "../../packages/extensions/auxiliary-vision/index.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

export async function offlineImageRuntime(root: string, auxiliary: boolean, savedSession?: string, onRecord?: (record: Record<string, unknown>) => void, inputTransform?: (event: any) => any,
	controls: { extensions?: any[]; beforeWireResponse?: (vision: boolean, wire: any) => Promise<void> | void } = {}) {
	const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
	const configPath = join(root, "vision.json");
	writeFileSync(configPath, JSON.stringify({ model: "offline-input/vision", automatic: true, toolMode: "off" }));
	const counts = { main: 0, vision: 0, imageHooks: 0, plainHooks: 0, failures: 0 };
	let failNextMain = false;
	const records: Record<string, unknown>[] = [];
	function record(value: Record<string, unknown>) { const item = { at: performance.now(), ...value }; if (records.length < 256) records.push(item); onRecord?.(item); }
	const base = { provider: "offline-input", api: "openai-responses", baseUrl: "https://offline.invalid", reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 };
	const model: any = { ...base, id: auxiliary ? "text-main" : "image-main", name: auxiliary ? "Offline text main" : "Offline multimodal main", input: auxiliary ? ["text"] : ["text", "image"] };
	const vision: any = { ...base, id: "vision", name: "Offline auxiliary vision", input: ["text", "image"], api: "offline-input-vision" };
	function transport(target: any, context: any, options: any = {}) {
		const isVision = target.id === "vision";
		return stream({ ...target, api: "openai-responses" }, context, { ...options, apiKey: "offline-noncredential", maxRetries: 0,
			fetch: async (_url, init) => {
				const wire = JSON.parse(String(init?.body)); let images = 0;
				for (const item of wire.input ?? []) for (const block of item.content ?? []) if (block.type === "input_image") images++;
				assert.doesNotMatch(String(init?.body), /imageSubmission|application-snapshot|contentIndex/);
				if (!isVision && auxiliary) assert.equal(images, 0, "text main wire cannot contain images");
				if (isVision) counts.vision++; else counts.main++;
				record({ kind: isVision ? "vision-wire" : "main-wire", images });
				await controls.beforeWireResponse?.(isVision, wire);
				if (!isVision && failNextMain) { failNextMain = false; counts.failures++; return new Response("offline injected main failure", { status: 400 }); }
				const text = isVision ? `离线视觉 fixture：按顺序接收 ${images} 张图片。未进行真实内容识别。` : `离线请求已完成；本次 wire 图片数 ${images}。main=${counts.main}, vision=${counts.vision}`;
				const item = { type: "message", id: "offline-output", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
				const events = [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "offline-response", status: "completed", output: [item] } }];
				return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			} });
	}
	const modelRuntime = { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
		getAuth: async () => ({ auth: { apiKey: "offline-noncredential" } }), isUsingOAuth: () => false, isUsingSubscription: () => false,
		getAvailableSnapshot: () => [model], getAvailable: async () => [model], getError: () => undefined,
		getModel: (provider: string, id: string) => provider === "offline-input" ? id === "vision" ? vision : model : undefined,
		registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}, streamSimple: transport,
	} as unknown as ModelRuntime;
	registerApiProvider({ api: "offline-input-vision", stream: transport, streamSimple: transport } as any, root);
	const settings = SettingsManager.inMemory({ quietStartup: true, theme: "dark", compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
		noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
			pi.on("input", event => { if (event.images?.length) counts.imageHooks++; else counts.plainHooks++; return inputTransform?.(event) ?? { action: "continue" }; });
			pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("offline-input", "OFFLINE · main=0 vision=0 · /offline-status"));
			pi.on("agent_end", (_event, ctx) => ctx.ui.setStatus("offline-input", `OFFLINE · main=${counts.main} vision=${counts.vision}`));
			pi.registerCommand("offline-status", { description: "Show isolated offline request counters", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(counts), "info") });
		}, ...(controls.extensions ?? []), ...(auxiliary ? [(pi: any) => auxiliaryVision(pi, { configPath, systemTempDir: root })] : [])] });
	await resourceLoader.reload();
	const sessionManager = savedSession ? SessionManager.open(savedSession, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
	const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager: settings, sessionManager, resourceLoader, noTools: "all" });
	session.subscribe(event => { if (event.type === "message_start" && event.message.role === "user") record({ kind: "submitted", id: (event.message as any).imageSubmission?.id, images: (event.message as any).imageSubmission?.attachments.length ?? 0 }); });
	const host = new AgentSessionRuntime(session, { cwd, agentDir, modelRuntime, settingsManager: settings, resourceLoader, diagnostics: [] },
		async () => { throw new Error("Offline acceptance uses one isolated session; restart the launcher for another run"); });
	return { root, cwd, configPath, counts, records, session, host, modelRuntime, failMain() { failNextMain = true; },
		async close() { await host.dispose(); unregisterApiProviders(root); } };
}
