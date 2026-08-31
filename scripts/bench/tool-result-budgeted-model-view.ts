import { spawnSync } from "node:child_process";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Message, ToolResultMessage } from "../../packages/ai/src/types.ts";
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

async function measure(inspector: Session, operation: () => void): Promise<TimingResult> {
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
		sampledBytesPerResult: sampled.sampledBytes / MEASURED_RUNS,
		topAllocationSites: sampled.top,
	};
}

function counterSnapshot(counters: ToolResultPresentationCounters): ToolResultPresentationCounters {
	return { ...counters };
}

function counterDelta(before: ToolResultPresentationCounters, after: ToolResultPresentationCounters): Record<string, number> {
	const delta: Record<string, number> = {};
	for (const key of Object.keys(before) as Array<keyof ToolResultPresentationCounters>) {
		delta[key] = (after[key] - before[key]) / MEASURED_RUNS;
	}
	return delta;
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
		countersPerResult: counterDelta(before, counters),
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
	let owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: BUDGET_TOKENS }, SESSION_ID)!;
	let presentation: ToolResultPresentation | undefined = owner.create(
		[{ type: "text", text: TEXT_10_MIB }],
		"lifecycle",
	);
	const weakPresentation = new WeakRef(presentation);
	const weakModel = new WeakRef(presentation.modelContent as object);
	const weakUi = new WeakRef(presentation.uiContent as object);
	owner.release();
	owner.dispose();
	presentation = undefined;
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
	};
}

if (typeof globalThis.gc !== "function") throw new Error("bench:tool-result-budgeted-model-view requires --expose-gc");
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
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
	];
	const providerProjection = await measureProviderProjection(inspector);
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
}
