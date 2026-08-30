import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Model, ToolResultMessage } from "../../packages/ai/src/types.ts";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import {
	createToolOutputEstimatorCounters,
	createToolOutputShadowObserver,
	type ToolOutputEstimatorCounters,
	type ToolOutputShadowOptions,
	type ToolOutputShadowTelemetry,
} from "../../packages/coding-agent/src/core/tool-output-budget.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface AllocationSite {
	bytes: number;
	functionName: string;
	url: string;
	line: number;
}

interface ProfileResult {
	sampledBytes: number;
	top: AllocationSite[];
}

interface TimingResult {
	cpuP50Ms: number;
	cpuP95Ms: number;
	measuredRuns: number;
	sampledAllocationBytes: number;
	sampledBytesPerResult: number;
	topAllocationSites: AllocationSite[];
}

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;
const PRODUCTION_TEXT = "A production shadow fixture measures the final extension-replaced tool result.\n".repeat(900);

class CountingNoopSink {
	calls = 0;
	recordToolOutputShadow(_record: ToolOutputShadowTelemetry): void {
		this.calls++;
	}
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function allocationSites(head: SamplingNode): ProfileResult {
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
	return {
		sampledBytes,
		top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 15),
	};
}

function slope(values: readonly number[]): number {
	const meanX = (values.length - 1) / 2;
	const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < values.length; index++) {
		const dx = index - meanX;
		numerator += dx * (values[index]! - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

async function measureSync(inspector: Session, operation: () => void): Promise<TimingResult> {
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
		measuredRuns: MEASURED_RUNS,
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerResult: sampled.sampledBytes / MEASURED_RUNS,
		topAllocationSites: sampled.top,
	};
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
		measuredRuns: MEASURED_RUNS,
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerResult: sampled.sampledBytes / MEASURED_RUNS,
		topAllocationSites: sampled.top,
	};
}

function counterDelta(
	before: ToolOutputEstimatorCounters,
	after: ToolOutputEstimatorCounters,
): ToolOutputEstimatorCounters {
	const delta = createToolOutputEstimatorCounters();
	for (const key of Object.keys(delta) as Array<keyof ToolOutputEstimatorCounters>) {
		delta[key] = after[key] - before[key];
	}
	return delta;
}

function perResultCounters(delta: ToolOutputEstimatorCounters): Record<string, number> {
	return {
		estimatorCalls: delta.estimatorCalls / MEASURED_RUNS,
		exactEstimatorCalls: delta.exactEstimatorCalls / MEASURED_RUNS,
		fallbackEstimatorCalls: delta.fallbackEstimatorCalls / MEASURED_RUNS,
		charactersScanned: delta.charactersScanned / MEASURED_RUNS,
		utf8BytesObserved: delta.utf8BytesObserved / MEASURED_RUNS,
		lineBreaksObserved: delta.lineBreaksObserved / MEASURED_RUNS,
		scanStateObjectsCreated: delta.scanStateObjectsCreated / MEASURED_RUNS,
		estimateObjectsCreated: delta.estimateObjectsCreated / MEASURED_RUNS,
		exactInputObjectsCreated: delta.exactInputObjectsCreated / MEASURED_RUNS,
		telemetryPayloadsCreated: delta.telemetryPayloadsCreated / MEASURED_RUNS,
		telemetrySinkCalls: delta.telemetrySinkCalls / MEASURED_RUNS,
		telemetrySinkDrops: delta.telemetrySinkDrops / MEASURED_RUNS,
		telemetrySinkRejections: delta.telemetrySinkRejections / MEASURED_RUNS,
		telemetryRejectionObserversAttached: delta.telemetryRejectionObserversAttached / MEASURED_RUNS,
		shadowObservationErrors: delta.shadowObservationErrors / MEASURED_RUNS,
	};
}

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "shadow-benchmark",
		name: "Shadow Benchmark",
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
		streamSimple: () => { throw new Error("provider dispatch is outside this benchmark"); },
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	} as unknown as ModelRuntime;
}

function replacementExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		if (event.message.role !== "toolResult") return undefined;
		return {
			message: {
				...event.message,
				content: [{ type: "text", text: PRODUCTION_TEXT }],
			},
		};
	});
}

type ProductionMode = "absent" | "disabled" | "enabled";

async function createProductionFixture(root: string, mode: ProductionMode, sink: CountingNoopSink) {
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
		extensionFactories: [replacementExtension],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(cwd, { id: `shadow-${mode}` });
	const counters = createToolOutputEstimatorCounters();
	let shadow: ToolOutputShadowOptions | undefined;
	if (mode === "disabled") shadow = { enabled: false, counters, telemetry: sink };
	if (mode === "enabled") shadow = { enabled: true, counters, telemetry: sink };
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: fixtureModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all",
		toolOutputShadow: shadow,
	});
	let listenerCalls = 0;
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult") listenerCalls++;
	});
	let sequence = 0;
	return {
		mode,
		session,
		sessionManager,
		counters,
		sink,
		get listenerCalls(): number { return listenerCalls; },
		async deliver(): Promise<void> {
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: `benchmark-${mode}-${sequence++}`,
				toolName: "bash",
				content: [{ type: "text", text: "before extension" }],
				isError: false,
				timestamp: sequence,
			};
			await (session as unknown as {
				_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message });
		},
	};
}

if (typeof globalThis.gc !== "function") throw new Error("bench:tool-output-shadow requires --expose-gc");

const root = mkdtempSync(join(tmpdir(), "pi-shadow-benchmark-"));
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
try {
	const observerSink = new CountingNoopSink();
	const observerCounters = createToolOutputEstimatorCounters();
	const observer = createToolOutputShadowObserver({
		enabled: true,
		counters: observerCounters,
		telemetry: observerSink,
	})!;
	const observerMessage = { toolName: "bash", content: [{ type: "text" as const, text: PRODUCTION_TEXT }] };
	for (let run = 0; run < WARMUP_RUNS; run++) observer.observe(observerMessage);
	const observerBefore = { ...observerCounters };
	const observerSinkCallsBefore = observerSink.calls;
	const observerTiming = await measureSync(inspector, () => { observer.observe(observerMessage); });
	const observerMeasuredCounters = counterDelta(observerBefore, observerCounters);
	observer.dispose();

	const fixtures = [
		await createProductionFixture(root, "absent", new CountingNoopSink()),
		await createProductionFixture(root, "disabled", new CountingNoopSink()),
		await createProductionFixture(root, "enabled", new CountingNoopSink()),
	];
	const productionResults: Array<Record<string, unknown>> = [];
	for (const fixture of fixtures) {
		for (let run = 0; run < WARMUP_RUNS; run++) await fixture.deliver();
		const countersBefore = { ...fixture.counters };
		const sinkCallsBefore = fixture.sink.calls;
		const listenerCallsBefore = fixture.listenerCalls;
		const persistedBefore = fixture.sessionManager.getBranch().length;
		const timing = await measureAsync(inspector, fixture.deliver);
		const measuredCounterDeltas = counterDelta(countersBefore, fixture.counters);
		productionResults.push({
			mode: fixture.mode,
			...timing,
			countersPerResult: perResultCounters(measuredCounterDeltas),
			sinkCallsPerResult: (fixture.sink.calls - sinkCallsBefore) / MEASURED_RUNS,
			listenerCallsPerResult: (fixture.listenerCalls - listenerCallsBefore) / MEASURED_RUNS,
			persistedMessagesPerResult:
				(fixture.sessionManager.getBranch().length - persistedBefore) / MEASURED_RUNS,
		});
	}

	globalThis.gc();
	globalThis.gc();
	const heapBeforeClearAndDisposeBytes = process.memoryUsage().heapUsed;
	for (const fixture of fixtures) {
		fixture.sessionManager.newSession({ id: `cleared-${fixture.mode}` });
		fixture.session.dispose();
		const result = productionResults.find((candidate) => candidate.mode === fixture.mode)!;
		result.activeRetainedReferencesAfterDispose = fixture.counters.activeRetainedReferences;
		result.activeObservationsAfterDispose = fixture.counters.activeObservations;
	}
	fixtures.length = 0;
	globalThis.gc();
	globalThis.gc();
	const heapAfterClearAndDisposeBytes = process.memoryUsage().heapUsed;
	const controlledGcSamples: number[] = [];
	for (let cycle = 0; cycle < 5; cycle++) {
		globalThis.gc();
		globalThis.gc();
		controlledGcSamples.push(process.memoryUsage().heapUsed);
	}

	const source = readFileSync("packages/coding-agent/src/core/tool-output-budget.ts", "utf8");
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tool-output-shadow-production",
		commit: git(["rev-parse", "HEAD"]),
		branch: git(["branch", "--show-current"]),
		worktree: git(["rev-parse", "--show-toplevel"]),
		worktreeStatus: git(["status", "--short"]),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		warmupRuns: WARMUP_RUNS,
		measuredRuns: MEASURED_RUNS,
		observerEnabled: {
			...observerTiming,
			countersPerResult: perResultCounters(observerMeasuredCounters),
			sinkCallsPerResult: (observerSink.calls - observerSinkCallsBefore) / MEASURED_RUNS,
			activeRetainedReferencesAfterDispose: observerCounters.activeRetainedReferences,
		},
		productionResults,
		lifecycle: {
			heapBeforeClearAndDisposeBytes,
			heapAfterClearAndDisposeBytes,
			heapDeltaBytes: heapAfterClearAndDisposeBytes - heapBeforeClearAndDisposeBytes,
			controlledGcSamples,
			controlledGcSlopeBytesPerCycle: slope(controlledGcSamples),
		},
		sourceInvariants: {
			sourceInvariantFullResultCopies: source.includes("Buffer.from(") ? 1 : 0,
			sourceInvariantFullResultSerializations: source.includes("JSON.stringify(") ? 1 : 0,
			sourceInvariantTemporaryLineArrays: source.includes(".split(") ? 1 : 0,
			sourceInvariantObjectPools: source.includes("ObjectPool") ? 1 : 0,
		},
	}, null, 2)}\n`);
} finally {
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	rmSync(root, { recursive: true, force: true });
}
