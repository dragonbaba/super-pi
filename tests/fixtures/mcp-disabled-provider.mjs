import { AssistantMessageEventStream } from "../../packages/ai/dist/utils/event-stream.js";

export default function (pi) {
	let mcpEnabled;
	pi.on("session_start", event => { mcpEnabled = event.mcpEnabled; });
	pi.registerTool({ name: "mcp__local__helper", label: "local", description: "ordinary local tool", parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [], details: {} }) });
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	pi.registerProvider("disabled-fixture", {
		baseUrl: "https://fixture.invalid", apiKey: "offline-fixture", api: "openai-responses",
		models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model) {
			const stream = new AssistantMessageEventStream();
			const message = { role: "assistant", content: [{ type: "text", text: `MCP_ENABLED:${mcpEnabled};TOOLS:${pi.getActiveTools().sort().join(",")}` }],
				api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
				usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } } };
			stream.push({ type: "done", reason: "stop", message }); return stream;
		},
	});
}
