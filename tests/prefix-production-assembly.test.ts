import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import {
	PrefixManifestRecorder,
	serializePrefixManifest,
	sha256Canonical,
} from "../packages/coding-agent/src/core/prefix-manifest.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

function fixtureModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-production-fixture",
		name: "Production Fixture",
		api: "openai-codex-responses",
		provider: "fixture",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function createModelRuntime(): ModelRuntime {
	const runtime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const instructionsHash = sha256Canonical(context.systemPrompt ?? "");
				const toolOrder = (context.tools ?? []).map((tool) => tool.name);
				const toolsHash = sha256Canonical((context.tools ?? []).map((tool) => ({
					name: tool.name,
					schema: tool.parameters,
				})));
				options?.onEffectiveDispatch?.(Object.freeze({
					transport: "sse",
					previousResponseMode: "none",
					instructionsHash,
					instructionsBytes: Buffer.byteLength(context.systemPrompt ?? ""),
					toolOrderHash: sha256Canonical(toolOrder),
					toolIdentifierSetHash: sha256Canonical([...toolOrder].sort()),
					toolsHash,
					toolCount: toolOrder.length,
					cacheKeyHash: sha256Canonical(options?.sessionId ?? null),
					cachePolicyHash: sha256Canonical({ cacheRetention: options?.cacheRetention ?? null }),
					prefixHash: sha256Canonical({ instructionsHash, toolOrder, toolsHash }),
					requestTransformOutputHash: sha256Canonical({ instructionsHash, toolsHash }),
				}), model);
				const message = {
					role: "assistant" as const,
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 1,
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	};
	return runtime as unknown as ModelRuntime;
}

function writeSkills(skillsRoot: string, names: readonly string[]): void {
	rmSync(skillsRoot, { recursive: true, force: true });
	for (const name of names) {
		const directory = join(skillsRoot, name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), [
			"---",
			`name: ${name}`,
			`description: ${name} fixture`,
			"---",
			`${name} instructions`,
		].join("\n"));
	}
}

test("production assembly is deterministic without test-side resource sorting", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prefix-production-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const skillsRoot = join(root, "skills");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const capture = async (creationOrder: readonly string[]): Promise<string> => {
		writeSkills(skillsRoot, creationOrder);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: [skillsRoot],
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const recorder = new PrefixManifestRecorder();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: fixtureModel(),
			modelRuntime: createModelRuntime(),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd, { id: "deterministic-session" }),
			resourceLoader,
			prefixManifestRecorder: recorder,
			tools: ["read"],
		});
		try {
			await session.prompt("hello", { expandPromptTemplates: false });
			assert.ok(session.prefixIntentManifest);
			assert.ok(session.prefixManifest);
			assert.equal(session.prefixManifest.dynamicInstructionObservationState, "unavailable");
			assert.equal(session.prefixManifest.compactionObservationState, "unavailable");
			return serializePrefixManifest(session.prefixManifest);
		} finally {
			session.dispose();
		}
	};

	try {
		const forward = await capture(["zeta", "alpha", "middle"]);
		const reverse = await capture(["middle", "alpha", "zeta"]);
		assert.equal(forward, reverse);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production assembly diagnoses context and tool causes behind aggregate prompt drift", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prefix-causal-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const recorder = new PrefixManifestRecorder();

	const capture = async (contextContent: string, tools: Array<"read" | "write">, basePrompt?: string) => {
		writeFileSync(join(cwd, "AGENTS.md"), contextContent);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPrompt: basePrompt,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: fixtureModel(),
			modelRuntime: createModelRuntime(),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd, { id: "causal-session" }),
			resourceLoader,
			prefixManifestRecorder: recorder,
			tools,
		});
		try {
			await session.prompt("hello", { expandPromptTemplates: false });
			return session.prefixDriftDiagnostic;
		} finally {
			session.dispose();
		}
	};

	try {
		assert.equal(await capture("project policy one", ["read"]), undefined);
		const contextDiagnostic = await capture("project policy two", ["read"]);
		assert.equal(contextDiagnostic?.firstDivergentSegment, "system-prompt");
		assert.equal(contextDiagnostic?.reasonCode, "PROJECT_CONTEXT_CHANGED");
		const toolDiagnostic = await capture("project policy two", ["read", "write"]);
		assert.equal(toolDiagnostic?.firstDivergentSegment, "system-prompt");
		assert.equal(toolDiagnostic?.reasonCode, "TOOL_ACTIVATED");
		const basePromptDiagnostic = await capture("project policy two", ["read", "write"], "different base prompt");
		assert.equal(basePromptDiagnostic?.firstDivergentSegment, "system-prompt");
		assert.equal(basePromptDiagnostic?.reasonCode, "UNKNOWN_PREFIX_DRIFT");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
