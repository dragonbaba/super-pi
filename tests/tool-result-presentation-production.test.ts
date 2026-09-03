import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../packages/ai/src/types.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import type { AgentSessionEvent } from "../packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	type ToolResultPresentationCounters,
	type ToolResultPresentation,
	type ToolResultPresentationV2,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

type ToolResultMessageEndEvent = {
	type: "message_end";
	message: ToolResultMessage;
};

type ToolResultSessionMessageEndEvent = ToolResultMessageEndEvent & {
	toolResultPresentation?: ToolResultPresentation;
};

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

function codexFixtureModel(): Model<"openai-codex-responses"> {
	return {
		...fixtureModel(),
		api: "openai-codex-responses",
		provider: "openai-codex",
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

function capturingModelRuntime(capture: (context: Context) => void): ModelRuntime {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		streamSimple: (model: Model<any>, context: Context) => {
			capture(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
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
					stopReason: "stop",
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
	} as unknown as ModelRuntime;
}

function providerCursorFrom(content: ToolResultMessage["content"]): string {
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		const match = /Continue with cursor (tr1\.[a-z0-9.]+)\.\]/.exec(block.text);
		if (match?.[1]) return match[1];
	}
	throw new Error("provider model view is missing its continuation cursor");
}

interface ProductionResult {
	message: ToolResultMessage;
	persisted: ToolResultMessage;
	presentation: ToolResultPresentation | undefined;
	extensionSawPresentation: boolean;
	extensionContent: ToolResultMessage["content"];
	originalEvent: ToolResultMessageEndEvent;
	extensionEvent: ToolResultMessageEndEvent;
	sessionEvent: ToolResultSessionMessageEndEvent;
	persistedMessages: number;
	counters: ToolResultPresentationCounters;
}

async function runProductionFixture(
	root: string,
	mode: "absent" | "disabled" | "enabled",
	disposeInListener = false,
): Promise<ProductionResult> {
	const cwd = join(root, mode, "workspace");
	const agentDir = join(root, mode, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	let extensionSawPresentation = false;
	let extensionContent: ToolResultMessage["content"] = [];
	let retainedExtensionEvent: ToolResultMessageEndEvent | undefined;
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
				retainedExtensionEvent = event as ToolResultMessageEndEvent;
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
		let presentation: ToolResultPresentation | undefined;
		let retainedSessionEvent: ToolResultSessionMessageEndEvent | undefined;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				retainedSessionEvent = event as ToolResultSessionMessageEndEvent;
				presentation = event.toolResultPresentation;
				if (disposeInListener) session.dispose();
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
		const originalEvent: ToolResultMessageEndEvent = { type: "message_end", message };
		const persistedBefore = sessionManager.getBranch().length;
		await (session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent(originalEvent);
		if (!disposeInListener) await (session as unknown as {
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
			originalEvent,
			extensionEvent: retainedExtensionEvent!,
			sessionEvent: retainedSessionEvent!,
			persistedMessages: sessionManager.getBranch().length - persistedBefore,
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
		assert.equal("toolResultPresentation" in enabled.extensionEvent, false);
		assert.equal("toolResultPresentation" in enabled.originalEvent, false);
		assert.notEqual(enabled.extensionEvent, enabled.sessionEvent);
		assert.notEqual(enabled.originalEvent, enabled.sessionEvent);
		assert.equal(enabled.extensionEvent.message, enabled.sessionEvent.message);
		assert.equal(enabled.sessionEvent.message, enabled.message);
		assert.equal(enabled.sessionEvent.toolResultPresentation, enabled.presentation);
		assert.equal(enabled.presentation.modelContent, enabled.message.content);
		assert.equal(enabled.presentation.modelContent, enabled.extensionContent);
		assert.notEqual(enabled.presentation.uiContent, enabled.presentation.modelContent);
		assert.equal(enabled.presentation.uiContent?.[0], enabled.presentation.modelContent[0]);
		assert.equal(enabled.persisted.content, enabled.presentation.modelContent);
		assert.equal("toolResultPresentation" in enabled.message, false);
		assert.equal("toolResultPresentation" in enabled.persisted, false);
		assert.equal(enabled.message.isError, true);
		assert.deepEqual(absent.counters, createToolResultPresentationCounters());
		assert.deepEqual(disabled.counters, createToolResultPresentationCounters());
		assert.equal(enabled.counters.presentationObjectsCreated, 1);
		assert.equal(enabled.counters.uiOuterArraysCreated, 1);
		assert.equal(enabled.counters.activeDispatchPresentationScopes, 0);
		assert.equal(enabled.counters.dispatchPresentationScopesHighWaterMark, 1);
		assert.equal(enabled.counters.completedDispatchPresentationScopes, 1);
		assert.equal(enabled.counters.ownerDisposeCalls, 1);
		assert.equal(enabled.presentation.modelContent, enabled.message.content);
		assert.equal(enabled.presentation.uiContent?.[0], enabled.message.content[0]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("synchronous listener disposal releases the stable presentation scope exactly once", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-presentation-dispose-"));
	try {
		const result = await runProductionFixture(root, "enabled", true);
		assert.ok(result.presentation);
		assert.equal(result.persistedMessages, 1);
		assert.equal(result.counters.completedDispatchPresentationScopes, 1);
		assert.equal(result.counters.activeDispatchPresentationScopes, 0);
		assert.equal(result.counters.ownerDisposeCalls, 1);
		assert.equal(result.counters.releaseWithoutActiveScope, 0);
		assert.equal("toolResultPresentation" in result.persisted, false);
		assert.equal(result.presentation.modelContent, result.message.content);
		assert.equal(result.presentation.uiContent?.[0], result.message.content[0]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("budgeted production persists full UI content and resumes the identical provider projection", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-presentation-v2-production-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const fullText = "post-extension-provider-source-".repeat(4096);
	let extensionEventRetained: ToolResultMessageEndEvent | undefined;
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
				extensionEventRetained = event as ToolResultMessageEndEvent;
				return { message: { ...event.message, content: [{ type: "text", text: fullText }] } };
			});
		}],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: "presentation-v2-resume" });
	const counters = createToolResultPresentationCounters();
	const commonOptions = {
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: fixtureModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all" as const,
		toolResultPresentation: { enabled: true, budgetTokens: 128, counters },
	};
	try {
		const { session } = await createAgentSession(commonOptions);
		let retainedPresentation: ToolResultPresentationV2 | undefined;
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			if (event.toolResultPresentation?.version === 2) retainedPresentation = event.toolResultPresentation;
		});
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "presentation-v2-call",
			toolName: "read",
			content: [{ type: "text", text: "before-extension" }],
			isError: false,
			timestamp: 1,
		};
		session.agent.state.messages.push(message);
		await (session as unknown as {
			_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
		assert.ok(retainedPresentation);
		const retainedArtifact = retainedPresentation.artifact;
		assert.ok(retainedArtifact);
		assert.equal("toolResultPresentation" in extensionEventRetained!, false);
		assert.equal(message.content[0]?.type === "text" ? message.content[0].text : undefined, fullText);
		const persisted = sessionManager.getBranch().at(-1);
		assert.equal(persisted?.type, "message");
		assert.equal(
			persisted?.type === "message" && persisted.message.role === "toolResult" && persisted.message.content[0]?.type === "text"
				? persisted.message.content[0].text
				: undefined,
			fullText,
		);
		const providerMessages = await session.agent.convertToLlm(session.agent.state.messages.slice());
		const providerToolResult = providerMessages.find((candidate) => candidate.role === "toolResult");
		assert.ok(providerToolResult?.role === "toolResult");
		assert.deepEqual(providerToolResult.content, retainedPresentation.modelContent);
		assert.ok(estimateToolOutputTokens(providerToolResult.content).estimatedTokens <= 128);
		assert.ok(JSON.stringify(providerToolResult).length < fullText.length / 2);
		assert.equal("uiContent" in providerToolResult, false);
		assert.equal("toolResultPresentation" in providerToolResult, false);
		const firstChunk = session.readToolResultContinuation(retainedPresentation.continuation.cursor, 128);
		assert.ok(firstChunk.content.length > 0);
		assert.ok(firstChunk.estimatedTokens <= 128);
		const firstArtifact = session.readToolResultArtifact(retainedArtifact.id);
		assert.equal(firstArtifact.descriptor, retainedArtifact);
		assert.equal(firstArtifact.content, message.content);
		const firstProjection = providerToolResult.content;
		const firstCursor = retainedPresentation.continuation.cursor;
		const firstArtifactId = retainedArtifact.id;
		const firstArtifactSha256 = retainedArtifact.sha256;
		session.dispose();

		const { session: resumed } = await createAgentSession(commonOptions);
		try {
			const resumedMessages = await resumed.agent.convertToLlm(resumed.agent.state.messages.slice());
			const resumedToolResult = resumedMessages.find((candidate) => candidate.role === "toolResult");
			assert.ok(resumedToolResult?.role === "toolResult");
			assert.deepEqual(resumedToolResult.content, firstProjection);
			const resumedSource = resumed.agent.state.messages.find((candidate) => candidate.role === "toolResult");
			assert.ok(resumedSource?.role === "toolResult");
			const resumedArtifact = resumed.readToolResultArtifact(firstArtifactId);
			assert.equal(resumedArtifact.content, resumedSource.content);
			assert.equal(resumedArtifact.descriptor.id, firstArtifactId);
			assert.equal(resumedArtifact.descriptor.sha256, firstArtifactSha256);
			const resumedPresentationOwner = createToolResultPresentationOwner(
				{ enabled: true, budgetTokens: 128 },
				sessionManager.getSessionId(),
			)!;
			const replayedPresentation = resumedPresentationOwner.create(
				(resumed.agent.state.messages.find((candidate) => candidate.role === "toolResult") as ToolResultMessage).content,
				"presentation-v2-call",
			) as ToolResultPresentationV2;
			assert.equal(replayedPresentation.continuation.cursor, firstCursor);
			resumedPresentationOwner.release();
			resumedPresentationOwner.dispose();
		} finally {
			resumed.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("blocked-image provider projection keeps its cursor bound to the persisted source across toggles", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-presentation-blocked-image-source-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
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
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: "blocked-image-continuation" });
	const imageA = { type: "image" as const, data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", mimeType: "image/png" };
	const imageB = { type: "image" as const, data: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=", mimeType: "image/jpeg" };
	const sourceContent: ToolResultMessage["content"] = [{ type: "text", text: "head-".repeat(4) }];
	for (let imageIndex = 0; imageIndex < 24; imageIndex++) {
		sourceContent.push(imageA, { type: "text", text: `x${imageIndex}` });
	}
	sourceContent.push(
		{ type: "text", text: "middle-".repeat(4096) },
		imageB,
		{ type: "text", text: "tail-".repeat(4) },
	);
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "blocked-image-call",
		toolName: "read",
		content: sourceContent,
		isError: false,
		timestamp: 1,
	};
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
		toolResultPresentation: { enabled: true, budgetTokens: 256, counters },
	});
	let presentation: ToolResultPresentationV2 | undefined;
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult" && event.toolResultPresentation?.version === 2) {
			presentation = event.toolResultPresentation;
		}
	});
	function cursorFrom(content: ToolResultMessage["content"]): string {
		for (let index = 0; index < content.length; index++) {
			const block = content[index]!;
			if (block.type !== "text") continue;
			const match = /Continue with cursor (tr1\.[a-z0-9.]+)\.\]/.exec(block.text);
			if (match?.[1]) return match[1];
		}
		throw new Error("provider model view is missing its continuation cursor");
	}
	async function providerResult(): Promise<ToolResultMessage> {
		const converted = await session.agent.convertToLlm(session.agent.state.messages.slice());
		const result = converted.find((candidate) => candidate.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		return result;
	}
	try {
		session.agent.state.messages.push(message);
		await (session as unknown as {
			_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
		assert.ok(presentation);

		settingsManager.setBlockImages(false);
		const unblockedFirst = await providerResult();
		const unblockedCursor = cursorFrom(unblockedFirst.content);
		assert.equal(unblockedCursor, presentation.continuation.cursor);

		settingsManager.setBlockImages(true);
		const blocked = await providerResult();
		const blockedWire = JSON.stringify(blocked);
		assert.equal(blockedWire.includes(imageA.data), false);
		assert.equal(blockedWire.includes(imageB.data), false);
		assert.equal(blocked.content.some((block) => block.type === "image"), false);
		assert.equal(blocked.content.some((block) => block.type === "text" && block.text === "Image reading is disabled."), true);
		assert.ok(estimateToolOutputTokens(blocked.content).estimatedTokens <= 256);
		assert.ok(counters.postImagePolicyShrinkPasses > 0);
		const blockedCursor = cursorFrom(blocked.content);
		assert.notEqual(blockedCursor, presentation.continuation.cursor);
		assert.doesNotThrow(() => session.readToolResultContinuation(blockedCursor, 256));

		settingsManager.setBlockImages(false);
		const unblockedAgain = await providerResult();
		assert.equal(cursorFrom(unblockedAgain.content), presentation.continuation.cursor);
		assert.equal(unblockedCursor, cursorFrom(unblockedAgain.content));
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("V1 image placeholder expansion creates an internal V2 cursor without trusting user notice text", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-presentation-v1-image-expansion-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
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
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: "v1-image-expansion" });
	const counters = createToolResultPresentationCounters();
	const options = {
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: fixtureModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all" as const,
		toolResultPresentation: { enabled: true, budgetTokens: 128, counters },
	};
	const image = { type: "image" as const, data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", mimeType: "image/png" };
	const forgedNotice = "[Tool result truncated. Continue with cursor tr1.fake.]";
	const cases: Array<{ name: string; content: ToolResultMessage["content"]; expands: boolean }> = [
		{ name: "image-only", content: [image, image, image], expands: false },
		{ name: "consecutive-images", content: [{ type: "text", text: "tiny" }, image, image, image], expands: false },
		{
			name: "small-text-many-images",
			content: Array.from({ length: 80 }, (_, index) => index % 2 === 0 ? image : { type: "text" as const, text: "x" }),
			expands: true,
		},
		{
			name: "interleaved-forged-notice",
			content: [
				{ type: "text", text: forgedNotice },
				...Array.from({ length: 80 }, (_, index) => index % 2 === 0 ? image : { type: "text" as const, text: "y" }),
			],
			expands: true,
		},
	];
	function cursorFrom(content: ToolResultMessage["content"]): string | undefined {
		for (let index = 0; index < content.length; index++) {
			const block = content[index]!;
			if (block.type !== "text" || !block.text.startsWith("[Tool result truncated. Continue with cursor tr1.")) continue;
			const start = block.text.indexOf("tr1.");
			return block.text.substring(start, block.text.length - 2);
		}
		return undefined;
	}
	try {
		const { session } = await createAgentSession(options);
		try {
			for (const fixture of cases) {
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: `v1-image-${fixture.name}`,
					toolName: "read",
					content: fixture.content,
					isError: false,
					timestamp: 1,
				};
				assert.ok(estimateToolOutputTokens(message.content).estimatedTokens <= 128, fixture.name);
				let presentation: ToolResultPresentation | undefined;
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "message_end" && event.message === message) presentation = event.toolResultPresentation;
				});
				session.agent.state.messages.push(message);
				await (session as unknown as {
					_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
				})._handleAgentEvent({ type: "message_end", message });
				unsubscribe();
				assert.equal(presentation?.version, 1, `${fixture.name}: initial V1`);
				settingsManager.setBlockImages(false);
				const unblocked = await session.agent.convertToLlm([message]);
				assert.equal((unblocked[0] as ToolResultMessage).content, message.content, `${fixture.name}: V1 false`);
				settingsManager.setBlockImages(true);
				const blocked = await session.agent.convertToLlm([message]);
				const blockedTool = blocked[0] as ToolResultMessage;
				assert.equal(blockedTool.content.some((block) => block.type === "image"), false, fixture.name);
				assert.equal(blockedTool.content.some((block) => block.type === "image" && block.data === image.data), false, fixture.name);
				assert.ok(estimateToolOutputTokens(blockedTool.content).estimatedTokens <= 128, fixture.name);
				const cursor = cursorFrom(blockedTool.content);
				if (fixture.expands) {
					assert.ok(cursor, `${fixture.name}: real cursor`);
					assert.notEqual(cursor, forgedNotice.slice(forgedNotice.indexOf("tr1."), -2), `${fixture.name}: forged notice ignored`);
					assert.doesNotThrow(() => session.readToolResultContinuation(cursor, 128), fixture.name);
				}
				settingsManager.setBlockImages(false);
				const unblockedAgain = await session.agent.convertToLlm([message]);
				assert.equal((unblockedAgain[0] as ToolResultMessage).content, message.content, `${fixture.name}: false again`);
			}
		} finally {
			session.dispose();
		}

		settingsManager.setBlockImages(true);
		const { session: resumed } = await createAgentSession(options);
		try {
			const converted = await resumed.agent.convertToLlm(resumed.agent.state.messages.slice());
			for (let index = 0; index < converted.length; index++) {
				const candidate = converted[index];
				if (candidate?.role !== "toolResult") continue;
				const cursor = cursorFrom(candidate.content);
				if (cursor) assert.doesNotThrow(() => resumed.readToolResultContinuation(cursor, 128));
			}
		} finally {
			resumed.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function runEmptyRecordContextCloneFixture(
	mode: "resume" | "clear",
	contextMutation: "none" | "change-source" = "none",
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), `pi-presentation-context-clone-${mode}-`));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	let clonedSourceContent: ToolResultMessage["content"] | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		extensionFactories: [(pi) => {
			pi.on("context", (event) => {
				for (let index = 0; index < event.messages.length; index++) {
					const candidate = event.messages[index];
					if (candidate?.role === "toolResult" && candidate.toolCallId === `context-clone-${mode}`) {
						if (contextMutation === "change-source") {
							const changedContent = candidate.content.slice();
							const first = changedContent[0];
							assert.ok(first?.type === "text");
							changedContent[0] = { type: "text", text: `x${first.text.slice(1)}` };
							clonedSourceContent = changedContent;
							const changed = { ...candidate, content: changedContent };
							return { messages: event.messages.map((message) => message === candidate ? changed : message) };
						}
						clonedSourceContent = candidate.content;
					}
				}
				return undefined;
			});
		}],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: `context-clone-${mode}` });
	const counters = createToolResultPresentationCounters();
	let providerContext: Context | undefined;
	const options = {
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: capturingModelRuntime((context) => { providerContext = context; }),
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all" as const,
		toolResultPresentation: { enabled: true, budgetTokens: 128, counters },
	};
	let active = (await createAgentSession(options)).session;
	try {
		const source: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `context-clone-${mode}`,
			toolName: "read",
			content: [{ type: "text", text: `persisted-${mode}-`.repeat(20_000) }],
			isError: false,
			timestamp: 1,
		};
		active.agent.state.messages.push(source);
		await (active as unknown as {
			_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message: source });
		if (mode === "resume") {
			active.dispose();
			active = (await createAgentSession(options)).session;
		} else {
			(active as unknown as {
				_toolResultPresentation?: { clearProjectionRecords(): void };
			})._toolResultPresentation?.clearProjectionRecords();
		}
		await active.prompt("continue", { expandPromptTemplates: false });
		assert.ok(providerContext);
		const providerResult = providerContext.messages.find((message) =>
			message.role === "toolResult" && message.toolCallId === source.toolCallId
		);
		const activeSource = active.agent.state.messages.find((message) =>
			message.role === "toolResult" && message.toolCallId === source.toolCallId
		);
		assert.ok(providerResult?.role === "toolResult");
		assert.ok(activeSource?.role === "toolResult");
		assert.ok(clonedSourceContent);
		assert.notEqual(clonedSourceContent, activeSource.content);
		const cursor = providerCursorFrom(providerResult.content);
		const scansBefore = counters.fullSourceEstimatorScans;
		const probesBefore = counters.continuationSourceLookupProbes;
		assert.equal(counters.projectionRecordEntries, 0, "provider-only clone remains transient");
		if (contextMutation === "change-source") {
			assert.throws(
				() => active.readToolResultContinuation(cursor, 128),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-cursor",
			);
			assert.equal(counters.projectionRecordEntries, 0, "modified provider source is not rebound");
			return;
		}
		const chunk = active.readToolResultContinuation(cursor, 128);
		assert.ok(chunk.content.length > 0);
		assert.ok(chunk.estimatedTokens <= 128);
		assert.ok(chunk.nextCursor);
		assert.equal(counters.fullSourceEstimatorScans - scansBefore, 1, "first continuation scans the persisted source once");
		assert.equal(
			counters.continuationSourceLookupProbes - probesBefore,
			active.agent.state.messages.length,
			"first continuation checks the active history once",
		);
		assert.equal(counters.projectionRecordEntries, 1, "validated persisted source becomes resident");
		const steadyScans = counters.fullSourceEstimatorScans;
		const steadyProbes = counters.continuationSourceLookupProbes;
		const steadyHits = counters.continuationSourceRecordHits;
		const second = active.readToolResultContinuation(chunk.nextCursor, 128);
		assert.ok(second.content.length > 0);
		assert.equal(counters.fullSourceEstimatorScans, steadyScans, "resident continuation avoids source rescans");
		assert.equal(counters.continuationSourceLookupProbes, steadyProbes, "indexed continuation avoids history rescans");
		assert.equal(counters.continuationSourceRecordHits, steadyHits + 1);
	} finally {
		active.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

test("resumed production context clones bind provider cursors to the persisted source", async () => {
	await runEmptyRecordContextCloneFixture("resume");
});

test("record-cleared production context clones bind provider cursors to the persisted source", async () => {
	await runEmptyRecordContextCloneFixture("clear");
});

test("modified production context clones cannot bind to the persisted source", async () => {
	await runEmptyRecordContextCloneFixture("clear", "change-source");
});

test("real transformContext to convertToLlm order enforces a source-ordered turn envelope", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-contextual-turn-budget-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
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
			pi.on("context", () => undefined);
		}],
	});
	await resourceLoader.reload();
	let providerContext: Context | undefined;
	const counters = createToolResultPresentationCounters();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: capturingModelRuntime((context) => { providerContext = context; }),
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd, { id: "contextual-turn-budget" }),
		resourceLoader,
		noTools: "all",
		toolResultPresentation: { enabled: true, budgetTokens: 1_024, counters },
	});
	try {
		const toolCallIds = ["contextual-a", "contextual-b"];
		const assistant: AssistantMessage = {
			role: "assistant",
			content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "fixture", arguments: {} })),
			api: "openai-responses",
			provider: "fixture",
			model: fixtureModel().id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		session.agent.state.messages.push(assistant);
		const canonical: ToolResultMessage[] = toolCallIds.map((toolCallId, index) => ({
			role: "toolResult",
			toolCallId,
			toolName: "fixture",
			content: [{ type: "text", text: `${index}-abcdefgh `.repeat(160) }],
			isError: false,
			timestamp: index + 2,
		}));
		for (const result of canonical) {
			session.agent.state.messages.push(result);
			await (session as unknown as {
				_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message: result });
		}
		await session.prompt("continue", { expandPromptTemplates: false });
		assert.ok(providerContext);
		const providerResults = providerContext.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		assert.equal(providerResults.length, 2);
		let totalTokens = 0;
		for (const result of providerResults) {
			totalTokens += estimateToolOutputTokens(result.content).estimatedTokens;
			const cursor = providerCursorFrom(result.content);
			assert.ok(session.readToolResultContinuation(cursor, 128).content.length > 0);
		}
		assert.ok(totalTokens <= 1_024);
		assert.equal(counters.contextualBudgetCalls, 1);
		assert.equal(counters.contextualTurnResults, 2);
		assert.equal(counters.activeContextualCoordinators, 0);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("provider request preview uses the same contextual turn envelope", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-contextual-provider-preview-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
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
		extensionFactories: [(pi) => { pi.on("context", () => undefined); }],
	});
	await resourceLoader.reload();
	const counters = createToolResultPresentationCounters();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: codexFixtureModel(),
		modelRuntime: fixtureModelRuntime(),
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd, { id: "contextual-provider-preview" }),
		resourceLoader,
		noTools: "all",
		toolResultPresentation: { enabled: true, budgetTokens: 1_024, counters },
	});
	try {
		const ids = ["preview-a", "preview-b"];
		const assistant: AssistantMessage = {
			role: "assistant",
			content: ids.map((id) => ({ type: "toolCall", id, name: "fixture", arguments: {} })),
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: codexFixtureModel().id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		};
		const results: ToolResultMessage[] = ids.map((toolCallId, index) => ({
			role: "toolResult",
			toolCallId,
			toolName: "fixture",
			content: [{ type: "text", text: `${index}-preview-output `.repeat(400) }],
			isError: false,
			timestamp: index + 2,
		}));
		session.agent.state.messages.push(assistant, ...results);
		for (const result of results) {
			await (session as unknown as {
				_handleAgentEvent(event: ToolResultMessageEndEvent): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message: result });
		}
		const payload = await session.buildProviderRequestPayload({
			systemPrompt: "system",
			messages: session.agent.state.messages,
		});
		assert.ok(payload);
		const input = payload.input as Array<{ type?: string; output?: unknown }>;
		const outputs = input.filter((item) => item.type === "function_call_output");
		assert.equal(outputs.length, 2);
		let totalTokens = 0;
		for (const item of outputs) {
			assert.equal(typeof item.output, "string");
			totalTokens += estimateToolOutputTokens([{ type: "text", text: item.output as string }]).estimatedTokens;
		}
		assert.ok(totalTokens <= 1_024);
		assert.equal(counters.contextualBudgetCalls, 1);
		assert.equal(counters.contextualTurnResults, 2);
		assert.equal(counters.activeContextualCoordinators, 0);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
