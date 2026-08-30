import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, ToolResultMessage } from "../packages/ai/src/types.ts";
import type { AgentSessionEvent } from "../packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import {
	createToolResultPresentationCounters,
	type ToolResultPresentationCounters,
	type ToolResultPresentationV1,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "presentation-production-fixture",
		name: "Presentation Production Fixture",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function fixtureModelRuntime(): ModelRuntime {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		streamSimple: () => { throw new Error("provider dispatch is outside this fixture"); },
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	} as unknown as ModelRuntime;
}

interface ProductionResult {
	message: ToolResultMessage;
	persisted: ToolResultMessage;
	presentation: ToolResultPresentationV1 | undefined;
	extensionSawPresentation: boolean;
	extensionContent: ToolResultMessage["content"];
	counters: ToolResultPresentationCounters;
}

async function runProductionFixture(
	root: string,
	mode: "absent" | "disabled" | "enabled",
): Promise<ProductionResult> {
	const cwd = join(root, mode, "workspace");
	const agentDir = join(root, mode, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	let extensionSawPresentation = false;
	let extensionContent: ToolResultMessage["content"] = [];
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		extensionFactories: [(pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "toolResult") return undefined;
				extensionSawPresentation = "toolResultPresentation" in event;
				extensionContent = [{ type: "text", text: "extension-final-content" }];
				return { message: { ...event.message, content: extensionContent } };
			});
		}],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: `presentation-${mode}` });
	const counters = createToolResultPresentationCounters();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: fixtureModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all",
		toolResultPresentation: mode === "absent" ? undefined : { enabled: mode === "enabled", counters },
	});
	try {
		let presentation: ToolResultPresentationV1 | undefined;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				presentation = event.toolResultPresentation;
			}
		});
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "presentation-call",
			toolName: "bash",
			content: [{ type: "text", text: "before-extension" }],
			isError: true,
			timestamp: 1,
		};
		session.agent.state.messages.push(message);
		await (session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
		await (session as unknown as {
			_handleAgentEvent(event: {
				type: "tool_execution_update";
				toolCallId: string;
				toolName: string;
				args: Record<string, never>;
				partialResult: { content: Array<{ type: "text"; text: string }> };
			}): Promise<void>;
		})._handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "progress",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "progress-only" }] },
		});
		const persistedEntry = sessionManager.getBranch().at(-1);
		assert.equal(persistedEntry?.type, "message");
		const stateMessage = session.agent.state.messages.at(-1);
		assert.equal(stateMessage, message);
		if (presentation) assert.equal(stateMessage?.role === "toolResult" ? stateMessage.content : undefined, presentation.modelContent);
		return {
			message,
			persisted: (persistedEntry as { message: ToolResultMessage }).message,
			presentation,
			extensionSawPresentation,
			extensionContent,
			counters,
		};
	} finally {
		session.dispose();
	}
}

test("production creates presentation only after extension and preserves model/session behavior", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-presentation-production-"));
	try {
		const absent = await runProductionFixture(root, "absent");
		const disabled = await runProductionFixture(root, "disabled");
		const enabled = await runProductionFixture(root, "enabled");

		assert.equal(absent.presentation, undefined);
		assert.equal(disabled.presentation, undefined);
		assert.deepEqual(disabled.message, absent.message);
		assert.deepEqual(enabled.message, absent.message);
		assert.equal(enabled.extensionSawPresentation, false);
		assert.ok(enabled.presentation);
		assert.equal(enabled.presentation.modelContent, enabled.message.content);
		assert.equal(enabled.presentation.modelContent, enabled.extensionContent);
		assert.notEqual(enabled.presentation.uiContent, enabled.presentation.modelContent);
		assert.equal(enabled.presentation.uiContent?.[0], enabled.presentation.modelContent[0]);
		assert.equal(enabled.persisted.content, enabled.presentation.modelContent);
		assert.equal("toolResultPresentation" in enabled.message, false);
		assert.equal("toolResultPresentation" in enabled.persisted, false);
		assert.equal(enabled.message.isError, true);
		assert.equal(absent.counters.presentationObjectsCreated, 0);
		assert.equal(disabled.counters.presentationObjectsCreated, 0);
		assert.equal(disabled.counters.outerArraysCreated, 0);
		assert.equal(enabled.counters.presentationObjectsCreated, 1);
		assert.equal(enabled.counters.outerArraysCreated, 1);
		assert.equal(enabled.counters.activePresentations, 0);
		assert.equal(enabled.counters.activePresentationsHighWaterMark, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
