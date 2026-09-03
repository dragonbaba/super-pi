import { spawnSync } from "node:child_process";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Message, ToolResultMessage } from "../../packages/ai/src/types.ts";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	type ToolResultPresentationCounters,
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

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;
const SAMPLING_INTERVAL_BYTES = 1024;
const BUDGET_TOKENS = 1024;
const RESULT_TEXT = "0123456789abcdef".repeat((256 * 1024) / 16);
const TEN_MIB_TEXT = "0123456789abcdef".repeat((10 * 1024 * 1024) / 16);

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
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

function fixture(resultCount: number, text: string): {
	owner: NonNullable<ReturnType<typeof createToolResultPresentationOwner>>;
	messages: Message[];
	counters: ToolResultPresentationCounters;
} {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS, counters },
		`contextual-budget-bench-${resultCount}`,
	)!;
	const ids = new Array<string>(resultCount);
	for (let index = 0; index < resultCount; index++) ids[index] = `call-${resultCount}-${index}`;
	const assistant: Message = {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "fixture", arguments: {} })),
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
	const messages: Message[] = [assistant];
	for (let index = 0; index < ids.length; index++) {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: ids[index]!,
			toolName: "fixture",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: index + 2,
		};
		owner.create(result.content, result.toolCallId);
		messages.push(result);
	}
	return { owner, messages, counters };
}

function project(
	owner: NonNullable<ReturnType<typeof createToolResultPresentationOwner>>,
	messages: Message[],
): Message[] {
	return owner.projectMessagesForModel(messages.slice(), undefined, "system", undefined, 128_000, 4_096);
}

async function measureFixture(inspector: Session, resultCount: number, text: string): Promise<Record<string, unknown>> {
	const { owner, messages, counters } = fixture(resultCount, text);
	for (let run = 0; run < WARMUP_RUNS; run++) project(owner, messages);
	globalThis.gc!();
	globalThis.gc!();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL_BYTES,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(MEASURED_RUNS);
	let maximumProjectedTokens = 0;
	for (let run = 0; run < MEASURED_RUNS; run++) {
		const started = performance.now();
		const projected = project(owner, messages);
		durations[run] = performance.now() - started;
		let total = 0;
		for (const message of projected) {
			if (message.role === "toolResult") total += estimateToolOutputTokens(message.content).estimatedTokens;
		}
		maximumProjectedTokens = Math.max(maximumProjectedTokens, total);
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	durations.sort((left, right) => left - right);
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const output = {
		resultCount,
		sourceCodeUnitsPerResult: text.length,
		cpuP50Ms: percentile(durations, 0.5),
		cpuP95Ms: percentile(durations, 0.95),
		sampledAllocationBytes: sampled.sampledBytes,
		topAllocationSites: sampled.top,
		maximumProjectedTokens,
		contextualBudgetCalls: counters.contextualBudgetCalls,
		contextualTurnResults: counters.contextualTurnResults,
		contextualProjectionPasses: counters.contextualProjectionPasses,
		activeContextualCoordinators: counters.activeContextualCoordinators,
		contextualCoordinatorsHighWaterMark: counters.contextualCoordinatorsHighWaterMark,
		projectionRecordEntries: counters.projectionRecordEntries,
		retainedProjectionCodeUnits: counters.retainedProjectionCodeUnits,
	};
	owner.dispose();
	return output;
}

function lifecycleFixture(): {
	refs: WeakRef<object>[];
	entriesAfterClear: number;
	retainedCodeUnitsAfterClear: number;
	activeAfterDispose: number;
} {
	let { owner, messages, counters } = fixture(4, RESULT_TEXT);
	let providerMessages = structuredClone(messages);
	owner.projectMessagesForModel(providerMessages, undefined, "system", undefined, 16_384, 2_048);
	const refs = [
		new WeakRef(owner),
		new WeakRef(messages),
		new WeakRef(providerMessages),
		new WeakRef((providerMessages[1] as ToolResultMessage).content),
	];
	owner.clearProjectionRecords();
	const entriesAfterClear = counters.projectionRecordEntries;
	const retainedCodeUnitsAfterClear = counters.retainedProjectionCodeUnits;
	owner.dispose();
	const activeAfterDispose = counters.activeContextualCoordinators;
	owner = undefined as never;
	messages = undefined as never;
	providerMessages = undefined as never;
	counters = undefined as never;
	return { refs, entriesAfterClear, retainedCodeUnitsAfterClear, activeAfterDispose };
}

if (typeof globalThis.gc !== "function") throw new Error("contextual budget benchmark requires --expose-gc");
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
try {
	const fixtures = [
		await measureFixture(inspector, 1, TEN_MIB_TEXT),
		await measureFixture(inspector, 2, RESULT_TEXT),
		await measureFixture(inspector, 4, RESULT_TEXT),
		await measureFixture(inspector, 8, RESULT_TEXT),
	];
	const lifecycle = lifecycleFixture();
	const controlledGcSamples = new Array<number>(12);
	for (let cycle = 0; cycle < controlledGcSamples.length; cycle++) {
		globalThis.gc();
		globalThis.gc();
		await yieldToEventLoop();
		controlledGcSamples[cycle] = process.memoryUsage().heapUsed;
	}
	let retainedWeakReferences = 0;
	for (const ref of lifecycle.refs) if (ref.deref()) retainedWeakReferences++;
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tool-result-contextual-budget",
		commit: git(["rev-parse", "HEAD"]),
		branch: git(["branch", "--show-current"]),
		worktree: git(["rev-parse", "--show-toplevel"]),
		worktreeStatus: git(["status", "--short"]),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		warmupRuns: WARMUP_RUNS,
		measuredRuns: MEASURED_RUNS,
		heapProfilerSamplingIntervalBytes: SAMPLING_INTERVAL_BYTES,
		configuredPerToolAndTurnBudgetTokens: BUDGET_TOKENS,
		providerHardByteCeiling: "unavailable-no-model-capability-field",
		fixtures,
		lifecycle: {
			entriesAfterClear: lifecycle.entriesAfterClear,
			retainedCodeUnitsAfterClear: lifecycle.retainedCodeUnitsAfterClear,
			activeAfterDispose: lifecycle.activeAfterDispose,
			controlledGcSamples,
			controlledGcSlopeBytesPerCycle: slope(controlledGcSamples),
			retainedWeakReferences,
		},
		sourceInvariants: {
			fullResultCopies: 0,
			fullResultSerializations: 0,
			perRequestEnvelopeWrappers: 0,
			promiseConstructions: 0,
			abortControllerConstructions: 0,
			objectPools: 0,
		},
	}, null, 2)}\n`);
} finally {
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
}
