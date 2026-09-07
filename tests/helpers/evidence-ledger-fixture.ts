import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { EvidenceLedger } from "../../packages/coding-agent/src/core/evidence-ledger.ts";
import type { ToolResultPresentationOwner } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import type { AssistantMessage, Context } from "../../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createToolResultPresentationCounters } from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

export async function fixture(enabled = true, owner = true, extensions: InlineExtension[] = []) {
	const root = mkdtempSync(join(tmpdir(), "pi-evidence-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(cwd, "file.txt"), "production-shaped evidence text\n".repeat(1000));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, evidenceLedger: { enabled } });
	const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true, extensionFactories: extensions });
	await resources.reload();
	const counters = createToolResultPresentationCounters();
	const { session } = await createAgentSession({
		cwd, agentDir, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: resources,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false, getModel: () => undefined, getAuth: async () => undefined } as unknown as ModelRuntime,
		toolResultPresentation: owner ? { enabled: true, budgetTokens: 2048, counters } : undefined,
	});
	let id = 0;
	async function read(args: Record<string, unknown> = { path: "file.txt" }) {
		const callId = `read-${++id}`;
		const tool = session.agent.state.tools.find(t => t.name === "read")!;
		const result = await tool.execute(callId, args, undefined, undefined);
		const message = { role: "toolResult" as const, toolName: "read", toolCallId: callId, content: result.content, details: result.details, isError: false, timestamp: id };
		session.agent.state.messages.push(message);
		await (session as unknown as { _handleAgentEvent(event: unknown): Promise<void> })._handleAgentEvent({ type: "message_end", message });
		return message;
	}
	const internals = session as unknown as { _evidenceLedger?: EvidenceLedger; _toolResultPresentation?: ToolResultPresentationOwner; _evidenceCompletedReads?: Map<string, unknown>; _evidenceCompletedBytes: number; _refreshToolRegistry(): void };
	async function runCalls(calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
		const contexts: Context[] = [];
		let dispatched = false;
		session.agent.streamFunction = (model, context) => {
			contexts.push(context);
			const content: AssistantMessage["content"] = dispatched ? [] : calls.map(call => ({ type: "toolCall", id: `loop-${++id}`, ...call }));
			dispatched = true;
			const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: content.length ? "toolUse" : "stop", timestamp: id };
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			return stream;
		};
		await session.agent.prompt("fixture");
		return contexts;
	}
	return { root, cwd, session, counters, settings, internals, read, runCalls, close() { session.dispose(); rmSync(root, { recursive: true, force: true }); } };
}
