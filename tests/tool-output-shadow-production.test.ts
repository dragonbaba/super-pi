import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, ToolResultMessage } from "../packages/ai/src/types.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createToolOutputEstimatorCounters } from "../packages/coding-agent/src/core/tool-output-budget.ts";

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "shadow-production-fixture",
		name: "Shadow Production Fixture",
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

test("production message_end isolates async shadow rejection after extension replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shadow-production-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	let unhandledRejections = 0;
	const onUnhandledRejection = (): void => { unhandledRejections++; };
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "toolResult") return undefined;
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: "extension replacement" }],
							},
						};
					});
				},
			],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd, { id: "shadow-production" });
		const counters = createToolOutputEstimatorCounters();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: fixtureModel(),
			modelRuntime: fixtureModelRuntime(),
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: "all",
			toolOutputShadow: {
				enabled: true,
				counters,
				telemetry: {
					async recordToolOutputShadow(): Promise<void> {
						throw new Error("telemetry rejection");
					},
				},
			},
		});
		try {
			let listenerMessage: ToolResultMessage | undefined;
			session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "toolResult") listenerMessage = event.message;
			});
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "shadow-call",
				toolName: "bash",
				content: [{ type: "text", text: "before extension" }],
				isError: false,
				timestamp: 1,
			};
			await (session as unknown as {
				_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message });
			await new Promise<void>((resolve) => { setImmediate(resolve); });
			const persisted = sessionManager.getBranch().at(-1);
			assert.equal(unhandledRejections, 0);
			assert.equal(listenerMessage?.content[0]?.type, "text");
			assert.equal(listenerMessage?.content[0]?.text, "extension replacement");
			assert.equal(persisted?.type, "message");
			const persistedContent = (persisted as { message?: ToolResultMessage }).message?.content[0];
			assert.equal(persistedContent?.type, "text");
			assert.equal(persistedContent?.type === "text" ? persistedContent.text : undefined, "extension replacement");
			assert.equal(counters.telemetrySinkDrops, 1);
			assert.equal(counters.telemetrySinkRejections, 1);
		} finally {
			session.dispose();
		}
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
		rmSync(root, { recursive: true, force: true });
	}
});

test("absent, disabled, and enabled shadow preserve the production final-result chain", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shadow-production-control-"));
	try {
		const run = async (mode: "absent" | "disabled" | "enabled") => {
			const cwd = join(root, mode, "workspace");
			const agentDir = join(root, mode, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
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
					pi.on("message_end", (event) => event.message.role === "toolResult"
						? { message: { ...event.message, content: [{ type: "text", text: "controlled replacement" }] } }
						: undefined);
				}],
			});
			await resourceLoader.reload();
			const sessionManager = SessionManager.inMemory(cwd, { id: `control-${mode}` });
			const counters = createToolOutputEstimatorCounters();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model: fixtureModel(),
				modelRuntime: fixtureModelRuntime(),
				settingsManager,
				sessionManager,
				resourceLoader,
				noTools: "all",
				toolOutputShadow: mode === "absent" ? undefined : {
					enabled: mode === "enabled",
					counters,
					telemetry: { recordToolOutputShadow: () => {} },
				},
			});
			try {
				let listener: ToolResultMessage | undefined;
				session.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "toolResult") listener = event.message;
				});
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "control-call",
					toolName: "bash",
					content: [{ type: "text", text: "before" }],
					isError: true,
					timestamp: 1,
				};
				await (session as unknown as {
					_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
				})._handleAgentEvent({ type: "message_end", message });
				const persisted = sessionManager.getBranch().at(-1) as { message?: ToolResultMessage };
				return structuredClone({
					message,
					listener,
					persisted: persisted.message,
				});
			} finally {
				session.dispose();
			}
		};
		const absent = await run("absent");
		const disabled = await run("disabled");
		const enabled = await run("enabled");
		assert.deepEqual(disabled, absent);
		assert.deepEqual(enabled, absent);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
