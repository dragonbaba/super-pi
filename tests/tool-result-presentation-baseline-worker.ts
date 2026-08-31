import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { Model, ToolResultMessage } from "../packages/ai/src/types.ts";
import type { AgentSessionEvent, AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import type { ToolResultPresentationCounters } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

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

type WorkerMode = "baseline" | "absent" | "disabled";

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;
const RESULTS_PER_RUN = 100;
const SAMPLING_INTERVAL_BYTES = 1024;
const TEN_MIB_TEXT = "x".repeat(10 * 1024 * 1024);

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function git(repoRoot: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
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

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "presentation-baseline-benchmark",
		name: "Presentation Baseline Benchmark",
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

if (typeof globalThis.gc !== "function") throw new Error("baseline worker requires --expose-gc");
const repoRoot = process.argv[2];
const mode = process.argv[3] as WorkerMode | undefined;
if (!repoRoot || (mode !== "baseline" && mode !== "absent" && mode !== "disabled")) {
	throw new Error("usage: baseline-worker <repo-root> <baseline|absent|disabled>");
}

const moduleUrl = function moduleUrl(relativePath: string): string {
	return pathToFileURL(join(repoRoot, relativePath)).href;
};
const { createAgentSession } = await import(moduleUrl("packages/coding-agent/src/core/sdk.ts")) as typeof import("../packages/coding-agent/src/core/sdk.ts");
const { DefaultResourceLoader } = await import(moduleUrl("packages/coding-agent/src/core/resource-loader.ts")) as typeof import("../packages/coding-agent/src/core/resource-loader.ts");
const { SessionManager } = await import(moduleUrl("packages/coding-agent/src/core/session-manager.ts")) as typeof import("../packages/coding-agent/src/core/session-manager.ts");
const { SettingsManager } = await import(moduleUrl("packages/coding-agent/src/core/settings-manager.ts")) as typeof import("../packages/coding-agent/src/core/settings-manager.ts");
let counters: ToolResultPresentationCounters | undefined;
let presentationOption: unknown;
if (mode !== "baseline") {
	const presentationModule = await import(moduleUrl("packages/coding-agent/src/core/tool-result-presentation.ts")) as typeof import("../packages/coding-agent/src/core/tool-result-presentation.ts");
	counters = presentationModule.createToolResultPresentationCounters();
	if (mode === "disabled") presentationOption = { enabled: false, counters };
}

const root = mkdtempSync(join(tmpdir(), `pi-presentation-ab-${mode}-`));
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
const sessionManager = SessionManager.inMemory(cwd, { id: `presentation-ab-${mode}` });
const options: Record<string, unknown> = {
	cwd,
	agentDir,
	model: fixtureModel(),
	modelRuntime: fixtureModelRuntime(),
	settingsManager,
	sessionManager,
	resourceLoader,
	noTools: "all",
};
if (mode === "disabled") options.toolResultPresentation = presentationOption;
const { session } = await createAgentSession(options as never);
let sequence = 0;
let listenerCalls = 0;
session.subscribe(function onSessionEvent(event: AgentSessionEvent): void {
	if (event.type === "message_end" && event.message.role === "toolResult") listenerCalls++;
});

async function deliver(): Promise<void> {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: `presentation-ab-${mode}-${sequence++}`,
		toolName: "bash",
		content: [{ type: "text", text: TEN_MIB_TEXT }],
		isError: false,
		timestamp: sequence,
	};
	await (session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message });
}

async function deliverBatch(): Promise<void> {
	for (let result = 0; result < RESULTS_PER_RUN; result++) await deliver();
}

const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
try {
	for (let run = 0; run < WARMUP_RUNS; run++) await deliverBatch();
	const listenerCallsBefore = listenerCalls;
	const persistedBefore = sessionManager.getBranch().length;
	const countersBefore = counters ? { ...counters } : undefined;
	globalThis.gc();
	globalThis.gc();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL_BYTES,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(MEASURED_RUNS);
	for (let run = 0; run < MEASURED_RUNS; run++) {
		const started = performance.now();
		await deliverBatch();
		durations[run] = (performance.now() - started) / RESULTS_PER_RUN;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	durations.sort((left, right) => left - right);
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const measuredResults = MEASURED_RUNS * RESULTS_PER_RUN;
	const counterPerResult: Record<string, number> | undefined = counters && countersBefore ? {
		presentationObjectsCreated: (counters.presentationObjectsCreated - countersBefore.presentationObjectsCreated) / measuredResults,
		uiOuterArraysCreated: (counters.uiOuterArraysCreated - countersBefore.uiOuterArraysCreated) / measuredResults,
		modelOuterArraysReused: (counters.modelOuterArraysReused - countersBefore.modelOuterArraysReused) / measuredResults,
		contentBlockReferencesReused: (counters.contentBlockReferencesReused - countersBefore.contentBlockReferencesReused) / measuredResults,
	} : undefined;
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tool-result-presentation-default-off-worker",
		mode,
		repoRoot,
		commit: git(repoRoot, ["rev-parse", "HEAD"]),
		worktreeStatus: git(repoRoot, ["status", "--short"]),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		warmupRuns: WARMUP_RUNS,
		measuredRuns: MEASURED_RUNS,
		resultsPerRun: RESULTS_PER_RUN,
		heapProfilerSamplingIntervalBytes: SAMPLING_INTERVAL_BYTES,
		cpuP50MsPerResult: percentile(durations, 0.5),
		cpuP95MsPerResult: percentile(durations, 0.95),
		sampledBytesPerResult: sampled.sampledBytes / measuredResults,
		topAllocationSites: sampled.top,
		listenerCallsPerResult: (listenerCalls - listenerCallsBefore) / measuredResults,
		persistedMessagesPerResult: (sessionManager.getBranch().length - persistedBefore) / measuredResults,
		presentationCountersPerResult: counterPerResult,
	}, null, 2)}\n`);
} finally {
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	sessionManager.newSession({ id: `cleared-${mode}` });
	(session as AgentSession).dispose();
	rmSync(root, { recursive: true, force: true });
}
