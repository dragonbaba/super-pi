import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	Box,
	RELEASE_COMPONENT_RENDER_CACHE,
	setKeybindings,
	TuiMainScreen,
	type Component,
	type TUI,
	type TuiRenderInstrumentation,
} from "@super-pi/tui";
import type { AssistantMessage, Model, ToolResultMessage } from "../../packages/ai/src/types.ts";
import type { AgentMessage } from "../../packages/agent/src/types.ts";
import type { AgentSession, AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import {
	createToolOutputEstimatorCounters,
	estimateToolOutputTokens,
} from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentation,
	type ToolResultPresentationContent,
	type ToolResultPresentationCounters,
} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";
import { auditToolResultPresentationUiSources } from "./tool-result-presentation-ui-source-audit.ts";

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

interface UiProfile {
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	cv: number;
	sampledAllocationBytes: number;
	sampledBytesPerToggleAndRender: number;
	topAllocationSites: AllocationSite[];
}

interface BoxCacheProfile {
	iterations: number;
	cacheHits: number;
	sampledAllocationBytes: number;
	sampledBytesPerCacheHitRender: number;
	topAllocationSites: AllocationSite[];
}

const PROFILE_ITERATIONS = 300;
const LIVE_PROFILE_ITERATIONS = 64;
const LIVE_PROFILE_HISTORY_MESSAGES = 50_000;
const GC_CYCLES = 32;
const COMPONENTS_PER_GC_CYCLE = 16;
const content: ToolResultPresentationContent[] = [
	{ type: "text", text: "ui-discovery-allocation-fixture\n".repeat(1_024) },
	{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
];

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function coefficientOfVariation(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let mean = 0;
	for (const value of values) mean += value;
	mean /= values.length;
	if (mean === 0) return 0;
	let squaredDifference = 0;
	for (const value of values) {
		const difference = value - mean;
		squaredDifference += difference * difference;
	}
	return Math.sqrt(squaredDifference / values.length) / mean;
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
	return {
		sampledBytes,
		top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 12),
	};
}

function slope(values: readonly number[]): number {
	const meanX = (values.length - 1) / 2;
	let meanY = 0;
	for (const value of values) meanY += value;
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

function createTui(): TUI {
	return { requestRender(): void {} } as TUI;
}

class MutableBoxChild implements Component {
	lines = ["one", "two"];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function measureBoxCache(): {
	hits: number;
	misses: number;
	goldenMatches: boolean;
	cacheHitPreservesLinesIdentity: boolean;
} {
	const child = new MutableBoxChild();
	const box = new Box(0, 0);
	box.addChild(child);
	let hits = 0;
	let misses = 0;
	const initial = box.render(12);
	const hit = box.render(12);
	if (hit === initial) hits++;

	child.lines = ["one", "changed"];
	const contentMiss = box.render(12);
	if (contentMiss !== hit) misses++;
	child.lines = ["one", "changed", "three"];
	const lengthMiss = box.render(12);
	if (lengthMiss !== contentMiss) misses++;
	const widthMiss = box.render(13);
	if (widthMiss !== lengthMiss) misses++;
	box.setBgFn((text) => `changed:${text}`);
	const backgroundMiss = box.render(13);
	if (backgroundMiss !== widthMiss) misses++;

	const goldenBox = new Box(1, 1);
	const goldenChild = new MutableBoxChild();
	goldenChild.lines = ["alpha", "b"];
	goldenBox.addChild(goldenChild);
	const golden = goldenBox.render(8);
	return {
		hits,
		misses,
		goldenMatches:
			golden.length === 4 &&
			golden[0] === "        " &&
			golden[1] === " alpha  " &&
			golden[2] === " b      " &&
			golden[3] === "        ",
		cacheHitPreservesLinesIdentity: goldenBox.render(8) === golden,
	};
}

function captureReleasedBoxCache(): { owner: Box; cacheRef: WeakRef<object> } {
	const box = new Box(0, 0);
	box.addChild(new MutableBoxChild());
	const cachedLines = box.render(12);
	const cacheRef = new WeakRef<object>(cachedLines);
	box[RELEASE_COMPONENT_RENDER_CACHE]();
	return { owner: box, cacheRef };
}

function createAttachedComponent(index: number): {
	component: ToolExecutionComponent;
	discovery: object;
	dispose(): void;
} {
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, `ui-profile-${index}`)!;
	const presentation = owner.create(content, `ui-profile-${index}`)!;
	const component = new ToolExecutionComponent(
		"fixture",
		`ui-profile-${index}`,
		{},
		{ showImages: false },
		undefined,
		createTui(),
		process.cwd(),
	);
	component.updateResult({ content });
	component.setToolResultPresentation(`ui-profile-${index}`, presentation);
	const discovery = component.getToolResultPresentationDiscovery(`ui-profile-${index}`)!;
	return {
		component,
		discovery,
		dispose(): void {
			component[RELEASE_COMPONENT_RENDER_CACHE]();
			owner.release();
			owner.dispose();
		},
	};
}

function createPlainComponent(toolCallId: string): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"fixture",
		toolCallId,
		{},
		{ showImages: false },
		undefined,
		createTui(),
		process.cwd(),
	);
	component.updateResult({ content });
	return component;
}

function createGroupedReadFixture(): {
	component: ReadToolGroupComponent;
	dispose(): void;
} {
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256 }, "ui-grouped-profile")!;
	const component = new ReadToolGroupComponent();
	for (let index = 0; index < 3; index++) {
		const toolCallId = `grouped-profile-${index}`;
		component.updateArgs(toolCallId, { path: `fixture-${index}.txt` });
		component.setArgsComplete(toolCallId);
		const rowContent: ToolResultPresentationContent[] = index === 1
			? [
				{ type: "text", text: `grouped-${index}-\n`.repeat(4_096) },
				{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
			]
			: [{ type: "text", text: `grouped-${index}-\n`.repeat(4_096) }];
		const result = { content: rowContent, isError: index === 2 };
		component.updateResult(toolCallId, result, false, result.isError);
		const presentation = owner.create(rowContent, toolCallId)!;
		component.setToolResultPresentation(toolCallId, presentation);
		owner.release();
	}
	component.finalize();
	return {
		component,
		dispose(): void {
			owner.dispose();
		},
	};
}

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "ui-corrective-profile",
		name: "UI Corrective Profile",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	};
}

function createModelRuntime(): ModelRuntime {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		isUsingSubscription: () => false,
		streamSimple: () => {
			throw new Error("streaming is not expected in the UI corrective benchmark");
		},
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	} as unknown as ModelRuntime;
}

function assistant(toolCalls: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls,
		api: "openai-responses",
		provider: "fixture",
		model: "ui-corrective-profile",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture-tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

interface InteractiveModeInternals {
	isInitialized: boolean;
	renderer: TuiMainScreen;
	chatContainer: RetainedContainer;
	renderInstrumentation: TuiRenderInstrumentation;
	pendingTools: Map<string, ToolExecutionComponent | ReadToolGroupComponent>;
	toolResultDiscoveries?: Map<string, object>;
	handleEvent(event: AgentSessionEvent): void | Promise<void>;
	clearToolResultDiscoveries(): void;
	renderCurrentSessionState(): void;
	getToolResultDiscoveryLifecycleCounts(): {
		entries: number;
		attached: number;
		pending: number;
		registrationObjectsCreated: number;
		registrationsAttached: number;
		registrationsHighWaterMark: number;
		registrationsEvicted: number;
		registrationsTeardownReleased: number;
		historyMessagesVisited: number;
		presentationCandidatesEvaluated: number;
		actualV2Discoveries: number;
		canonicalLookupProbes: number;
		sourceScans: number;
		liveCanonicalIndexBuildProbes: number;
		liveCanonicalIndexAppendProbes: number;
		liveCanonicalLookupProbes: number;
		liveCanonicalIndexRebuilds: number;
		liveCanonicalIndexEntries: number;
		liveCanonicalIndexOverflowed: boolean;
	};
}

interface ModeFixture {
	root: string;
	mode: InteractiveMode;
	internals: InteractiveModeInternals;
	session: AgentSession;
	dispose(): Promise<void>;
}

async function createModeFixture(
	messages: readonly AgentMessage[],
	presentationMode: "absent" | "disabled" | "enabled",
	withReplacementExtension = false,
): Promise<ModeFixture> {
	const root = mkdtempSync(join(tmpdir(), "super-pi-ui-corrective-bench-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const toolResultPresentation = presentationMode === "enabled"
		? { enabled: true as const, budgetTokens: 128 }
		: presentationMode === "disabled"
			? { enabled: false as const, budgetTokens: 128 }
			: undefined;
	const settingsManager = toolResultPresentation
		? SettingsManager.inMemory({ toolResultPresentation })
		: SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(cwd);
	for (const message of messages) sessionManager.appendMessage(message as any);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: !withReplacementExtension,
		extensionFactories: withReplacementExtension
			? [(pi: any) => {
				pi.on("message_end", (event: { message: ToolResultMessage }) => {
					if (event.message.role !== "toolResult") return undefined;
					return {
						message: {
							...event.message,
							content: [{ type: "text", text: "post-extension-profile-".repeat(1_024) }],
						},
					};
				});
			}]
			: undefined,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: createModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		toolResultPresentation,
	});
	const runtime = new AgentSessionRuntime(
		session,
		{ cwd, agentDir } as AgentSessionServices,
		async () => {
			throw new Error("session replacement is not expected in the UI corrective benchmark");
		},
	);
	const mode = new InteractiveMode(runtime, { tuiMode: "regular" });
	const internals = mode as unknown as InteractiveModeInternals;
	await internals.renderer.dispose({ preserveScreen: true });
	await yieldToEventLoop();
	const renderer = new TuiMainScreen(new FakeTerminal(120, 40), false);
	renderer.setRenderInstrumentation(internals.renderInstrumentation);
	internals.renderer = renderer;
	return {
		root,
		mode,
		internals,
		session,
		async dispose(): Promise<void> {
			await mode.stop("transcript");
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function forceCollection(): Promise<void> {
	for (let pass = 0; pass < 6; pass++) {
		globalThis.gc!();
		await yieldToEventLoop();
	}
}

function durationSummary(durations: number[]): { p50Ms: number; p95Ms: number; p99Ms: number; cv: number } {
	const cv = coefficientOfVariation(durations);
	durations.sort((left, right) => left - right);
	return {
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		p99Ms: percentile(durations, 0.99),
		cv,
	};
}

async function runLiveToolResult(
	fixture: ModeFixture,
	index: number,
	onPendingRegistration?: (registration: object) => void,
): Promise<ToolExecutionComponent> {
	const toolCallId = `live-profile-${index}`;
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const component = fixture.internals.pendingTools.get(toolCallId);
	if (!(component instanceof ToolExecutionComponent)) throw new Error("live profile component was not registered");
	const message = toolResult(toolCallId, `pre-extension-${index}-`.repeat(1_024));
	fixture.session.agent.state.messages.push(message);
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture-tool",
		result: { content: message.content, isError: message.isError },
		isError: false,
	});
	const registration = fixture.internals.toolResultDiscoveries?.get(toolCallId);
	if (registration) onPendingRegistration?.(registration);
	await (fixture.session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message });
	return component;
}

async function measureDefaultOffProduction(mode: "absent" | "disabled"): Promise<{
	iterations: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	cv: number;
	lifecycle: ReturnType<InteractiveModeInternals["getToolResultDiscoveryLifecycleCounts"]>;
}> {
	const fixture = await createModeFixture([], mode);
	fixture.internals.isInitialized = true;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	const durations = new Array<number>(LIVE_PROFILE_ITERATIONS);
	for (let index = 0; index < LIVE_PROFILE_ITERATIONS; index++) {
		const started = performance.now();
		await runLiveToolResult(fixture, index);
		durations[index] = performance.now() - started;
	}
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	unsubscribe();
	await fixture.dispose();
	return { iterations: LIVE_PROFILE_ITERATIONS, ...durationSummary(durations), lifecycle };
}

async function measureLiveRegistrationProfile(inspector: Session): Promise<{
	resumedHistoryMessages: number;
	iterations: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	cv: number;
	sampledAllocationBytes: number;
	topAllocationSites: AllocationSite[];
	pendingRegistrationObjectsCreatedPerResult: number;
	canonicalIndex: {
		buildProbes: number;
		measuredAppendProbes: number;
		measuredLookupProbes: number;
		rebuilds: number;
		entries: number;
		overflowed: boolean;
	};
	lifecycle: ReturnType<InteractiveModeInternals["getToolResultDiscoveryLifecycleCounts"]>;
}> {
	const resumedHistory: AgentMessage[] = [];
	for (let index = 0; index < LIVE_PROFILE_HISTORY_MESSAGES; index++) {
		resumedHistory.push(toolResult(`live-history-${index}`, "small"));
	}
	const fixture = await createModeFixture(resumedHistory, "enabled", true);
	fixture.internals.isInitialized = true;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	for (let index = 0; index < 8; index++) {
		await runLiveToolResult(fixture, -index - 1);
		fixture.internals.clearToolResultDiscoveries();
	}
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	await forceCollection();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(LIVE_PROFILE_ITERATIONS);
	for (let index = 0; index < LIVE_PROFILE_ITERATIONS; index++) {
		const started = performance.now();
		await runLiveToolResult(fixture, index);
		fixture.internals.clearToolResultDiscoveries();
		durations[index] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	const allocations = allocationSites(stopped.profile.head as SamplingNode);
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const created = after.registrationObjectsCreated - before.registrationObjectsCreated;
	unsubscribe();
	await fixture.dispose();
	return {
		resumedHistoryMessages: resumedHistory.length,
		iterations: LIVE_PROFILE_ITERATIONS,
		...durationSummary(durations),
		sampledAllocationBytes: allocations.sampledBytes,
		topAllocationSites: allocations.top,
		pendingRegistrationObjectsCreatedPerResult: created / LIVE_PROFILE_ITERATIONS,
		canonicalIndex: {
			buildProbes: before.liveCanonicalIndexBuildProbes,
			measuredAppendProbes:
				after.liveCanonicalIndexAppendProbes - before.liveCanonicalIndexAppendProbes,
			measuredLookupProbes: after.liveCanonicalLookupProbes - before.liveCanonicalLookupProbes,
			rebuilds: after.liveCanonicalIndexRebuilds,
			entries: after.liveCanonicalIndexEntries,
			overflowed: after.liveCanonicalIndexOverflowed,
		},
		lifecycle: {
			...after,
			registrationObjectsCreated: created,
			registrationsAttached: after.registrationsAttached - before.registrationsAttached,
			registrationsEvicted: after.registrationsEvicted - before.registrationsEvicted,
			registrationsTeardownReleased:
				after.registrationsTeardownReleased - before.registrationsTeardownReleased,
		},
	};
}

async function measureChronologicalEviction(): Promise<{
	initialDiscoveries: number;
	discoveriesAfterLive: number;
	newestStillAdvertised: boolean;
	newestFullSourceScanDelta: number;
	newestResidentRecordHitDelta: number;
}> {
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		const toolCallId = `eviction-profile-${index}`;
		calls.push({ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} });
		messages.push(toolResult(toolCallId, `eviction-profile-${index}-`.repeat(1_024)));
	}
	messages.unshift(assistant(calls));
	const fixture = await createModeFixture(messages, "enabled");
	fixture.internals.isInitialized = true;
	fixture.mode.renderInitialMessages();
	const newestComponent = fixture.internals.chatContainer.children.find(
		(child): child is ToolExecutionComponent =>
			child instanceof ToolExecutionComponent &&
			child.getToolResultPresentationDiscovery("eviction-profile-127") !== undefined,
	);
	const newestBefore = newestComponent?.getToolResultPresentationDiscovery("eviction-profile-127");
	if (!newestComponent || !newestBefore) throw new Error("chronological eviction fixture missed newest discovery");
	const initialDiscoveries = fixture.internals.getToolResultDiscoveryLifecycleCounts().entries;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	await runLiveToolResult(fixture, 200_000);
	const newestAfter = newestComponent.getToolResultPresentationDiscovery("eviction-profile-127");
	const ownerCounters = (fixture.session as unknown as {
		_toolResultPresentation?: {
			counters: { fullSourceEstimatorScans: number; activeContinuationRecordHits: number };
		};
	})._toolResultPresentation?.counters;
	if (!ownerCounters || !newestAfter) throw new Error("newest rebuild discovery was evicted before validation");
	const scansBefore = ownerCounters.fullSourceEstimatorScans;
	const hitsBefore = ownerCounters.activeContinuationRecordHits;
	fixture.session.readToolResultContinuation(newestAfter.cursor, 128);
	const result = {
		initialDiscoveries,
		discoveriesAfterLive: fixture.internals.getToolResultDiscoveryLifecycleCounts().entries,
		newestStillAdvertised: newestAfter.identity === newestBefore.identity,
		newestFullSourceScanDelta: ownerCounters.fullSourceEstimatorScans - scansBefore,
		newestResidentRecordHitDelta: ownerCounters.activeContinuationRecordHits - hitsBefore,
	};
	unsubscribe();
	await fixture.dispose();
	return result;
}

async function measureTeardown128(): Promise<{
	components: number;
	sessionSwitchUpdateDisplayCalls: number;
	sessionSwitchFullResultTextScans: number;
	sessionSwitchImageConversionsScheduled: number;
	stopUpdateDisplayCalls: number;
	stopFullResultTextScans: number;
	stopImageConversionsScheduled: number;
	registrationsAttachedAfterRebuild: number;
	registrationsAfterStop: number;
	teardownReleases: number;
}> {
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		calls.push({ type: "toolCall", id: `teardown-profile-${index}`, name: "fixture-tool", arguments: {} });
	}
	messages.push(assistant(calls));
	for (let index = 0; index < 128; index++) {
		messages.push(toolResult(`teardown-profile-${index}`, `teardown-large-${index}-`.repeat(1_024)));
	}
	const fixture = await createModeFixture(messages, "enabled");
	fixture.mode.renderInitialMessages();
	const components = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	let sessionSwitchUpdateDisplayCalls = 0;
	let sessionSwitchFullResultTextScans = 0;
	let sessionSwitchImageConversionsScheduled = 0;
	for (const component of components) {
		const target = component as unknown as {
			updateDisplay(): void;
			getTextOutput(): string;
			refreshImageTree(): void;
		};
		const updateDisplay = target.updateDisplay.bind(component);
		const getTextOutput = target.getTextOutput.bind(component);
		const refreshImageTree = target.refreshImageTree.bind(component);
		target.updateDisplay = () => {
			sessionSwitchUpdateDisplayCalls++;
			updateDisplay();
		};
		target.getTextOutput = () => {
			sessionSwitchFullResultTextScans++;
			return getTextOutput();
		};
		target.refreshImageTree = () => {
			sessionSwitchImageConversionsScheduled++;
			refreshImageTree();
		};
	}
	fixture.internals.renderCurrentSessionState();
	const afterRebuild = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const rebuiltComponents = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	let stopUpdateDisplayCalls = 0;
	let stopFullResultTextScans = 0;
	let stopImageConversionsScheduled = 0;
	for (const component of rebuiltComponents) {
		const target = component as unknown as {
			updateDisplay(): void;
			getTextOutput(): string;
			refreshImageTree(): void;
		};
		const updateDisplay = target.updateDisplay.bind(component);
		const getTextOutput = target.getTextOutput.bind(component);
		const refreshImageTree = target.refreshImageTree.bind(component);
		target.updateDisplay = () => {
			stopUpdateDisplayCalls++;
			updateDisplay();
		};
		target.getTextOutput = () => {
			stopFullResultTextScans++;
			return getTextOutput();
		};
		target.refreshImageTree = () => {
			stopImageConversionsScheduled++;
			refreshImageTree();
		};
	}
	await fixture.mode.stop("transcript");
	const afterStop = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	await fixture.dispose();
	return {
		components: components.length,
		sessionSwitchUpdateDisplayCalls,
		sessionSwitchFullResultTextScans,
		sessionSwitchImageConversionsScheduled,
		stopUpdateDisplayCalls,
		stopFullResultTextScans,
		stopImageConversionsScheduled,
		registrationsAttachedAfterRebuild: afterRebuild.entries,
		registrationsAfterStop: afterStop.entries,
		teardownReleases: afterStop.registrationsTeardownReleased,
	};
}

async function measureMixedHistoryRebuild(): Promise<{
	durationMs: number;
	selected: number;
	presentationAdmissions: number;
	ownerFullSourceEstimatorScans: number;
	projectionEntryDelta: number;
	evictionDelta: number;
	counts: ReturnType<AgentSession["getToolResultPresentationUiRebuildCounts"]>;
	selectedContinuation: {
		firstFullSourceScanDelta: number;
		firstHistoryLookupProbeDelta: number;
		firstResidentRecordHitDelta: number;
		secondFullSourceScanDelta: number;
		secondHistoryLookupProbeDelta: number;
		secondResidentRecordHitDelta: number;
	};
}> {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 50_000; index++) {
		messages.push(toolResult(
			`mixed-profile-${index}`,
			index % 390 === 0 ? `mixed-large-${index}-`.repeat(1_024) : "small",
		));
	}
	const fixture = await createModeFixture(messages, "enabled");
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	const started = performance.now();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const durationMs = performance.now() - started;
	const counts = fixture.session.getToolResultPresentationUiRebuildCounts();
	const selectedCount = selected.size;
	const selectedPresentation = selected.values().next().value;
	const ownerCounters = (fixture.session as unknown as {
		_toolResultPresentation?: {
			counters: {
				presentationObjectsCreated: number;
				projectionRecordEntries: number;
				projectionRecordEvictions: number;
				fullSourceEstimatorScans: number;
				continuationSourceLookupProbes: number;
				activeContinuationRecordHits: number;
			};
		};
	})._toolResultPresentation?.counters;
	if (!ownerCounters || selectedPresentation?.version !== 2) {
		throw new Error("mixed-history rebuild did not produce a resident V2 continuation");
	}
	const presentationAdmissions = ownerCounters.presentationObjectsCreated;
	const ownerFullSourceEstimatorScans = ownerCounters.fullSourceEstimatorScans;
	const projectionEntryDelta = ownerCounters.projectionRecordEntries;
	const evictionDelta = ownerCounters.projectionRecordEvictions;
	const scansBeforeFirst = ownerCounters.fullSourceEstimatorScans;
	const probesBeforeFirst = ownerCounters.continuationSourceLookupProbes;
	const hitsBeforeFirst = ownerCounters.activeContinuationRecordHits;
	const first = fixture.session.readToolResultContinuation(selectedPresentation.continuation.cursor, 128);
	const firstFullSourceScanDelta = ownerCounters.fullSourceEstimatorScans - scansBeforeFirst;
	const firstHistoryLookupProbeDelta = ownerCounters.continuationSourceLookupProbes - probesBeforeFirst;
	const firstResidentRecordHitDelta = ownerCounters.activeContinuationRecordHits - hitsBeforeFirst;
	if (!first.nextCursor) throw new Error("mixed-history continuation fixture ended before the second resident read");
	const scansBeforeSecond = ownerCounters.fullSourceEstimatorScans;
	const probesBeforeSecond = ownerCounters.continuationSourceLookupProbes;
	const hitsBeforeSecond = ownerCounters.activeContinuationRecordHits;
	fixture.session.readToolResultContinuation(first.nextCursor, 128);
	const selectedContinuation = {
		firstFullSourceScanDelta,
		firstHistoryLookupProbeDelta,
		firstResidentRecordHitDelta,
		secondFullSourceScanDelta: ownerCounters.fullSourceEstimatorScans - scansBeforeSecond,
		secondHistoryLookupProbeDelta: ownerCounters.continuationSourceLookupProbes - probesBeforeSecond,
		secondResidentRecordHitDelta: ownerCounters.activeContinuationRecordHits - hitsBeforeSecond,
	};
	selected.clear();
	await fixture.dispose();
	return {
		durationMs,
		selected: selectedCount,
		presentationAdmissions,
		ownerFullSourceEstimatorScans,
		projectionEntryDelta,
		evictionDelta,
		counts,
		selectedContinuation,
	};
}

async function measureSharedOwnerUiRebuild(): Promise<{
	selected: number;
	initialAdmissionScans: number;
	uiRebuildScanDelta: number;
	providerAfterRebuildScanDelta: number;
	repeatedRebuildScanDelta: number;
	repeatedRebuildEvictionDelta: number;
	entriesAfterRebuild: number;
	retainedCodeUnitsAfterRebuild: number;
}> {
	const small = toolResult("shared-owner-v1", "small");
	const large = toolResult("shared-owner-v2", "shared-owner-large-".repeat(1_024));
	const fixture = await createModeFixture([small, large], "enabled");
	const owner = (fixture.session as unknown as {
		_toolResultPresentation?: {
			counters: {
				fullSourceEstimatorScans: number;
				projectionRecordEvictions: number;
				projectionRecordEntries: number;
				retainedProjectionCodeUnits: number;
			};
		};
	})._toolResultPresentation;
	const canonicalSmall = fixture.session.agent.state.messages[0];
	if (!owner || canonicalSmall?.role !== "toolResult") throw new Error("shared-owner fixture is incomplete");
	fixture.session.getToolResultPresentationForUi(canonicalSmall);
	await fixture.session.agent.convertToLlm(fixture.session.agent.state.messages.slice());
	const initialAdmissionScans = owner.counters.fullSourceEstimatorScans;
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const scansAfterRebuild = owner.counters.fullSourceEstimatorScans;
	const evictionsAfterRebuild = owner.counters.projectionRecordEvictions;
	await fixture.session.agent.convertToLlm(fixture.session.agent.state.messages.slice());
	const scansAfterProvider = owner.counters.fullSourceEstimatorScans;
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const result = {
		selected: selected.size,
		initialAdmissionScans,
		uiRebuildScanDelta: scansAfterRebuild - initialAdmissionScans,
		providerAfterRebuildScanDelta: scansAfterProvider - scansAfterRebuild,
		repeatedRebuildScanDelta: owner.counters.fullSourceEstimatorScans - scansAfterProvider,
		repeatedRebuildEvictionDelta: owner.counters.projectionRecordEvictions - evictionsAfterRebuild,
		entriesAfterRebuild: owner.counters.projectionRecordEntries,
		retainedCodeUnitsAfterRebuild: owner.counters.retainedProjectionCodeUnits,
	};
	selected.clear();
	await fixture.dispose();
	return result;
}

async function measureNonAdmittingCandidateInspection(): Promise<{
	allV1: {
		candidatesEvaluated: number;
		actualDiscoveries: number;
		presentationAdmissions: number;
		entryDelta: number;
		evictionDelta: number;
		retainedCodeUnitDelta: number;
		providerFullSourceScanDelta: number;
		providerResidentHitDelta: number;
	};
	mixed: {
		candidatesEvaluated: number;
		actualDiscoveries: number;
		presentationAdmissions: number;
		entryDelta: number;
		evictionDelta: number;
		providerFullSourceScanDelta: number;
		providerResidentHitDelta: number;
	};
	fallbackEstimatorAllocationContract: {
		estimatorCalls: number;
		scanStateObjectsCreated: number;
		estimateObjectsCreated: number;
		exactInputObjectsCreated: number;
		exactEstimatorCalls: number;
	};
}> {
	const allV1Messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) allV1Messages.push(toolResult(`inspect-v1-${index}`, `small-${index}`));
	allV1Messages.push(toolResult("inspect-hot-v1", "hot-small"));
	const allV1Fixture = await createModeFixture(allV1Messages, "enabled");
	const allV1Owner = (allV1Fixture.session as unknown as {
		_toolResultPresentation?: { counters: ToolResultPresentationCounters };
	})._toolResultPresentation;
	const allV1Hot = allV1Fixture.session.agent.state.messages.at(-1);
	if (!allV1Owner || allV1Hot?.role !== "toolResult") throw new Error("all-V1 inspection fixture is incomplete");
	allV1Fixture.session.getToolResultPresentationForUi(allV1Hot);
	const allV1Before = { ...allV1Owner.counters };
	const allV1Selected = new Map<ToolResultMessage, ToolResultPresentation>();
	allV1Fixture.session.collectRecentToolResultPresentationsForUi(allV1Selected, 128);
	const allV1Counts = allV1Fixture.session.getToolResultPresentationUiRebuildCounts();
	const allV1AfterInspection = { ...allV1Owner.counters };
	await allV1Fixture.session.agent.convertToLlm([allV1Hot]);
	const fallbackEstimatorCounters = createToolOutputEstimatorCounters();
	estimateToolOutputTokens(allV1Hot.content, undefined, fallbackEstimatorCounters);
	const fallbackEstimatorAllocationContract = {
		estimatorCalls: fallbackEstimatorCounters.estimatorCalls,
		scanStateObjectsCreated: fallbackEstimatorCounters.scanStateObjectsCreated,
		estimateObjectsCreated: fallbackEstimatorCounters.estimateObjectsCreated,
		exactInputObjectsCreated: fallbackEstimatorCounters.exactInputObjectsCreated,
		exactEstimatorCalls: fallbackEstimatorCounters.exactEstimatorCalls,
	};
	const allV1 = {
		candidatesEvaluated: allV1Counts.presentationCandidatesEvaluated,
		actualDiscoveries: allV1Selected.size,
		presentationAdmissions:
			allV1AfterInspection.presentationObjectsCreated - allV1Before.presentationObjectsCreated,
		entryDelta: allV1AfterInspection.projectionRecordEntries - allV1Before.projectionRecordEntries,
		evictionDelta: allV1AfterInspection.projectionRecordEvictions - allV1Before.projectionRecordEvictions,
		retainedCodeUnitDelta:
			allV1AfterInspection.retainedProjectionCodeUnits - allV1Before.retainedProjectionCodeUnits,
		providerFullSourceScanDelta:
			allV1Owner.counters.fullSourceEstimatorScans - allV1AfterInspection.fullSourceEstimatorScans,
		providerResidentHitDelta: allV1Owner.counters.residentReadHits - allV1AfterInspection.residentReadHits,
	};
	allV1Selected.clear();
	await allV1Fixture.dispose();

	const selectedV2 = toolResult("inspect-selected-v2", "selected-large-".repeat(1_024));
	const mixedMessages: AgentMessage[] = [selectedV2];
	for (let index = 0; index < 128; index++) mixedMessages.push(toolResult(`inspect-mixed-v1-${index}`, `small-${index}`));
	mixedMessages.push(toolResult("inspect-mixed-hot-v1", "hot-small"));
	const mixedFixture = await createModeFixture(mixedMessages, "enabled");
	const mixedOwner = (mixedFixture.session as unknown as {
		_toolResultPresentation?: { counters: ToolResultPresentationCounters };
	})._toolResultPresentation;
	const mixedHot = mixedFixture.session.agent.state.messages.at(-1);
	if (!mixedOwner || mixedHot?.role !== "toolResult") throw new Error("mixed inspection fixture is incomplete");
	mixedFixture.session.getToolResultPresentationForUi(mixedHot);
	const mixedBefore = { ...mixedOwner.counters };
	const mixedSelected = new Map<ToolResultMessage, ToolResultPresentation>();
	mixedFixture.session.collectRecentToolResultPresentationsForUi(mixedSelected, 128);
	const mixedCounts = mixedFixture.session.getToolResultPresentationUiRebuildCounts();
	const mixedAfterInspection = { ...mixedOwner.counters };
	await mixedFixture.session.agent.convertToLlm([mixedHot]);
	const mixed = {
		candidatesEvaluated: mixedCounts.presentationCandidatesEvaluated,
		actualDiscoveries: mixedSelected.size,
		presentationAdmissions: mixedAfterInspection.presentationObjectsCreated - mixedBefore.presentationObjectsCreated,
		entryDelta: mixedAfterInspection.projectionRecordEntries - mixedBefore.projectionRecordEntries,
		evictionDelta: mixedAfterInspection.projectionRecordEvictions - mixedBefore.projectionRecordEvictions,
		providerFullSourceScanDelta:
			mixedOwner.counters.fullSourceEstimatorScans - mixedAfterInspection.fullSourceEstimatorScans,
		providerResidentHitDelta: mixedOwner.counters.residentReadHits - mixedAfterInspection.residentReadHits,
	};
	mixedSelected.clear();
	await mixedFixture.dispose();
	return { allV1, mixed, fallbackEstimatorAllocationContract };
}

async function measureSetupReplacedHistoryRebind(): Promise<{
	historyMessages: number;
	firstRebindBuildProbeDelta: number;
	firstRebindRebuildDelta: number;
	repeatedRebindBuildProbeDelta: number;
	repeatedRebindRebuildDelta: number;
	firstLiveBuildProbeDelta: number;
	firstLiveAppendProbeDelta: number;
	firstLiveLookupProbeDelta: number;
}> {
	const fixture = await createModeFixture([], "enabled");
	const setupMessages: AgentMessage[] = [];
	for (let index = 0; index < 64; index++) setupMessages.push(toolResult(`setup-profile-${index}`, "small"));
	const historyMessages = setupMessages.length;
	fixture.session.agent.state.messages = setupMessages;
	const before = fixture.session.getToolResultPresentationUiRebuildCounts();
	fixture.mode.renderInitialMessages();
	const afterFirst = fixture.session.getToolResultPresentationUiRebuildCounts();
	fixture.mode.renderInitialMessages();
	const afterRepeated = fixture.session.getToolResultPresentationUiRebuildCounts();
	fixture.internals.isInitialized = true;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	try {
		await runLiveToolResult(fixture, 64);
	} finally {
		unsubscribe();
	}
	const afterLive = fixture.session.getToolResultPresentationUiRebuildCounts();
	await fixture.dispose();
	return {
		historyMessages,
		firstRebindBuildProbeDelta: afterFirst.liveCanonicalIndexBuildProbes - before.liveCanonicalIndexBuildProbes,
		firstRebindRebuildDelta: afterFirst.liveCanonicalIndexRebuilds - before.liveCanonicalIndexRebuilds,
		repeatedRebindBuildProbeDelta:
			afterRepeated.liveCanonicalIndexBuildProbes - afterFirst.liveCanonicalIndexBuildProbes,
		repeatedRebindRebuildDelta: afterRepeated.liveCanonicalIndexRebuilds - afterFirst.liveCanonicalIndexRebuilds,
		firstLiveBuildProbeDelta: afterLive.liveCanonicalIndexBuildProbes - afterRepeated.liveCanonicalIndexBuildProbes,
		firstLiveAppendProbeDelta: afterLive.liveCanonicalIndexAppendProbes - afterRepeated.liveCanonicalIndexAppendProbes,
		firstLiveLookupProbeDelta: afterLive.liveCanonicalLookupProbes - afterRepeated.liveCanonicalLookupProbes,
	};
}

async function captureProductionLifecycleRefs(): Promise<{
	component: WeakRef<object>;
	discovery: WeakRef<object>;
	registration: WeakRef<object>;
	source: WeakRef<object>;
	validation: WeakRef<object>;
	releasedProjectionRecordEntries: number;
	releasedProjectionCodeUnits: number;
}> {
	const fixture = await createModeFixture([], "enabled", true);
	fixture.internals.isInitialized = true;
	let presentation: ToolResultPresentation | undefined;
	const unsubscribe = fixture.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult") presentation = event.toolResultPresentation;
		return fixture.internals.handleEvent(event);
	});
	let registration: object | undefined;
	const component = await runLiveToolResult(fixture, 99_999, (value) => {
		registration = value;
	});
	const discovery = component.getToolResultPresentationDiscovery("live-profile-99999");
	const source = fixture.session.agent.state.messages.at(-1)?.role === "toolResult"
		? fixture.session.agent.state.messages.at(-1)!.content
		: undefined;
	const owner = (fixture.session as unknown as {
		_toolResultPresentation?: {
			projectionRecords?: Map<string, object>;
			counters: { projectionRecordEntries: number; retainedProjectionCodeUnits: number };
		};
	})._toolResultPresentation;
	const validation = owner?.projectionRecords?.values().next().value;
	if (!owner || !registration || !discovery || !source || !validation || !presentation) {
		throw new Error("production lifecycle fixture did not expose every owned reference");
	}
	const refs = {
		component: new WeakRef<object>(component),
		discovery: new WeakRef<object>(discovery),
		registration: new WeakRef<object>(registration),
		source: new WeakRef<object>(source),
		validation: new WeakRef<object>(validation),
	};
	fixture.internals.clearToolResultDiscoveries();
	fixture.session.agent.state.messages.length = 0;
	unsubscribe();
	presentation = undefined;
	registration = undefined;
	await fixture.dispose();
	return {
		...refs,
		releasedProjectionRecordEntries: owner.counters.projectionRecordEntries,
		releasedProjectionCodeUnits: owner.counters.retainedProjectionCodeUnits,
	};
}

async function captureInspectionTransientSourceRef(): Promise<WeakRef<object>> {
	const message = toolResult("inspection-lifecycle-v1", "inspection-lifecycle-small");
	const fixture = await createModeFixture([message], "enabled");
	const source = fixture.session.agent.state.messages[0];
	if (source?.role !== "toolResult") throw new Error("inspection lifecycle source is unavailable");
	const sourceRef = new WeakRef<object>(source.content);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	if (selected.size !== 0) throw new Error("inspection lifecycle V1 unexpectedly produced a discovery");
	fixture.session.agent.state.messages.length = 0;
	await fixture.dispose();
	return sourceRef;
}

async function measureProfile(
	inspector: Session,
	component: Component & { setExpanded(expanded: boolean): void },
): Promise<UiProfile> {
	for (let index = 0; index < 100; index++) {
		component.setExpanded(index % 2 === 0);
		component.render(60 + (index % 4) * 12);
	}
	await forceCollection();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const durations = new Array<number>(PROFILE_ITERATIONS);
	for (let index = 0; index < PROFILE_ITERATIONS; index++) {
		const started = performance.now();
		component.setExpanded(index % 2 === 0);
		component.render(60 + (index % 4) * 12);
		durations[index] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	durations.sort((left, right) => left - right);
	const allocations = allocationSites(stopped.profile.head as SamplingNode);
	return {
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		p99Ms: percentile(durations, 0.99),
		cv: coefficientOfVariation(durations),
		sampledAllocationBytes: allocations.sampledBytes,
		sampledBytesPerToggleAndRender: allocations.sampledBytes / PROFILE_ITERATIONS,
		topAllocationSites: allocations.top,
	};
}

async function measureBoxCacheHitProfile(inspector: Session): Promise<BoxCacheProfile> {
	const box = new Box(0, 0);
	box.addChild(new MutableBoxChild());
	let cachedLines = box.render(80);
	for (let index = 0; index < 100; index++) {
		const lines = box.render(80);
		if (lines !== cachedLines) throw new Error("Box warmup cache hit changed lines identity");
		cachedLines = lines;
	}
	await forceCollection();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	let cacheHits = 0;
	for (let index = 0; index < PROFILE_ITERATIONS; index++) {
		const lines = box.render(80);
		if (lines === cachedLines) cacheHits++;
		cachedLines = lines;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	const allocations = allocationSites(stopped.profile.head as SamplingNode);
	box[RELEASE_COMPONENT_RENDER_CACHE]();
	return {
		iterations: PROFILE_ITERATIONS,
		cacheHits,
		sampledAllocationBytes: allocations.sampledBytes,
		sampledBytesPerCacheHitRender: allocations.sampledBytes / PROFILE_ITERATIONS,
		topAllocationSites: allocations.top,
	};
}

async function measureExactResidentTouchProfile(inspector: Session): Promise<{
	iterations: number;
	successfulTouches: number;
	fullSourceScanDelta: number;
	sourceDigestDelta: number;
	evictionDelta: number;
	entryDelta: number;
	retainedCodeUnitDelta: number;
	sampledAllocationBytes: number;
	sampledTouchMethodBytes: number;
	topAllocationSites: AllocationSite[];
}> {
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-touch-profile")!;
	const contents = new Array<ToolResultPresentationContent[]>(128);
	const toolCallIds = new Array<string>(128);
	for (let index = 0; index < contents.length; index++) {
		const entry: ToolResultPresentationContent[] = [{ type: "text", text: `touch-profile-${index}` }];
		const toolCallId = `touch-profile-${index}`;
		contents[index] = entry;
		toolCallIds[index] = toolCallId;
		owner.create(entry, toolCallId);
		owner.release();
	}
	for (let index = 0; index < contents.length; index++) {
		owner.touchExactResidentProjectionRecord(contents[index]!, toolCallIds[index]!);
	}
	await forceCollection();
	const counters = owner.counters;
	const scansBefore = counters.fullSourceEstimatorScans;
	const digestsBefore = counters.sourceDigestConstructions;
	const evictionsBefore = counters.projectionRecordEvictions;
	const entriesBefore = counters.projectionRecordEntries;
	const retainedBefore = counters.retainedProjectionCodeUnits;
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	let successfulTouches = 0;
	for (let index = 0; index < PROFILE_ITERATIONS; index++) {
		const entryIndex = index % contents.length;
		if (owner.touchExactResidentProjectionRecord(
			contents[entryIndex]!,
			toolCallIds[entryIndex]!,
		)) successfulTouches++;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	const allocations = allocationSites(stopped.profile.head as SamplingNode);
	let sampledTouchMethodBytes = 0;
	for (let index = 0; index < allocations.top.length; index++) {
		const site = allocations.top[index]!;
		if (site.functionName === "touchExactResidentProjectionRecord") sampledTouchMethodBytes += site.bytes;
	}
	const result = {
		iterations: PROFILE_ITERATIONS,
		successfulTouches,
		fullSourceScanDelta: counters.fullSourceEstimatorScans - scansBefore,
		sourceDigestDelta: counters.sourceDigestConstructions - digestsBefore,
		evictionDelta: counters.projectionRecordEvictions - evictionsBefore,
		entryDelta: counters.projectionRecordEntries - entriesBefore,
		retainedCodeUnitDelta: counters.retainedProjectionCodeUnits - retainedBefore,
		sampledAllocationBytes: allocations.sampledBytes,
		sampledTouchMethodBytes,
		topAllocationSites: allocations.top,
	};
	owner.dispose();
	return result;
}

function captureReleasedFixtures(
	start: number,
	count: number,
	componentRefs: WeakRef<object>[],
	discoveryRefs: WeakRef<object>[],
): void {
	for (let index = 0; index < count; index++) {
		const fixture = createAttachedComponent(start + index);
		fixture.component.setExpanded(true);
		fixture.component.render(80);
		componentRefs.push(new WeakRef(fixture.component));
		discoveryRefs.push(new WeakRef(fixture.discovery));
		fixture.dispose();
	}
}

function createAndReleaseBatch(start: number, count: number): void {
	for (let index = 0; index < count; index++) {
		const fixture = createAttachedComponent(start + index);
		fixture.component.setExpanded(true);
		fixture.component.render(80);
		fixture.dispose();
	}
}

if (!globalThis.gc) throw new Error("Run with --expose-gc");
setKeybindings(new KeybindingsManager());
initTheme("dark");
const commit = git(["rev-parse", "HEAD"]);
const worktreeStatusBefore = git(["status", "--porcelain"]);
const sourceAudit = auditToolResultPresentationUiSources();
const inspector = new Session();
inspector.connect();

const plainProfiled = createPlainComponent("ui-profile-plain");
const plainProfile = await measureProfile(inspector, plainProfiled);
plainProfiled[RELEASE_COMPONENT_RENDER_CACHE]();
const profiled = createAttachedComponent(0);
const discoveryProfile = await measureProfile(inspector, profiled.component);
profiled.dispose();
const groupedFixture = createGroupedReadFixture();
const groupedExpandedProfile = await measureProfile(inspector, groupedFixture.component);
groupedFixture.dispose();
const boxCacheHitProfile = await measureBoxCacheHitProfile(inspector);
const exactResidentTouchProfile = await measureExactResidentTouchProfile(inspector);
const defaultOffAbsent = await measureDefaultOffProduction("absent");
const defaultOffDisabled = await measureDefaultOffProduction("disabled");
const liveRegistrationProfile = await measureLiveRegistrationProfile(inspector);
const teardown128 = await measureTeardown128();
const chronologicalEviction = await measureChronologicalEviction();
const mixedHistoryRebuild = await measureMixedHistoryRebuild();
const sharedOwnerUiRebuild = await measureSharedOwnerUiRebuild();
const nonAdmittingCandidateInspection = await measureNonAdmittingCandidateInspection();
const setupReplacedHistoryRebind = await measureSetupReplacedHistoryRebind();
const productionLifecycleRefs = await captureProductionLifecycleRefs();
const inspectionTransientSourceRef = await captureInspectionTransientSourceRef();

const componentRefs: WeakRef<object>[] = [];
const discoveryRefs: WeakRef<object>[] = [];
const boxCache = measureBoxCache();
const releasedBoxCache = captureReleasedBoxCache();
captureReleasedFixtures(1, GC_CYCLES * COMPONENTS_PER_GC_CYCLE, componentRefs, discoveryRefs);
await forceCollection();
const liveComponentWeakRefs = componentRefs.reduce((count, ref) => count + (ref.deref() ? 1 : 0), 0);
const liveDiscoveryWeakRefs = discoveryRefs.reduce((count, ref) => count + (ref.deref() ? 1 : 0), 0);
const liveProductionComponentWeakRefs = productionLifecycleRefs.component.deref() ? 1 : 0;
const liveProductionDiscoveryWeakRefs = productionLifecycleRefs.discovery.deref() ? 1 : 0;
const liveProductionRegistrationWeakRefs = productionLifecycleRefs.registration.deref() ? 1 : 0;
const liveProductionSourceWeakRefs = productionLifecycleRefs.source.deref() ? 1 : 0;
const liveProductionValidationWeakRefs = productionLifecycleRefs.validation.deref() ? 1 : 0;
const liveInspectionTransientSourceWeakRefs = inspectionTransientSourceRef.deref() ? 1 : 0;
const liveBoxCacheWeakRefs = releasedBoxCache.cacheRef.deref() ? 1 : 0;
const releasedBoxOwnerChildCount = releasedBoxCache.owner.children.length;
const heapSamples: number[] = [];
for (let cycle = 0; cycle < GC_CYCLES; cycle++) {
	createAndReleaseBatch(10_000 + cycle * COMPONENTS_PER_GC_CYCLE, COMPONENTS_PER_GC_CYCLE);
	await forceCollection();
	heapSamples.push(process.memoryUsage().heapUsed);
}
await forceCollection();

const disabled = new ToolExecutionComponent(
	"fixture",
	"disabled-ui",
	{},
	{ showImages: false },
	undefined,
	createTui(),
	process.cwd(),
);
disabled.updateResult({ content: [{ type: "text", text: "small" }] });
const disabledDiscoveryState = disabled.getToolResultPresentationDiscovery("disabled-ui") ? 1 : 0;
disabled[RELEASE_COMPONENT_RENDER_CACHE]();

const result = {
	commit,
	worktreeStatusBefore,
	worktreeStatusAfter: git(["status", "--porcelain"]),
	profile: {
		iterations: PROFILE_ITERATIONS,
		plainFullResultUi: plainProfile,
		boundedDiscoveryUi: discoveryProfile,
		groupedReadExpandedUi: groupedExpandedProfile,
		liveRegistrationEventPath: liveRegistrationProfile,
		boxCacheHit: boxCacheHitProfile,
		exactResidentTouch: exactResidentTouchProfile,
		incremental: {
			p50Ms: discoveryProfile.p50Ms - plainProfile.p50Ms,
			p95Ms: discoveryProfile.p95Ms - plainProfile.p95Ms,
			p99Ms: discoveryProfile.p99Ms - plainProfile.p99Ms,
			sampledBytesPerToggleAndRender:
				discoveryProfile.sampledBytesPerToggleAndRender - plainProfile.sampledBytesPerToggleAndRender,
		},
	},
	defaultOffSerial: {
		absent: defaultOffAbsent,
		disabled: defaultOffDisabled,
	},
	teardown128,
	chronologicalEviction,
	mixedHistoryRebuild,
	sharedOwnerUiRebuild,
	nonAdmittingCandidateInspection,
	setupReplacedHistoryRebind,
	lifecycle: {
		cycles: GC_CYCLES,
		componentsCreated: componentRefs.length,
		liveComponentWeakRefs,
		liveDiscoveryWeakRefs,
		liveProductionComponentWeakRefs,
		liveProductionDiscoveryWeakRefs,
		liveProductionRegistrationWeakRefs,
		liveProductionSourceWeakRefs,
		liveProductionValidationWeakRefs,
		liveInspectionTransientSourceWeakRefs,
		releasedProjectionRecordEntries: productionLifecycleRefs.releasedProjectionRecordEntries,
		releasedProjectionCodeUnits: productionLifecycleRefs.releasedProjectionCodeUnits,
		liveBoxCacheWeakRefs,
		releasedBoxOwnerChildCount,
		heapSlopeBytesPerCycle: slope(heapSamples.slice(8)),
		heapTailSlopeBytesPerCycle: slope(heapSamples.slice(-8)),
		heapSamples,
	},
	boxCache,
	structure: {
		defaultOffDiscoveryStates: disabledDiscoveryState,
		...sourceAudit,
	},
};

inspector.disconnect();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
