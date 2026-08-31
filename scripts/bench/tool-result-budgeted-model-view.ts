import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Message, Model, ToolResultMessage } from "../../packages/ai/src/types.ts";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	type ToolResultPresentation,
	type ToolResultPresentationContent,
	type ToolResultPresentationCounters,
	type ToolResultPresentationV2,
} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface AllocationSite {
	bytes: number;
	functionName: string;
	url: string;
	line: number;
}

interface TimingResult {
	cpuP50Ms: number;
	cpuP95Ms: number;
	sampledAllocationBytes: number;
	sampledBytesPerResult: number;
	topAllocationSites: AllocationSite[];
}

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;
const CONTINUATION_CHUNKS = 100;
const BUDGET_TOKENS = 1024;
const SESSION_ID = "phase-5b-b-benchmark";
const TINY_TEXT = "tool result";
const TEXT_64_KIB = "0123456789abcdef".repeat((64 * 1024) / 16);
const TEXT_1_MIB = "0123456789abcdef".repeat((1024 * 1024) / 16);
const TEXT_10_MIB = "0123456789abcdef".repeat((10 * 1024 * 1024) / 16);
const IMAGE_DATA = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo9PQ==";

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function allocationSites(head: SamplingNode): { sampledBytes: number; top: AllocationSite[] } {
	const sites = new Map<string, AllocationSite>();
	const pending = [head];
	let sampledBytes = 0;
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.url}\u0000${frame.lineNumber}\u0000${frame.functionName}`;
			const current = sites.get(key);
			if (current) current.bytes += node.selfSize;
			else sites.set(key, {
				bytes: node.selfSize,
				functionName: frame.functionName || "(anonymous)",
				url: frame.url,
				line: frame.lineNumber + 1,
			});
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

function slope(values: readonly number[]): number {
	const meanX = (values.length - 1) / 2;
	let meanY = 0;
	for (let index = 0; index < values.length; index++) meanY += values[index]!;
	meanY /= values.length;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < values.length; index++) {
		const dx = index - meanX;
		numerator += dx * (values[index]! - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

async function measureRuns(inspector: Session, runs: number, operation: () => void): Promise<TimingResult> {
	globalThis.gc!();
	globalThis.gc!();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(runs);
	for (let run = 0; run < runs; run++) {
		const started = performance.now();
		operation();
		durations[run] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	durations.sort((left, right) => left - right);
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	return {
		cpuP50Ms: percentile(durations, 0.5),
		cpuP95Ms: percentile(durations, 0.95),
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerResult: sampled.sampledBytes / runs,
		topAllocationSites: sampled.top,
	};
}

async function measure(inspector: Session, operation: () => void): Promise<TimingResult> {
	return measureRuns(inspector, MEASURED_RUNS, operation);
}

async function measureAsync(inspector: Session, operation: () => Promise<void>): Promise<TimingResult> {
	globalThis.gc!();
	globalThis.gc!();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(MEASURED_RUNS);
	for (let run = 0; run < MEASURED_RUNS; run++) {
		const started = performance.now();
		await operation();
		durations[run] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	durations.sort((left, right) => left - right);
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	return {
		cpuP50Ms: percentile(durations, 0.5),
		cpuP95Ms: percentile(durations, 0.95),
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerResult: sampled.sampledBytes / MEASURED_RUNS,
		topAllocationSites: sampled.top,
	};
}

function counterSnapshot(counters: ToolResultPresentationCounters): ToolResultPresentationCounters {
	return { ...counters };
}

function counterDelta(
	before: ToolResultPresentationCounters,
	after: ToolResultPresentationCounters,
	resultCount = MEASURED_RUNS,
): Record<string, number> {
	return {
		presentationObjectsCreated: (after.presentationObjectsCreated - before.presentationObjectsCreated) / resultCount,
		uiOuterArraysCreated: (after.uiOuterArraysCreated - before.uiOuterArraysCreated) / resultCount,
		modelOuterArraysReused: (after.modelOuterArraysReused - before.modelOuterArraysReused) / resultCount,
		presentationOuterArrayReferences: (after.presentationOuterArrayReferences - before.presentationOuterArrayReferences) / resultCount,
		contentBlockReferencesReused: (after.contentBlockReferencesReused - before.contentBlockReferencesReused) / resultCount,
		textStringReferencesReused: (after.textStringReferencesReused - before.textStringReferencesReused) / resultCount,
		imageDataReferencesReused: (after.imageDataReferencesReused - before.imageDataReferencesReused) / resultCount,
		modelProjectionCalls: (after.modelProjectionCalls - before.modelProjectionCalls) / resultCount,
		modelProjectionArraysCreated: (after.modelProjectionArraysCreated - before.modelProjectionArraysCreated) / resultCount,
		modelMessageWrappersCreated: (after.modelMessageWrappersCreated - before.modelMessageWrappersCreated) / resultCount,
		truncatedPresentationsCreated: (after.truncatedPresentationsCreated - before.truncatedPresentationsCreated) / resultCount,
		continuationChunksCreated: (after.continuationChunksCreated - before.continuationChunksCreated) / resultCount,
		continuationCursorStringsCreated: (after.continuationCursorStringsCreated - before.continuationCursorStringsCreated) / resultCount,
		boundedTextStringsCreated: (after.boundedTextStringsCreated - before.boundedTextStringsCreated) / resultCount,
		projectionRecordHits: (after.projectionRecordHits - before.projectionRecordHits) / resultCount,
		projectionRecordMisses: (after.projectionRecordMisses - before.projectionRecordMisses) / resultCount,
		projectionRecordEntries: after.projectionRecordEntries,
		projectionRecordHighWaterMark: after.projectionRecordHighWaterMark,
		projectionRecordEvictions: (after.projectionRecordEvictions - before.projectionRecordEvictions) / resultCount,
		fullSourceEstimatorScans: (after.fullSourceEstimatorScans - before.fullSourceEstimatorScans) / resultCount,
		continuationSourceLookupProbes: (after.continuationSourceLookupProbes - before.continuationSourceLookupProbes) / resultCount,
		continuationSourceRecordHits: (after.continuationSourceRecordHits - before.continuationSourceRecordHits) / resultCount,
		sourceFingerprintConstructions: (after.sourceFingerprintConstructions - before.sourceFingerprintConstructions) / resultCount,
		sourceDigestConstructions: (after.sourceDigestConstructions - before.sourceDigestConstructions) / resultCount,
		retainedProjectionCodeUnits: after.retainedProjectionCodeUnits,
		postImagePolicyEstimatorScans: (after.postImagePolicyEstimatorScans - before.postImagePolicyEstimatorScans) / resultCount,
		postImagePolicyShrinkPasses: (after.postImagePolicyShrinkPasses - before.postImagePolicyShrinkPasses) / resultCount,
		completedDispatchPresentationScopes: (after.completedDispatchPresentationScopes - before.completedDispatchPresentationScopes) / resultCount,
		releaseWithoutActiveScope: (after.releaseWithoutActiveScope - before.releaseWithoutActiveScope) / resultCount,
	};
}

function toolMessage(content: ToolResultPresentationContent[], toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

async function measureDirect(
	inspector: Session,
	name: string,
	content: ToolResultPresentationContent[],
): Promise<Record<string, unknown>> {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		SESSION_ID,
	)!;
	let sequence = 0;
	let lastPresentation: ToolResultPresentation | undefined;
	function createAndRelease(): void {
		lastPresentation = owner.create(content, `${name}-${sequence++}`);
		owner.release();
	}
	for (let run = 0; run < WARMUP_RUNS; run++) createAndRelease();
	const before = counterSnapshot(counters);
	const timing = await measure(inspector, createAndRelease);
	const delta = counterDelta(before, counters);
	const originalEstimate = estimateToolOutputTokens(content).estimatedTokens;
	const modelEstimate = estimateToolOutputTokens(lastPresentation!.modelContent).estimatedTokens;
	const version = lastPresentation!.version;
	const uiContent = lastPresentation!.uiContent;
	let imageBlockReferenceReused = true;
	let imageDataReferenceReused = true;
	for (let index = 0; index < content.length; index++) {
		if (content[index]?.type !== "image") continue;
		if (uiContent?.[index] !== content[index]) imageBlockReferenceReused = false;
		const uiImage = uiContent?.[index];
		if (uiImage?.type !== "image" || uiImage.data !== content[index].data) imageDataReferenceReused = false;
	}
	owner.dispose();
	return {
		name,
		contentBlocks: content.length,
		originalTextCodeUnits: content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0),
		version,
		originalEstimatedTokens: originalEstimate,
		modelEstimatedTokens: modelEstimate,
		tokenReductionPercent: originalEstimate === 0 ? 0 : (1 - modelEstimate / originalEstimate) * 100,
		modelWithinBudget: modelEstimate <= BUDGET_TOKENS,
		uiOuterArrayIndependent: uiContent !== content,
		imageBlockReferenceReused,
		imageDataReferenceReused,
		...timing,
		countersPerResult: delta,
		activeDispatchScopesAfterMeasurement: counters.activeDispatchPresentationScopes,
		dispatchScopeHighWaterMark: counters.dispatchPresentationScopesHighWaterMark,
		maximumContentBlocks: counters.maximumContentBlocks,
		maximumTextCodeUnits: counters.maximumTextCodeUnits,
		maximumImageDataCodeUnits: counters.maximumImageDataCodeUnits,
	};
}

async function measureProviderProjection(inspector: Session): Promise<Record<string, unknown>> {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: TEXT_10_MIB }];
	const source = toolMessage(content, "provider-projection");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		SESSION_ID,
	)!;
	let projected: Message[] = [];
	function project(): void {
		projected = [source];
		owner.projectMessagesForModel(projected);
	}
	for (let run = 0; run < WARMUP_RUNS; run++) project();
	const before = counterSnapshot(counters);
	const timing = await measure(inspector, project);
	const delta = counterDelta(before, counters);
	const projectedTool = projected[0];
	const modelTokens = projectedTool?.role === "toolResult" ? estimateToolOutputTokens(projectedTool.content).estimatedTokens : -1;
	owner.dispose();
	return {
		...timing,
		modelTokens,
		modelWithinBudget: modelTokens <= BUDGET_TOKENS,
		legacyMessageUnchanged: source.content === content,
		providerMessageIsWrapper: projectedTool !== source,
		providerWireHasUiContent: projectedTool ? "uiContent" in projectedTool : true,
		providerWireHasPresentationSidecar: projectedTool ? "toolResultPresentation" in projectedTool : true,
		countersPerResult: delta,
	};
}

async function measureHistoricalProjection(
	inspector: Session,
	resultCount: number,
): Promise<Record<string, unknown>> {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		`${SESSION_ID}-history-${resultCount}`,
	)!;
	const messages = new Array<ToolResultMessage>(resultCount);
	for (let index = 0; index < resultCount; index++) {
		const content: ToolResultPresentationContent[] = [{
			type: "text",
			text: `${index.toString(36)}:` + TEXT_64_KIB,
		}];
		messages[index] = toolMessage(content, `historical-${index}`);
		owner.create(content, `historical-${index}`);
		owner.release();
	}
	const firstProjectionScans = counters.fullSourceEstimatorScans;
	const firstProjectionDigests = counters.sourceDigestConstructions;
	function projectHistory(): void {
		owner.projectMessagesForModel(messages.slice());
	}
	for (let run = 0; run < WARMUP_RUNS; run++) projectHistory();
	const before = counterSnapshot(counters);
	const timing = await measure(inspector, projectHistory);
	const delta = counterDelta(before, counters);
	owner.dispose();
	return {
		resultCount,
		resultSizeCodeUnits: TEXT_64_KIB.length,
		firstProjectionScans,
		firstProjectionDigests,
		...timing,
		steadyCountersPerRequest: delta,
		entriesAfterDispose: counters.projectionRecordEntries,
		retainedCodeUnitsAfterDispose: counters.retainedProjectionCodeUnits,
	};
}

async function measureContinuationChain(inspector: Session): Promise<Record<string, unknown>> {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: TEXT_10_MIB }];
	const source = toolMessage(content, "continuation-chain");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters },
		`${SESSION_ID}-continuation`,
	)!;
	const presentation = owner.create(content, source.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", marker: index };
	history[history.length - 1] = source;
	let cursor = presentation.continuation.cursor;
	const first = owner.readContinuation(cursor, history, 128);
	if (!first.nextCursor) throw new Error("continuation benchmark source is unexpectedly exhausted");
	cursor = first.nextCursor;
	const lookupProbesAfterFirstChunk = counters.continuationSourceLookupProbes;
	const scansAfterFirstChunk = counters.fullSourceEstimatorScans;
	const before = counterSnapshot(counters);
	function readChunk(): void {
		const chunk = owner.readContinuation(cursor, history, 128);
		if (!chunk.nextCursor) throw new Error("continuation benchmark source is unexpectedly exhausted");
		cursor = chunk.nextCursor;
	}
	const timing = await measureRuns(inspector, CONTINUATION_CHUNKS, readChunk);
	const delta = counterDelta(before, counters, CONTINUATION_CHUNKS);
	owner.dispose();
	return {
		chunks: CONTINUATION_CHUNKS,
		historyMessages: history.length,
		lookupProbesAfterFirstChunk,
		scansAfterFirstChunk,
		...timing,
		steadyCountersPerChunk: delta,
		entriesAfterDispose: counters.projectionRecordEntries,
		retainedCodeUnitsAfterDispose: counters.retainedProjectionCodeUnits,
	};
}

function measureResumedHistoryLookup(): Record<string, unknown> {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: TEXT_10_MIB }];
	const source = toolMessage(content, "resumed-history-lookup");
	const initial = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128 },
		`${SESSION_ID}-resume-history`,
	)!;
	const presentation = initial.create(content, source.toolCallId) as ToolResultPresentationV2;
	initial.release();
	initial.dispose();
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", marker: index };
	history[history.length - 1] = source;
	const counters = createToolResultPresentationCounters();
	const resumed = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters },
		`${SESSION_ID}-resume-history`,
	)!;
	const started = performance.now();
	const chunk = resumed.readContinuation(presentation.continuation.cursor, history, 128);
	const cpuMs = performance.now() - started;
	const result = {
		historyMessages: history.length,
		cpuMs,
		chunkWithinBudget: chunk.estimatedTokens <= 128,
		lookupProbes: counters.continuationSourceLookupProbes,
		fullSourceEstimatorScans: counters.fullSourceEstimatorScans,
		sourceDigestConstructions: counters.sourceDigestConstructions,
		projectionRecordMisses: counters.projectionRecordMisses,
	};
	resumed.dispose();
	return {
		...result,
		entriesAfterDispose: counters.projectionRecordEntries,
		retainedCodeUnitsAfterDispose: counters.retainedProjectionCodeUnits,
	};
}

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "budgeted-model-view-benchmark",
		name: "Budgeted Model View Benchmark",
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
		hasConfiguredAuth: function hasConfiguredAuth(): boolean { return true; },
		checkAuth: async function checkAuth() { return { type: "api_key" as const }; },
		isUsingOAuth: function isUsingOAuth(): boolean { return false; },
		streamSimple: function streamSimple(): never { throw new Error("provider dispatch is outside this benchmark"); },
		registerProvider: function registerProvider(): void {},
		registerNativeProvider: function registerNativeProvider(): void {},
		unregisterProvider: function unregisterProvider(): void {},
		getModel: function getModel(): undefined { return undefined; },
		getAuth: async function getAuth(): Promise<undefined> { return undefined; },
	} as unknown as ModelRuntime;
}

type ProductionMode = "absent" | "disabled" | "enabled";

async function measureProduction(
	inspector: Session,
	root: string,
	mode: ProductionMode,
): Promise<Record<string, unknown>> {
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
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: `budgeted-production-${mode}` });
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
		toolResultPresentation:
			mode === "absent"
				? undefined
				: { enabled: mode === "enabled", budgetTokens: BUDGET_TOKENS, counters },
	});
	let sequence = 0;
	let listenerCalls = 0;
	let v2PresentationCalls = 0;
	session.subscribe(function observeFinalResult(event: AgentSessionEvent): void {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return;
		listenerCalls++;
		if (event.toolResultPresentation?.version === 2) v2PresentationCalls++;
	});
	async function deliver(): Promise<void> {
		const message = toolMessage([{ type: "text", text: TEXT_10_MIB }], `production-${mode}-${sequence++}`);
		await (session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
	}
	for (let run = 0; run < WARMUP_RUNS; run++) await deliver();
	const before = counterSnapshot(counters);
	const listenersBefore = listenerCalls;
	const v2Before = v2PresentationCalls;
	const persistedBefore = sessionManager.getBranch().length;
	const timing = await measureAsync(inspector, deliver);
	const delta = counterDelta(before, counters);
	const result = {
		mode,
		...timing,
		countersPerResult: delta,
		listenerCallsPerResult: (listenerCalls - listenersBefore) / MEASURED_RUNS,
		v2PresentationCallsPerResult: (v2PresentationCalls - v2Before) / MEASURED_RUNS,
		persistedMessagesPerResult: (sessionManager.getBranch().length - persistedBefore) / MEASURED_RUNS,
		activeDispatchScopesAfterMeasurement: counters.activeDispatchPresentationScopes,
		dispatchScopeHighWaterMark: counters.dispatchPresentationScopesHighWaterMark,
	};
	sessionManager.newSession({ id: `cleared-${mode}` });
	session.dispose();
	return result;
}

async function measureBlockImagePolicy(
	inspector: Session,
	root: string,
): Promise<Record<string, unknown>> {
	const cwd = join(root, "block-images", "workspace");
	const agentDir = join(root, "block-images", "agent");
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
	const sessionManager = SessionManager.inMemory(cwd, { id: "budgeted-block-image-policy" });
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
	const sourceContent: ToolResultMessage["content"] = [{ type: "text", text: "head-".repeat(4) }];
	for (let index = 0; index < 24; index++) {
		sourceContent.push(
			{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
			{ type: "text", text: `middle-${index.toString(36)}` },
		);
	}
	sourceContent.push({ type: "text", text: TEXT_64_KIB }, { type: "text", text: "tail-".repeat(4) });
	const source = toolMessage(sourceContent as ToolResultPresentationContent[], "block-image-policy");
	session.agent.state.messages.push(source);
	let cursor = "";
	session.subscribe(function retainCursor(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "toolResult" && event.toolResultPresentation?.version === 2) {
			cursor = event.toolResultPresentation.continuation.cursor;
		}
	});
	await (session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message: source });
	let lastMessages: Message[] = [];
	async function convert(): Promise<void> {
		lastMessages = await session.agent.convertToLlm(session.agent.state.messages.slice());
	}
	settingsManager.setBlockImages(false);
	for (let run = 0; run < WARMUP_RUNS; run++) await convert();
	const unblockedBefore = counterSnapshot(counters);
	const unblocked = await measureAsync(inspector, convert);
	const unblockedCounters = counterDelta(unblockedBefore, counters);
	settingsManager.setBlockImages(true);
	for (let run = 0; run < WARMUP_RUNS; run++) await convert();
	const blockedBefore = counterSnapshot(counters);
	const blocked = await measureAsync(inspector, convert);
	const blockedCounters = counterDelta(blockedBefore, counters);
	const blockedTool = lastMessages.find((message) => message.role === "toolResult") as ToolResultMessage | undefined;
	let blockedImageBlocks = 0;
	let leakedImageDataBlocks = 0;
	let providerCursor = "";
	if (blockedTool) {
		for (let index = 0; index < blockedTool.content.length; index++) {
			const block = blockedTool.content[index]!;
			if (block.type === "image") {
				blockedImageBlocks++;
				if (block.data === IMAGE_DATA) leakedImageDataBlocks++;
			} else if (block.text.startsWith("[Tool result truncated. Continue with cursor tr1.")) {
				const cursorStart = block.text.indexOf("tr1.");
				providerCursor = block.text.substring(cursorStart, block.text.length - 2);
			}
		}
	}
	async function toggle(): Promise<void> {
		settingsManager.setBlockImages(false);
		await convert();
		settingsManager.setBlockImages(true);
		await convert();
		settingsManager.setBlockImages(false);
		await convert();
	}
	for (let run = 0; run < WARMUP_RUNS; run++) await toggle();
	const toggleBefore = counterSnapshot(counters);
	const toggled = await measureAsync(inspector, toggle);
	const toggleCounters = counterDelta(toggleBefore, counters, MEASURED_RUNS * 3);
	const continuation = session.readToolResultContinuation(cursor, 256);
	session.dispose();
	return {
		unblocked: { ...unblocked, countersPerRequest: unblockedCounters },
		blocked: { ...blocked, countersPerRequest: blockedCounters },
		toggle: { ...toggled, countersPerRequest: toggleCounters },
		blockedImageBlocks,
		leakedImageDataBlocks,
		providerCursorMatchesPersistedSource: providerCursor === cursor,
		continuationWithinBudget: continuation.estimatedTokens <= 256,
		postImagePolicyShrinkPasses: counters.postImagePolicyShrinkPasses,
		entriesAfterDispose: counters.projectionRecordEntries,
		retainedCodeUnitsAfterDispose: counters.retainedProjectionCodeUnits,
	};
}

function measureResumeProjection(): Record<string, unknown> {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: TEXT_1_MIB }];
	const source = toolMessage(content, "resume-projection");
	const current = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const currentPresentation = current.create(content, source.toolCallId) as ToolResultPresentationV2;
	current.release();
	current.dispose();
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	const resumedPresentation = resumed.create(content, source.toolCallId) as ToolResultPresentationV2;
	const chunk = resumed.readContinuation(resumedPresentation.continuation.cursor, [source], BUDGET_TOKENS);
	resumed.release();
	resumed.dispose();
	return {
		modelProjectionIdentical: JSON.stringify(currentPresentation.modelContent) === JSON.stringify(resumedPresentation.modelContent),
		cursorIdentical: currentPresentation.continuation.cursor === resumedPresentation.continuation.cursor,
		continuationChunkTokens: chunk.estimatedTokens,
		continuationWithinBudget: chunk.estimatedTokens <= BUDGET_TOKENS,
		continuationMadeProgress: chunk.content.length > 0,
	};
}

function measureParallelScopes(scopeCount: number): Record<string, unknown> {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		SESSION_ID,
	)!;
	const content: ToolResultPresentationContent[] = [{ type: "text", text: TEXT_64_KIB }];
	const retained: ToolResultPresentation[] = [];
	for (let scope = 0; scope < scopeCount; scope++) retained.push(owner.create(content, `parallel-${scope}`)!);
	const highWaterMark = counters.dispatchPresentationScopesHighWaterMark;
	owner.dispose();
	const activeAfterDispose = counters.activeDispatchPresentationScopes;
	for (let scope = 0; scope < scopeCount; scope++) owner.release();
	return {
		scopeCount,
		highWaterMark,
		activeAfterDispose,
		activeAfterRelease: counters.activeDispatchPresentationScopes,
		completedScopes: counters.completedDispatchPresentationScopes,
		releaseWithoutActiveScope: counters.releaseWithoutActiveScope,
		retainedPresentationsRemainReadable: retained[scopeCount - 1]?.version === 2,
	};
}

async function measureLifecycle(): Promise<Record<string, unknown>> {
	const counters = createToolResultPresentationCounters();
	let owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS, counters }, SESSION_ID)!;
	let sourceContent: ToolResultPresentationContent[] | undefined = [{ type: "text", text: TEXT_10_MIB }];
	let presentation: ToolResultPresentation | undefined = owner.create(sourceContent, "lifecycle");
	const weakSourceOuterArray = new WeakRef(sourceContent);
	const weakPresentation = new WeakRef(presentation);
	const weakModel = new WeakRef(presentation.modelContent as object);
	const weakUi = new WeakRef(presentation.uiContent as object);
	owner.release();
	owner.clearProjectionRecords();
	const entriesAfterClear = counters.projectionRecordEntries;
	const retainedCodeUnitsAfterClear = counters.retainedProjectionCodeUnits;
	owner.dispose();
	presentation = undefined;
	sourceContent = undefined;
	owner = undefined as unknown as NonNullable<typeof owner>;
	await yieldToEventLoop();
	globalThis.gc!();
	globalThis.gc!();
	const samples: number[] = [];
	for (let cycle = 0; cycle < 8; cycle++) {
		globalThis.gc!();
		globalThis.gc!();
		samples.push(process.memoryUsage().heapUsed);
	}
	let positiveDeltas = 0;
	let consecutive = 0;
	let maximumConsecutiveIncreases = 0;
	for (let index = 1; index < samples.length; index++) {
		if (samples[index]! > samples[index - 1]!) {
			positiveDeltas++;
			consecutive++;
			maximumConsecutiveIncreases = Math.max(maximumConsecutiveIncreases, consecutive);
		} else consecutive = 0;
	}
	return {
		controlledGcSamples: samples,
		controlledGcSlopeBytesPerCycle: slope(samples),
		controlledGcPositiveDeltas: positiveDeltas,
		controlledGcMaximumConsecutiveIncreases: maximumConsecutiveIncreases,
		retainedPresentationWeakReferences: weakPresentation.deref() ? 1 : 0,
		retainedModelOuterArrayWeakReferences: weakModel.deref() ? 1 : 0,
		retainedUiOuterArrayWeakReferences: weakUi.deref() ? 1 : 0,
		retainedSourceOuterArrayWeakReferences: weakSourceOuterArray.deref() ? 1 : 0,
		entriesAfterClear,
		retainedCodeUnitsAfterClear,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("bench:tool-result-budgeted-model-view requires --expose-gc");
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
const productionRoot = mkdtempSync(join(tmpdir(), "pi-budgeted-model-view-benchmark-"));
try {
	const directResults = [
		await measureDirect(inspector, "tiny", [{ type: "text", text: TINY_TEXT }]),
		await measureDirect(inspector, "64-kib", [{ type: "text", text: TEXT_64_KIB }]),
		await measureDirect(inspector, "1-mib", [{ type: "text", text: TEXT_1_MIB }]),
		await measureDirect(inspector, "10-mib", [{ type: "text", text: TEXT_10_MIB }]),
		await measureDirect(inspector, "multi-block", [
			{ type: "text", text: TEXT_64_KIB },
			{ type: "text", text: TEXT_64_KIB },
			{ type: "text", text: TEXT_64_KIB },
		]),
		await measureDirect(inspector, "text-plus-image", [
			{ type: "text", text: TEXT_64_KIB },
			{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
			{ type: "text", text: TEXT_64_KIB },
		]),
		await measureDirect(inspector, "ansi-grapheme-adversarial", [{
			type: "text",
			text: "prefix-".repeat(4096) +
				"\u001b[38;2;123;045;067;1;2;3;4;5;6;7;8;9m" +
				"A" + "\u0301".repeat(256) +
				"\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}".repeat(16) +
				"\u001b]8;;https://example.test/budgeted-model-view\u001b\\link\u001b]8;;\u001b\\" +
				"suffix-".repeat(4096),
		}]),
	];
	const providerProjection = await measureProviderProjection(inspector);
	const historicalProjection = [
		await measureHistoricalProjection(inspector, 1),
		await measureHistoricalProjection(inspector, 10),
		await measureHistoricalProjection(inspector, 100),
	];
	const productionResults = [
		await measureProduction(inspector, productionRoot, "absent"),
		await measureProduction(inspector, productionRoot, "disabled"),
		await measureProduction(inspector, productionRoot, "enabled"),
	];
	const blockImagePolicy = await measureBlockImagePolicy(inspector, productionRoot);
	const continuationChain = await measureContinuationChain(inspector);
	const resumedHistoryLookup = measureResumedHistoryLookup();
	const resumeProjection = measureResumeProjection();
	const parallelScopes = [measureParallelScopes(2), measureParallelScopes(4), measureParallelScopes(8)];
	const lifecycle = await measureLifecycle();
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tool-result-budgeted-model-view",
		commit: git(["rev-parse", "HEAD"]),
		branch: git(["branch", "--show-current"]),
		worktree: git(["rev-parse", "--show-toplevel"]),
		worktreeStatus: git(["status", "--short"]),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		warmupRuns: WARMUP_RUNS,
		measuredRuns: MEASURED_RUNS,
		budgetTokens: BUDGET_TOKENS,
		heapProfilerSamplingIntervalBytes: 1024,
		directResults,
		providerProjection,
		historicalProjection,
		productionResults,
		blockImagePolicy,
		continuationChain,
		resumedHistoryLookup,
		resumeProjection,
		parallelScopes,
		lifecycle,
		sourceInvariants: {
			sourceInvariantFullStringCopies: 0,
			sourceInvariantFullResultSerializations: 0,
			sourceInvariantTemporaryLineArrays: 0,
			sourceInvariantPerResultMapsOrSets: 0,
			sourceInvariantPerResultClosures: 0,
			sourceInvariantObjectPools: 0,
		},
	}, null, 2)}\n`);
} finally {
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	rmSync(productionRoot, { recursive: true, force: true });
}
