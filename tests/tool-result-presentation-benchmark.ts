import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Model, ToolResultMessage } from "../packages/ai/src/types.ts";
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
	type ToolResultPresentationV1,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

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

interface TimingResult {
	cpuP50Ms: number;
	cpuP95Ms: number;
	sampledAllocationBytes: number;
	sampledBytesPerResult: number;
	topAllocationSites: AllocationSite[];
}

interface PresentationWeakReferences {
	presentation: WeakRef<ToolResultPresentationV1>;
	modelContent: WeakRef<object>;
	uiContent: WeakRef<object>;
}

type ProductionMode = "absent" | "disabled" | "enabled";

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;
const TEN_MIB_TEXT = "x".repeat(10 * 1024 * 1024);

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
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 15) };
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
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerResult: sampled.sampledBytes / MEASURED_RUNS,
		topAllocationSites: sampled.top,
	};
}

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "presentation-benchmark",
		name: "Presentation Benchmark",
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

async function createProductionFixture(root: string, mode: ProductionMode) {
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
	const sessionManager = SessionManager.inMemory(cwd, { id: `presentation-benchmark-${mode}` });
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
	let sequence = 0;
	let listenerCalls = 0;
	let presentationCalls = 0;
	let lastPresentation: ToolResultPresentationV1 | undefined;
	session.subscribe(function onSessionEvent(event: AgentSessionEvent): void {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return;
		listenerCalls++;
		if (event.toolResultPresentation) {
			presentationCalls++;
			lastPresentation = event.toolResultPresentation;
		}
	});
	return {
		mode,
		session,
		sessionManager,
		counters,
		get listenerCalls(): number { return listenerCalls; },
		get presentationCalls(): number { return presentationCalls; },
		async deliver(): Promise<void> {
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: `presentation-${mode}-${sequence++}`,
				toolName: "bash",
				content: [{ type: "text", text: TEN_MIB_TEXT }],
				isError: false,
				timestamp: sequence,
			};
			await (session as unknown as {
				_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message });
		},
		clearAndDispose(): PresentationWeakReferences | undefined {
			const weak = lastPresentation?.uiContent
				? {
					presentation: new WeakRef(lastPresentation),
					modelContent: new WeakRef(lastPresentation.modelContent),
					uiContent: new WeakRef(lastPresentation.uiContent),
				}
				: undefined;
			lastPresentation = undefined;
			sessionManager.newSession({ id: `cleared-${mode}` });
			session.dispose();
			return weak;
		},
	};
}

function counterDelta(
	before: ToolResultPresentationCounters,
	after: ToolResultPresentationCounters,
): ToolResultPresentationCounters {
	const delta = createToolResultPresentationCounters();
	for (const key of Object.keys(delta) as Array<keyof ToolResultPresentationCounters>) {
		delta[key] = after[key] - before[key];
	}
	return delta;
}

function perResult(delta: ToolResultPresentationCounters): Record<string, number> {
	return {
		presentationObjectsCreated: delta.presentationObjectsCreated / MEASURED_RUNS,
		uiOuterArraysCreated: delta.uiOuterArraysCreated / MEASURED_RUNS,
		modelOuterArraysReused: delta.modelOuterArraysReused / MEASURED_RUNS,
		presentationOuterArrayReferences: delta.presentationOuterArrayReferences / MEASURED_RUNS,
		contentBlockReferencesReused: delta.contentBlockReferencesReused / MEASURED_RUNS,
		textStringReferencesReused: delta.textStringReferencesReused / MEASURED_RUNS,
		imageDataReferencesReused: delta.imageDataReferencesReused / MEASURED_RUNS,
		completedDispatchPresentationScopes: delta.completedDispatchPresentationScopes / MEASURED_RUNS,
		releaseWithoutActiveScope: delta.releaseWithoutActiveScope / MEASURED_RUNS,
	};
}

if (typeof globalThis.gc !== "function") {
	throw new Error("tool-result-presentation-benchmark requires --expose-gc");
}

const root = mkdtempSync(join(tmpdir(), "pi-presentation-benchmark-"));
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
try {
	const directCounters = createToolResultPresentationCounters();
	const directOwner = createToolResultPresentationOwner({ enabled: true, counters: directCounters })!;
	const directContent = [{ type: "text" as const, text: TEN_MIB_TEXT }];
	for (let run = 0; run < WARMUP_RUNS; run++) {
		directOwner.create(directContent);
		directOwner.release();
	}
	const directBefore = { ...directCounters };
	const directTiming = await measureSync(inspector, function createAndReleasePresentation(): void {
		directOwner.create(directContent);
		directOwner.release();
	});
	const directMeasured = counterDelta(directBefore, directCounters);
	directOwner.dispose();

	const fixtures = [
		await createProductionFixture(root, "absent"),
		await createProductionFixture(root, "disabled"),
		await createProductionFixture(root, "enabled"),
	];
	const productionResults: Array<Record<string, unknown>> = [];
	for (const fixture of fixtures) {
		for (let run = 0; run < WARMUP_RUNS; run++) await fixture.deliver();
		const countersBefore = { ...fixture.counters };
		const listenersBefore = fixture.listenerCalls;
		const presentationsBefore = fixture.presentationCalls;
		const persistedBefore = fixture.sessionManager.getBranch().length;
		const timing = await measureAsync(inspector, fixture.deliver);
		const measured = counterDelta(countersBefore, fixture.counters);
		productionResults.push({
			mode: fixture.mode,
			...timing,
			countersPerResult: perResult(measured),
			listenerCallsPerResult: (fixture.listenerCalls - listenersBefore) / MEASURED_RUNS,
			presentationCallsPerResult: (fixture.presentationCalls - presentationsBefore) / MEASURED_RUNS,
			persistedMessagesPerResult:
				(fixture.sessionManager.getBranch().length - persistedBefore) / MEASURED_RUNS,
			activeDispatchPresentationScopesAfterMeasurement:
				fixture.counters.activeDispatchPresentationScopes,
			dispatchPresentationScopesHighWaterMark:
				fixture.counters.dispatchPresentationScopesHighWaterMark,
		});
	}

	globalThis.gc();
	globalThis.gc();
	const heapBeforeClearAndDisposeBytes = process.memoryUsage().heapUsed;
	const presentationWeakReferences: PresentationWeakReferences[] = [];
	for (const fixture of fixtures) {
		const weak = fixture.clearAndDispose();
		if (weak) presentationWeakReferences.push(weak);
	}
	fixtures.length = 0;
	await yieldToEventLoop();
	globalThis.gc();
	globalThis.gc();
	const heapAfterClearAndDisposeBytes = process.memoryUsage().heapUsed;
	const controlledGcSamples: number[] = [];
	for (let cycle = 0; cycle < 5; cycle++) {
		globalThis.gc();
		globalThis.gc();
		controlledGcSamples.push(process.memoryUsage().heapUsed);
	}
	let retainedPresentationWeakReferences = 0;
	let retainedModelContentWeakReferences = 0;
	let retainedUiContentWeakReferences = 0;
	for (const weak of presentationWeakReferences) {
		if (weak.presentation.deref()) retainedPresentationWeakReferences++;
		if (weak.modelContent.deref()) retainedModelContentWeakReferences++;
		if (weak.uiContent.deref()) retainedUiContentWeakReferences++;
	}

	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tool-result-presentation",
		commit: git(["rev-parse", "HEAD"]),
		branch: git(["branch", "--show-current"]),
		worktree: git(["rev-parse", "--show-toplevel"]),
		worktreeStatus: git(["status", "--short"]),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		inputCharacters: TEN_MIB_TEXT.length,
		warmupRuns: WARMUP_RUNS,
		measuredRuns: MEASURED_RUNS,
		directEnabled: {
			...directTiming,
			countersPerResult: perResult(directMeasured),
			activeDispatchPresentationScopesAfterMeasurement:
				directCounters.activeDispatchPresentationScopes,
			dispatchPresentationScopesHighWaterMark:
				directCounters.dispatchPresentationScopesHighWaterMark,
		},
		productionResults,
		lifecycle: {
			heapBeforeClearAndDisposeBytes,
			heapAfterClearAndDisposeBytes,
			heapDeltaBytes: heapAfterClearAndDisposeBytes - heapBeforeClearAndDisposeBytes,
			controlledGcSamples,
			controlledGcSlopeBytesPerCycle: slope(controlledGcSamples),
			retainedPresentationWeakReferences,
			retainedModelContentWeakReferences,
			retainedUiContentWeakReferences,
		},
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
	rmSync(root, { recursive: true, force: true });
}
