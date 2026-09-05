import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	Box,
	getCapabilities,
	Image,
	RELEASE_COMPONENT_RENDER_CACHE,
	setCapabilities,
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
import type { LoadedPngConverter } from "../../packages/coding-agent/src/utils/image-convert.ts";
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

function measureGroupedImageSettings(): {
	visibleImageComponents: number;
	hiddenImageComponents: number;
	restoredImageComponents: number;
	unsupportedImageComponents: number;
	restoredMaxWidthCells: number | undefined;
} {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	try {
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-grouped-image-profile")!;
		const component = new ReadToolGroupComponent(true, 19);
		const toolCallId = "grouped-image-profile";
		const rowContent: ToolResultPresentationContent[] = [
			{ type: "text", text: "grouped-image-profile-".repeat(1_024) },
			{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
		];
		component.updateArgs(toolCallId, { path: "grouped-image.txt" });
		component.setArgsComplete(toolCallId);
		component.updateResult(toolCallId, { content: rowContent });
		component.setToolResultPresentation(toolCallId, owner.create(rowContent, toolCallId)!);
		owner.release();
		component.setExpanded(true);
		const visibleImageComponents = component.children.reduce(
			(count, child) => count + (child instanceof Image ? 1 : 0),
			0,
		);
		component.setShowImages(false);
		const hiddenImageComponents = component.children.reduce(
			(count, child) => count + (child instanceof Image ? 1 : 0),
			0,
		);
		component.setImageWidthCells(37);
		component.setShowImages(true);
		const restored = component.children.find((child): child is Image => child instanceof Image);
		const restoredImageComponents = restored ? 1 : 0;
		const restoredMaxWidthCells = restored
			? (restored as unknown as { options: { maxWidthCells?: number } }).options.maxWidthCells
			: undefined;
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		component.invalidate();
		const unsupportedImageComponents = component.children.reduce(
			(count, child) => count + (child instanceof Image ? 1 : 0),
			0,
		);
		owner.dispose();
		return {
			visibleImageComponents,
			hiddenImageComponents,
			restoredImageComponents,
			unsupportedImageComponents,
			restoredMaxWidthCells,
		};
	} finally {
		setCapabilities(previousCapabilities);
	}
}

type GroupedConvertedImage = { data: string; mimeType: string };

class BenchReadToolGroupComponent extends ReadToolGroupComponent {
	readonly conversions: Array<{ data: string; mimeType: string }> = [];
	private resolveLoader: ((value: LoadedPngConverter | null) => void) | undefined;

	protected override loadImageConverterForTerminal(): Promise<LoadedPngConverter | null> {
		return new Promise<LoadedPngConverter | null>((resolve) => {
			this.resolveLoader = resolve;
		});
	}

	protected override convertImageWithLoadedConverter(
		_converter: LoadedPngConverter,
		data: string,
		mimeType: string,
	): GroupedConvertedImage | null {
		this.conversions.push({ data, mimeType });
		return { data: "converted-png", mimeType: "image/png" };
	}

	settleLoader(): void { this.resolveLoader?.({} as LoadedPngConverter); }
}

const NEVER_SETTLING_GROUPED_CONVERTER = new Promise<LoadedPngConverter | null>(() => {});

class NeverSettlingBenchReadToolGroupComponent extends ReadToolGroupComponent {
	protected override loadImageConverterForTerminal(): Promise<LoadedPngConverter | null> {
		return NEVER_SETTLING_GROUPED_CONVERTER;
	}
}

function captureNeverSettlingGroupedConverterRefs(): {
	component: WeakRef<object>;
	row: WeakRef<object>;
	result: WeakRef<object>;
	content: WeakRef<object>;
	imageBlock: WeakRef<object>;
	lifecycle: ReturnType<ReadToolGroupComponent["getGroupedImageConversionLifecycleCounts"]>;
} {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const component = new NeverSettlingBenchReadToolGroupComponent(true, 31);
		const imageBlock = {
			type: "image" as const,
			data: Buffer.alloc(512 * 1024, 0x51).toString("base64"),
			mimeType: "image/jpeg",
		};
		const content: ToolResultPresentationContent[] = [
			{ type: "text", text: "never-settling-profile-".repeat(1_024) },
			imageBlock,
		];
		const result = { content };
		const toolCallId = "never-settling-profile";
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, toolCallId)!;
		component.updateArgs(toolCallId, { path: "never-settling.jpg" });
		component.setArgsComplete(toolCallId);
		component.updateResult(toolCallId, result);
		component.setToolResultPresentation(toolCallId, owner.create(content, toolCallId)!);
		owner.release();
		component.setExpanded(true);
		const row = (component as unknown as { rows: Map<string, object> }).rows.get(toolCallId)!;
		const lifecycle = component.getGroupedImageConversionLifecycleCounts();
		const refs = {
			component: new WeakRef<object>(component),
			row: new WeakRef<object>(row),
			result: new WeakRef<object>(result),
			content: new WeakRef<object>(content),
			imageBlock: new WeakRef<object>(imageBlock),
			lifecycle,
		};
		component[RELEASE_COMPONENT_RENDER_CACHE]();
		owner.dispose();
		return refs;
	} finally {
		setCapabilities(previousCapabilities);
	}
}

async function measureGroupedCloseoutLifecycle(): Promise<{
	nonV2: {
		tailVisible: boolean;
		truncationVisible: boolean;
		conversionScheduled: number;
		renderedCodeUnits: number;
		sourceTextCodeUnits: number;
	};
	v2Kitty: {
		fullTailVisible: boolean;
		rawImageComponentsBeforeConversion: number;
		conversionsScheduled: number;
		conversionsAccepted: number;
		imageComponentsAfterConversion: number;
		visualInvalidations: number;
	};
	released: {
		activePending: number;
		convertedImages: number;
		sourceReferences: number;
	};
}> {
	const nonV2 = new BenchReadToolGroupComponent(true, 31);
	nonV2.updateArgs("grouped-non-v2", { path: "non-v2.txt" });
	nonV2.setArgsComplete("grouped-non-v2");
	const nonV2FirstText = "non-v2-prefix-".repeat(400);
	const nonV2TailText = "NON_V2_BENCH_TAIL";
	nonV2.updateResult("grouped-non-v2", {
		content: [
			{ type: "text", text: nonV2FirstText },
			{ type: "text", text: nonV2TailText },
			{ type: "image", data: "non-v2-jpeg", mimeType: "image/jpeg" },
		],
	});
	nonV2.setExpanded(true);
	const nonV2Rendered = nonV2.render(120).join("\n");
	const nonV2Evidence = {
		tailVisible: nonV2Rendered.includes("NON_V2_BENCH_TAIL"),
		truncationVisible: nonV2Rendered.includes("truncated"),
		conversionScheduled: nonV2.getGroupedImageConversionLifecycleCounts().scheduled,
		renderedCodeUnits: nonV2Rendered.length,
		sourceTextCodeUnits: nonV2FirstText.length + 1 + nonV2TailText.length,
	};
	nonV2[RELEASE_COMPONENT_RENDER_CACHE]();

	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		let visualInvalidations = 0;
		const component = new BenchReadToolGroupComponent(true, 31, () => { visualInvalidations++; });
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "grouped-closeout-bench")!;
		const toolCallId = "grouped-v2-kitty";
		const rowContent: ToolResultPresentationContent[] = [
			{ type: "text", text: `${"v2-full-prefix-".repeat(400)}V2_FULL_BENCH_TAIL` },
			{ type: "image", data: "v2-jpeg", mimeType: "image/jpeg" },
		];
		component.updateArgs(toolCallId, { path: "v2-kitty.txt" });
		component.setArgsComplete(toolCallId);
		component.updateResult(toolCallId, { content: rowContent });
		component.setToolResultPresentation(toolCallId, owner.create(rowContent, toolCallId)!);
		owner.release();
		component.setExpanded(true);
		const fullTailVisible = component.render(120).join("\n").includes("V2_FULL_BENCH_TAIL");
		const before = component.getGroupedImageConversionLifecycleCounts();
		component.settleLoader();
		await Promise.resolve();
		await Promise.resolve();
		const after = component.getGroupedImageConversionLifecycleCounts();
		const v2Kitty = {
			fullTailVisible,
			rawImageComponentsBeforeConversion: before.imageComponents,
			conversionsScheduled: after.scheduled,
			conversionsAccepted: after.accepted,
			imageComponentsAfterConversion: after.imageComponents,
			visualInvalidations,
		};
		component[RELEASE_COMPONENT_RENDER_CACHE]();
		const releasedCounts = component.getGroupedImageConversionLifecycleCounts();
		owner.dispose();
		return {
			nonV2: nonV2Evidence,
			v2Kitty,
			released: {
				activePending: releasedCounts.activePending,
				convertedImages: releasedCounts.convertedImages,
				sourceReferences: releasedCounts.sourceReferences,
			},
		};
	} finally {
		setCapabilities(previousCapabilities);
	}
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
	createTrackedToolComponent(
		toolName: string,
		toolCallId: string,
		args: unknown,
		placeholder?: Component,
		allowReadGrouping?: boolean,
	): ToolExecutionComponent | ReadToolGroupComponent;
	pendingToolResultDiscoveries?: Map<string, object>;
	attachedToolResultDiscoveries?: Map<string, object>;
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
		pendingEntries: number;
		attachedEntries: number;
		totalEntries: number;
		pendingHighWaterMark: number;
		attachedHighWaterMark: number;
		totalHighWaterMark: number;
		attachedCapacityEvictions: number;
		ambiguityRemovals: number;
		pendingCompletionReleases: number;
		pendingTeardownReleases: number;
		attachedTeardownReleases: number;
		pendingMapsCreated: number;
		attachedMapsCreated: number;
		canonicalV1RetainedInvalidations: number;
		canonicalHistoryResetReleases: number;
		canonicalHistoryResetRegistrationReleases: number;
		canonicalHistoryResetUniqueComponentRefreshes: number;
		canonicalPayloadRefreshes: number;
		canonicalPayloadRefreshSkips: number;
		canonicalPayloadConservativeHandlerRefreshes: number;
		canonicalPayloadReplacementRefreshes: number;
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
	messageEndExtension: false | true | "no-op" | "in-place" = false,
	replacementText = "post-extension-profile-".repeat(1_024),
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
		noExtensions: messageEndExtension === false,
		extensionFactories: messageEndExtension !== false
			? [(pi: any) => {
				pi.on("message_end", (event: { message: ToolResultMessage }) => {
					if (event.message.role !== "toolResult") return undefined;
					if (messageEndExtension === "no-op") return undefined;
					if (messageEndExtension === "in-place") {
						const block = event.message.content[0];
						if (block?.type === "text") block.text = replacementText;
						return undefined;
					}
					return {
						message: {
							...event.message,
							content: [{ type: "text", text: replacementText }],
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
	const registration = fixture.internals.pendingToolResultDiscoveries?.get(toolCallId);
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

async function measureCanonicalDispositionMatrix(): Promise<Record<
	"zeroHandler" | "noOpHandler" | "inPlaceMutation" | "returnedReplacement",
	{
		disposition: string | undefined;
		refreshes: number;
		skips: number;
		conservativeRefreshes: number;
		replacementRefreshes: number;
		attached: number;
	}
>> {
	const cases = [
		["zeroHandler", false, "ZERO_HANDLER_PROFILE"],
		["noOpHandler", "no-op", "NO_OP_HANDLER_PROFILE"],
		["inPlaceMutation", "in-place", "IN_PLACE_MUTATION_PROFILE"],
		["returnedReplacement", true, "RETURNED_REPLACEMENT_PROFILE"],
	] as const;
	const output = {} as Record<
		"zeroHandler" | "noOpHandler" | "inPlaceMutation" | "returnedReplacement",
		{
			disposition: string | undefined;
			refreshes: number;
			skips: number;
			conservativeRefreshes: number;
			replacementRefreshes: number;
			attached: number;
		}
	>;
	for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
		const [label, extension, replacementText] = cases[caseIndex]!;
		const fixture = await createModeFixture([], "enabled", extension, replacementText.repeat(1_024));
		fixture.internals.isInitialized = true;
		let disposition: string | undefined;
		const unsubscribe = fixture.session.subscribe((event) => {
			if (event.type === "message_end") disposition = event.toolResultMessageEndDisposition;
			return fixture.internals.handleEvent(event);
		});
		await runLiveToolResult(fixture, 40_000 + caseIndex);
		const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		output[label] = {
			disposition,
			refreshes: lifecycle.canonicalPayloadRefreshes,
			skips: lifecycle.canonicalPayloadRefreshSkips,
			conservativeRefreshes: lifecycle.canonicalPayloadConservativeHandlerRefreshes,
			replacementRefreshes: lifecycle.canonicalPayloadReplacementRefreshes,
			attached: lifecycle.attached,
		};
		unsubscribe();
		await fixture.dispose();
	}
	return output;
}

async function measureGroupedCompactionDeduplication(): Promise<Array<{
	registrations: number;
	registrationReleases: number;
	uniqueComponentRefreshes: number;
	observedComponentRefreshCalls: number;
	attachedAfter: number;
	capacityEvictionDelta: number;
}>> {
	const groupSizes = [1, 32, 128] as const;
	const output: Array<{
		registrations: number;
		registrationReleases: number;
		uniqueComponentRefreshes: number;
		observedComponentRefreshCalls: number;
		attachedAfter: number;
		capacityEvictionDelta: number;
	}> = [];
	for (const groupSize of groupSizes) {
		const fixture = await createModeFixture([], "enabled");
		fixture.internals.isInitialized = true;
		const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
		let group: ReadToolGroupComponent | undefined;
		for (let index = 0; index < groupSize; index++) {
			const toolCallId = `grouped-reset-${groupSize}-${index}`;
			const component = fixture.internals.createTrackedToolComponent(
				"read",
				toolCallId,
				{ path: `${index}.txt` },
				undefined,
				true,
			);
			if (!(component instanceof ReadToolGroupComponent)) throw new Error("grouped compaction fixture lost grouping");
			group ??= component;
			if (group !== component) throw new Error("grouped compaction fixture created more than one component");
			const message: ToolResultMessage = {
				...toolResult(toolCallId, `grouped-reset-${groupSize}-${index}-`.repeat(1_024)),
				toolName: "read",
			};
			await fixture.internals.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "read",
				result: { content: message.content, isError: false },
				isError: false,
			});
			fixture.session.agent.state.messages.push(message);
			await (fixture.session as unknown as {
				_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message });
		}
		if (!group) throw new Error("grouped compaction fixture produced no component");
		const originalRefresh = group.refreshToolResultPresentationView;
		let observedComponentRefreshCalls = 0;
		group.refreshToolResultPresentationView = function (): void {
			observedComponentRefreshCalls++;
			return originalRefresh.call(this);
		};
		const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		await fixture.internals.handleEvent({
			type: "compaction_end",
			reason: "manual",
			result: { summary: "grouped reset benchmark", firstKeptEntryId: "kept", tokensBefore: 16_384 },
			aborted: false,
			willRetry: false,
		});
		const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		output.push({
			registrations: groupSize,
			registrationReleases:
				after.canonicalHistoryResetRegistrationReleases - before.canonicalHistoryResetRegistrationReleases,
			uniqueComponentRefreshes:
				after.canonicalHistoryResetUniqueComponentRefreshes - before.canonicalHistoryResetUniqueComponentRefreshes,
			observedComponentRefreshCalls,
			attachedAfter: after.attached,
			capacityEvictionDelta: after.attachedCapacityEvictions - before.attachedCapacityEvictions,
		});
		group.refreshToolResultPresentationView = originalRefresh;
		unsubscribe();
		await fixture.dispose();
	}
	return output;
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
		durations[index] = performance.now() - started;
	}
	fixture.internals.clearToolResultDiscoveries();
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

async function captureCanonicalReplacementLifecycle(inspector: Session): Promise<{
	evidence: {
		canonicalV1: {
			oldTextVisibleBefore: boolean;
			oldTextVisibleAfter: boolean;
			newTextVisibleAfter: boolean;
			retainedInvalidationDelta: number;
			canonicalPayloadRefreshDelta: number;
			canonicalPayloadReplacementRefreshDelta: number;
			pendingAfter: number;
			attachedAfter: number;
		};
		compactionReset: {
			attachedBefore: number;
			pendingBefore: number;
			attachedAfter: number;
			pendingAfter: number;
			canonicalHistoryResetReleases: number;
			canonicalHistoryResetUniqueComponentRefreshes: number;
			pendingTeardownReleaseDelta: number;
			retainedInvalidations: number;
			staleDiscoveriesAfter: number;
			capacityEvictionDelta: number;
			fullSourceScanDelta: number;
			sourceDigestDelta: number;
			artifactIntegrityScanDelta: number;
			modelProjectionDelta: number;
			releasedProjectionRecordEntries: number;
			releasedProjectionCodeUnits: number;
			sampledAllocationBytes: number;
			topAllocationSites: AllocationSite[];
		};
	};
	component: WeakRef<object>;
	discovery: WeakRef<object>;
	attachedRegistration: WeakRef<object>;
	pendingRegistration: WeakRef<object>;
	attachedSource: WeakRef<object>;
	pendingSource: WeakRef<object>;
}> {
	const v1Fixture = await createModeFixture([], "enabled", true, "POST_EXTENSION_V1");
	v1Fixture.internals.isInitialized = true;
	const v1Unsubscribe = v1Fixture.session.subscribe((event) => v1Fixture.internals.handleEvent(event));
	const v1ToolCallId = "canonical-v1-profile";
	await v1Fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: v1ToolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const v1Message = toolResult(v1ToolCallId, "PRE_EXTENSION_V1");
	await v1Fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: v1ToolCallId,
		toolName: "fixture-tool",
		result: { content: v1Message.content, isError: false },
		isError: false,
	});
	const v1RenderedBefore = v1Fixture.internals.chatContainer.render(100).join("\n");
	const v1Before = v1Fixture.internals.getToolResultDiscoveryLifecycleCounts();
	v1Fixture.session.agent.state.messages.push(v1Message);
	await (v1Fixture.session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message: v1Message });
	const v1After = v1Fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const v1RenderedAfter = v1Fixture.internals.chatContainer.render(100).join("\n");
	const canonicalV1 = {
		oldTextVisibleBefore: v1RenderedBefore.includes("PRE_EXTENSION_V1"),
		oldTextVisibleAfter: v1RenderedAfter.includes("PRE_EXTENSION_V1"),
		newTextVisibleAfter: v1RenderedAfter.includes("POST_EXTENSION_V1"),
		retainedInvalidationDelta:
			v1After.canonicalV1RetainedInvalidations - v1Before.canonicalV1RetainedInvalidations,
		canonicalPayloadRefreshDelta:
			v1After.canonicalPayloadRefreshes - v1Before.canonicalPayloadRefreshes,
		canonicalPayloadReplacementRefreshDelta:
			v1After.canonicalPayloadReplacementRefreshes - v1Before.canonicalPayloadReplacementRefreshes,
		pendingAfter: v1After.pending,
		attachedAfter: v1After.attached,
	};
	v1Unsubscribe();
	await v1Fixture.dispose();

	const fixture = await createModeFixture([], "enabled");
	fixture.internals.isInitialized = true;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	const components = new Array<ToolExecutionComponent>(128);
	for (let index = 0; index < components.length; index++) {
		components[index] = await runLiveToolResult(fixture, 300_000 + index);
	}
	const attachedEntries = fixture.internals.attachedToolResultDiscoveries as Map<string, {
		component: object;
		sourceContent: object;
	}>;
	const firstAttached = attachedEntries.values().next().value;
	if (!firstAttached) throw new Error("compaction reset fixture missed an attached registration");
	const firstDiscovery = components[0]!.getToolResultPresentationDiscovery("live-profile-300000");
	if (!firstDiscovery) throw new Error("compaction reset fixture missed a discovery");
	const pendingToolCallId = "compaction-reset-pending-profile";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: pendingToolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const pendingMessage = toolResult(pendingToolCallId, "compaction-reset-pending-profile-".repeat(1_024));
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: pendingToolCallId,
		toolName: "fixture-tool",
		result: { content: pendingMessage.content, isError: false },
		isError: false,
	});
	const pendingRegistration = fixture.internals.pendingToolResultDiscoveries?.get(pendingToolCallId) as {
		component: object;
		sourceContent: object;
	} | undefined;
	if (!pendingRegistration) throw new Error("compaction reset fixture missed a pending registration");
	const componentRef = new WeakRef<object>(components[0]!);
	const discoveryRef = new WeakRef<object>(firstDiscovery);
	const attachedRegistrationRef = new WeakRef<object>(firstAttached);
	const pendingRegistrationRef = new WeakRef<object>(pendingRegistration);
	const attachedSourceRef = new WeakRef<object>(firstAttached.sourceContent);
	const pendingSourceRef = new WeakRef<object>(pendingRegistration.sourceContent);
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const sessionInternals = fixture.session as unknown as {
		_toolResultPresentation?: {
			counters: ToolResultPresentationCounters;
			clearProjectionRecords(): void;
		};
		_rebuildToolResultUiCanonicalIndex(): void;
	};
	const owner = sessionInternals._toolResultPresentation;
	if (!owner) throw new Error("compaction reset fixture missed its presentation owner");
	owner.clearProjectionRecords();
	const retainedTail = fixture.session.agent.state.messages.at(-1);
	fixture.session.agent.state.messages = retainedTail ? [retainedTail] : [];
	sessionInternals._rebuildToolResultUiCanonicalIndex();
	const ownerBefore = { ...owner.counters };
	const originalInvalidate = fixture.internals.chatContainer.invalidateRetainedChild;
	let retainedInvalidations = 0;
	fixture.internals.chatContainer.invalidateRetainedChild = function (component): boolean {
		retainedInvalidations++;
		return originalInvalidate.call(this, component);
	};
	await forceCollection();
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "threshold",
		result: {
			summary: "canonical replacement profile",
			firstKeptEntryId: "kept",
			tokensBefore: 32_768,
			retainedTail: retainedTail ? [retainedTail] : [],
		},
		aborted: false,
		willRetry: true,
	});
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	const allocations = allocationSites(stopped.profile.head as SamplingNode);
	fixture.internals.chatContainer.invalidateRetainedChild = originalInvalidate;
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	let staleDiscoveriesAfter = 0;
	for (let index = 0; index < components.length; index++) {
		if (components[index]!.getToolResultPresentationDiscovery(`live-profile-${300_000 + index}`)) {
			staleDiscoveriesAfter++;
		}
	}
	const compactionReset = {
		attachedBefore: before.attached,
		pendingBefore: before.pending,
		attachedAfter: after.attached,
		pendingAfter: after.pending,
		canonicalHistoryResetReleases: after.canonicalHistoryResetReleases,
		canonicalHistoryResetUniqueComponentRefreshes:
			after.canonicalHistoryResetUniqueComponentRefreshes - before.canonicalHistoryResetUniqueComponentRefreshes,
		pendingTeardownReleaseDelta: after.pendingTeardownReleases - before.pendingTeardownReleases,
		retainedInvalidations,
		staleDiscoveriesAfter,
		capacityEvictionDelta: after.attachedCapacityEvictions - before.attachedCapacityEvictions,
		fullSourceScanDelta: owner.counters.fullSourceEstimatorScans - ownerBefore.fullSourceEstimatorScans,
		sourceDigestDelta: owner.counters.sourceDigestConstructions - ownerBefore.sourceDigestConstructions,
		artifactIntegrityScanDelta: owner.counters.artifactIntegrityScans - ownerBefore.artifactIntegrityScans,
		modelProjectionDelta: owner.counters.modelProjectionCalls - ownerBefore.modelProjectionCalls,
		releasedProjectionRecordEntries: owner.counters.projectionRecordEntries,
		releasedProjectionCodeUnits: owner.counters.retainedProjectionCodeUnits,
		sampledAllocationBytes: allocations.sampledBytes,
		topAllocationSites: allocations.top,
	};
	unsubscribe();
	await fixture.dispose();
	return {
		evidence: { canonicalV1, compactionReset },
		component: componentRef,
		discovery: discoveryRef,
		attachedRegistration: attachedRegistrationRef,
		pendingRegistration: pendingRegistrationRef,
		attachedSource: attachedSourceRef,
		pendingSource: pendingSourceRef,
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

async function measureParallelCanonicalAttachmentOrder(): Promise<{
	pendingBeforeCanonical: number;
	attachedBeforeCanonical: number;
	preCanonicalEvictions: number;
	registrations: number;
	canonicalOrder: boolean;
	nextAdmissionEvictedCanonicalOldest: boolean;
	newestContinuationReadable: boolean;
	registrationObjectDelta: number;
	evictionDelta: number;
}> {
	const fixture = await createModeFixture([], "enabled");
	fixture.internals.isInitialized = true;
	const messages = new Array<ToolResultMessage>(129);
	for (let index = 0; index < messages.length; index++) {
		const toolCallId = `parallel-profile-${index}`;
		messages[index] = toolResult(toolCallId, `parallel-profile-${index}-`.repeat(1_024));
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
	}
	const beforeCanonical = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		fixture.session.agent.state.messages.push(message);
		await (fixture.session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
	}
	const entries = fixture.internals.attachedToolResultDiscoveries;
	const canonicalOrder = entries !== undefined && [...entries.keys()].every(
		(toolCallId, index) => toolCallId === messages[index + 1]!.toolCallId,
	);
	const newestComponent = fixture.internals.pendingTools.get(messages.at(-1)!.toolCallId);
	const attachedNewest = fixture.internals.chatContainer.children.find(
		(child): child is ToolExecutionComponent =>
			child instanceof ToolExecutionComponent &&
			child.getToolResultPresentationDiscovery(messages.at(-1)!.toolCallId) !== undefined,
	);
	const newestDiscovery = attachedNewest?.getToolResultPresentationDiscovery(messages.at(-1)!.toolCallId);
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const later = toolResult("parallel-profile-later", "parallel-profile-later-".repeat(1_024));
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId: later.toolCallId, toolName: later.toolName, args: {} });
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: later.toolCallId,
		toolName: later.toolName,
		result: { content: later.content, isError: false },
		isError: false,
	});
	fixture.session.agent.state.messages.push(later);
	await (fixture.session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message: later });
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const nextAdmissionEvictedCanonicalOldest =
		!fixture.internals.attachedToolResultDiscoveries?.has(messages[1]!.toolCallId) &&
		fixture.internals.attachedToolResultDiscoveries?.has(messages[128]!.toolCallId) === true;
	let newestContinuationReadable = false;
	if (newestDiscovery) {
		newestContinuationReadable = fixture.session.readToolResultContinuation(newestDiscovery.cursor, 128).content.length > 0;
	}
	void newestComponent;
	unsubscribe();
	await fixture.dispose();
	return {
		pendingBeforeCanonical: beforeCanonical.pending,
		attachedBeforeCanonical: beforeCanonical.attached,
		preCanonicalEvictions: beforeCanonical.attachedCapacityEvictions,
		registrations: after.entries,
		canonicalOrder,
		nextAdmissionEvictedCanonicalOldest,
		newestContinuationReadable,
		registrationObjectDelta: after.registrationObjectsCreated - before.registrationObjectsCreated,
		evictionDelta: after.registrationsEvicted - before.registrationsEvicted,
	};
}

async function measureAttachedCapacityUnderV1Batches(): Promise<{
	initialAttached: number;
	one: { pendingPeak: number; attachedDuringPending: number; evictionDelta: number; finalAttached: number; durationMs: number };
	twoHundredFiftySix: { pendingPeak: number; attachedDuringPending: number; evictionDelta: number; finalAttached: number; durationMs: number };
	oneThousandTwentyFour: { pendingPeak: number; attachedDuringPending: number; evictionDelta: number; finalAttached: number; durationMs: number };
}> {
	const fixture = await createModeFixture([], "enabled");
	fixture.internals.isInitialized = true;
	const unsubscribe = fixture.session.subscribe((event) => fixture.internals.handleEvent(event));
	for (let index = 0; index < 128; index++) {
		const message = toolResult(`v1-capacity-original-${index}`, `v1-capacity-original-${index}-`.repeat(1_024));
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId: message.toolCallId, toolName: message.toolName, args: {} });
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await (fixture.session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
	}
	const initial = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const runBatch = async (count: number, prefix: string) => {
		const started = performance.now();
		const messages = new Array<ToolResultMessage>(count);
		const evictionsBefore = fixture.internals.getToolResultDiscoveryLifecycleCounts().attachedCapacityEvictions;
		for (let index = 0; index < count; index++) {
			const message = toolResult(`${prefix}-${index}`, "small");
			messages[index] = message;
			await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId: message.toolCallId, toolName: message.toolName, args: {} });
			await fixture.internals.handleEvent({
				type: "tool_execution_end",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				result: { content: message.content, isError: false },
				isError: false,
			});
		}
		const during = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		for (const message of messages) {
			fixture.session.agent.state.messages.push(message);
			await (fixture.session as unknown as {
				_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
			})._handleAgentEvent({ type: "message_end", message });
		}
		const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		return {
			pendingPeak: during.pending,
			attachedDuringPending: during.attached,
			evictionDelta: after.attachedCapacityEvictions - evictionsBefore,
			finalAttached: after.attached,
			durationMs: performance.now() - started,
		};
	};
	const one = await runBatch(1, "v1-capacity-one");
	const twoHundredFiftySix = await runBatch(256, "v1-capacity-256");
	const oneThousandTwentyFour = await runBatch(1_024, "v1-capacity-1024");
	unsubscribe();
	await fixture.dispose();
	return { initialAttached: initial.attached, one, twoHundredFiftySix, oneThousandTwentyFour };
}

async function measureMalformedMixedHistoryRebuild(): Promise<{
	durationMs: number;
	selected: number;
	malformedAdmissions: number;
	malformedArtifacts: number;
	counts: ReturnType<AgentSession["getToolResultPresentationUiRebuildCounts"]>;
}> {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 50_000; index++) {
		messages.push(toolResult(
			`malformed-mixed-${index}`,
			index % 390 === 0 ? `malformed-mixed-large-${index}-`.repeat(1_024) : "small",
		));
	}
	messages[1] = {
		role: "toolResult",
		toolCallId: "malformed-mixed-invalid",
		toolName: "fixture-tool",
		content: [{ type: "text" }],
		isError: false,
		timestamp: 2,
	} as unknown as AgentMessage;
	const fixture = await createModeFixture(messages, "enabled");
	const ownerCounters = (fixture.session as unknown as {
		_toolResultPresentation?: { counters: ToolResultPresentationCounters };
	})._toolResultPresentation?.counters;
	if (!ownerCounters) throw new Error("malformed mixed-history fixture has no presentation owner");
	const entriesBefore = ownerCounters.projectionRecordEntries;
	const artifactsBefore = ownerCounters.artifactDescriptorsCreated;
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	const started = performance.now();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const durationMs = performance.now() - started;
	const counts = fixture.session.getToolResultPresentationUiRebuildCounts();
	const selectedCount = selected.size;
	const malformedAdmissions = Math.max(0, ownerCounters.projectionRecordEntries - entriesBefore - selectedCount);
	const malformedArtifacts = Math.max(0, ownerCounters.artifactDescriptorsCreated - artifactsBefore - selectedCount);
	selected.clear();
	await fixture.dispose();
	return { durationMs, selected: selectedCount, malformedAdmissions, malformedArtifacts, counts };
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

async function measureNonInteractiveLazyCanonicalIndex(): Promise<{
	historyMessages: number;
	constructorBuildProbes: number;
	constructorRebuilds: number;
	constructorEntries: number;
	constructorActive: boolean;
	providerBuildProbeDelta: number;
	inactiveReplacementBuildProbeDelta: number;
	inactiveReplacementRebuildDelta: number;
	inactiveReplacementSkips: number;
	firstUiActivationCount: number;
	firstUiBuildProbes: number;
	firstUiRebuilds: number;
	firstUiEntries: number;
	repeatedUiBuildProbeDelta: number;
	repeatedUiRebuildDelta: number;
}> {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 50_000; index++) messages.push(toolResult(`noninteractive-${index}`, "small"));
	const fixture = await createModeFixture(messages, "enabled");
	const before = fixture.session.getToolResultPresentationUiRebuildCounts();
	await fixture.session.agent.convertToLlm([fixture.session.agent.state.messages.at(-1)!]);
	const afterProvider = fixture.session.getToolResultPresentationUiRebuildCounts();
	(fixture.session as unknown as { _rebuildToolResultUiCanonicalIndex(): void })._rebuildToolResultUiCanonicalIndex();
	const afterInactiveReplacement = fixture.session.getToolResultPresentationUiRebuildCounts();
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const afterFirstUi = fixture.session.getToolResultPresentationUiRebuildCounts();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const afterRepeatedUi = fixture.session.getToolResultPresentationUiRebuildCounts();
	selected.clear();
	await fixture.dispose();
	return {
		historyMessages: messages.length,
		constructorBuildProbes: before.liveCanonicalIndexBuildProbes,
		constructorRebuilds: before.liveCanonicalIndexRebuilds,
		constructorEntries: before.liveCanonicalIndexEntries,
		constructorActive: before.canonicalIndexActive,
		providerBuildProbeDelta:
			afterProvider.liveCanonicalIndexBuildProbes - before.liveCanonicalIndexBuildProbes,
		inactiveReplacementBuildProbeDelta:
			afterInactiveReplacement.liveCanonicalIndexBuildProbes - afterProvider.liveCanonicalIndexBuildProbes,
		inactiveReplacementRebuildDelta:
			afterInactiveReplacement.liveCanonicalIndexRebuilds - afterProvider.liveCanonicalIndexRebuilds,
		inactiveReplacementSkips: afterInactiveReplacement.canonicalIndexInactiveRebuildSkips,
		firstUiActivationCount: afterFirstUi.canonicalIndexActivationCount,
		firstUiBuildProbes: afterFirstUi.liveCanonicalIndexBuildProbes,
		firstUiRebuilds: afterFirstUi.liveCanonicalIndexRebuilds,
		firstUiEntries: afterFirstUi.liveCanonicalIndexEntries,
		repeatedUiBuildProbeDelta:
			afterRepeatedUi.liveCanonicalIndexBuildProbes - afterFirstUi.liveCanonicalIndexBuildProbes,
		repeatedUiRebuildDelta:
			afterRepeatedUi.liveCanonicalIndexRebuilds - afterFirstUi.liveCanonicalIndexRebuilds,
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

async function capturePendingLifecycleRefs(): Promise<{
	component: WeakRef<object>;
	registration: WeakRef<object>;
	source: WeakRef<object>;
	pendingAfterStop: number;
	attachedAfterStop: number;
	pendingTeardownReleases: number;
}> {
	const fixture = await createModeFixture([], "enabled");
	fixture.internals.isInitialized = true;
	let message: ToolResultMessage | undefined = toolResult("pending-lifecycle-profile", "pending-lifecycle-".repeat(1_024));
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		args: {},
	});
	const component = fixture.internals.pendingTools.get(message.toolCallId);
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		result: { content: message.content, isError: false },
		isError: false,
	});
	const registration = fixture.internals.pendingToolResultDiscoveries?.get(message.toolCallId);
	if (!component || !registration) throw new Error("pending lifecycle fixture did not retain its registration");
	const refs = {
		component: new WeakRef<object>(component),
		registration: new WeakRef<object>(registration),
		source: new WeakRef<object>(message.content),
	};
	await fixture.mode.stop("transcript");
	fixture.internals.chatContainer.clear();
	const afterStop = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	message = undefined;
	await fixture.dispose();
	return {
		...refs,
		pendingAfterStop: afterStop.pending,
		attachedAfterStop: afterStop.attached,
		pendingTeardownReleases: afterStop.pendingTeardownReleases,
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
const groupedImageSettings = measureGroupedImageSettings();
const groupedCloseoutLifecycle = await measureGroupedCloseoutLifecycle();
const boxCacheHitProfile = await measureBoxCacheHitProfile(inspector);
const exactResidentTouchProfile = await measureExactResidentTouchProfile(inspector);
const defaultOffAbsent = await measureDefaultOffProduction("absent");
const defaultOffDisabled = await measureDefaultOffProduction("disabled");
const canonicalDispositionMatrix = await measureCanonicalDispositionMatrix();
const groupedCompactionDeduplication = await measureGroupedCompactionDeduplication();
const liveRegistrationProfile = await measureLiveRegistrationProfile(inspector);
const teardown128 = await measureTeardown128();
const chronologicalEviction = await measureChronologicalEviction();
const parallelCanonicalAttachment = await measureParallelCanonicalAttachmentOrder();
const attachedCapacityUnderV1Batches = await measureAttachedCapacityUnderV1Batches();
const mixedHistoryRebuild = await measureMixedHistoryRebuild();
const malformedMixedHistoryRebuild = await measureMalformedMixedHistoryRebuild();
const sharedOwnerUiRebuild = await measureSharedOwnerUiRebuild();
const nonAdmittingCandidateInspection = await measureNonAdmittingCandidateInspection();
const setupReplacedHistoryRebind = await measureSetupReplacedHistoryRebind();
const nonInteractiveLazyCanonicalIndex = await measureNonInteractiveLazyCanonicalIndex();
const canonicalReplacementLifecycle = await captureCanonicalReplacementLifecycle(inspector);
const productionLifecycleRefs = await captureProductionLifecycleRefs();
const pendingLifecycleRefs = await capturePendingLifecycleRefs();
const inspectionTransientSourceRef = await captureInspectionTransientSourceRef();
const neverSettlingGroupedConverterRefs = captureNeverSettlingGroupedConverterRefs();

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
const livePendingComponentWeakRefs = pendingLifecycleRefs.component.deref() ? 1 : 0;
const livePendingRegistrationWeakRefs = pendingLifecycleRefs.registration.deref() ? 1 : 0;
const livePendingSourceWeakRefs = pendingLifecycleRefs.source.deref() ? 1 : 0;
const liveInspectionTransientSourceWeakRefs = inspectionTransientSourceRef.deref() ? 1 : 0;
const liveNeverSettlingGroupedComponentWeakRefs = neverSettlingGroupedConverterRefs.component.deref() ? 1 : 0;
const liveNeverSettlingGroupedRowWeakRefs = neverSettlingGroupedConverterRefs.row.deref() ? 1 : 0;
const liveNeverSettlingGroupedResultWeakRefs = neverSettlingGroupedConverterRefs.result.deref() ? 1 : 0;
const liveNeverSettlingGroupedContentWeakRefs = neverSettlingGroupedConverterRefs.content.deref() ? 1 : 0;
const liveNeverSettlingGroupedImageBlockWeakRefs = neverSettlingGroupedConverterRefs.imageBlock.deref() ? 1 : 0;
const liveCanonicalReplacementComponentWeakRefs = canonicalReplacementLifecycle.component.deref() ? 1 : 0;
const liveCanonicalReplacementDiscoveryWeakRefs = canonicalReplacementLifecycle.discovery.deref() ? 1 : 0;
const liveCanonicalReplacementAttachedRegistrationWeakRefs = canonicalReplacementLifecycle.attachedRegistration.deref() ? 1 : 0;
const liveCanonicalReplacementPendingRegistrationWeakRefs = canonicalReplacementLifecycle.pendingRegistration.deref() ? 1 : 0;
const liveCanonicalReplacementAttachedSourceWeakRefs = canonicalReplacementLifecycle.attachedSource.deref() ? 1 : 0;
const liveCanonicalReplacementPendingSourceWeakRefs = canonicalReplacementLifecycle.pendingSource.deref() ? 1 : 0;
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
	canonicalDispositionMatrix,
	teardown128,
	chronologicalEviction,
	parallelCanonicalAttachment,
	attachedCapacityUnderV1Batches,
	mixedHistoryRebuild,
	malformedMixedHistoryRebuild,
	groupedImageSettings,
	groupedCloseoutLifecycle,
	groupedCompactionDeduplication,
	sharedOwnerUiRebuild,
	nonAdmittingCandidateInspection,
	setupReplacedHistoryRebind,
	nonInteractiveLazyCanonicalIndex,
	neverSettlingGroupedConverter: {
		lifecycleBeforeRelease: neverSettlingGroupedConverterRefs.lifecycle,
		liveComponentWeakRefs: liveNeverSettlingGroupedComponentWeakRefs,
		liveRowWeakRefs: liveNeverSettlingGroupedRowWeakRefs,
		liveResultWeakRefs: liveNeverSettlingGroupedResultWeakRefs,
		liveContentWeakRefs: liveNeverSettlingGroupedContentWeakRefs,
		liveImageBlockWeakRefs: liveNeverSettlingGroupedImageBlockWeakRefs,
	},
	canonicalReplacementLifecycle: canonicalReplacementLifecycle.evidence,
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
		livePendingComponentWeakRefs,
		livePendingRegistrationWeakRefs,
		livePendingSourceWeakRefs,
		pendingAfterStop: pendingLifecycleRefs.pendingAfterStop,
		attachedAfterStop: pendingLifecycleRefs.attachedAfterStop,
		pendingTeardownReleases: pendingLifecycleRefs.pendingTeardownReleases,
		liveInspectionTransientSourceWeakRefs,
		liveCanonicalReplacementComponentWeakRefs,
		liveCanonicalReplacementDiscoveryWeakRefs,
		liveCanonicalReplacementAttachedRegistrationWeakRefs,
		liveCanonicalReplacementPendingRegistrationWeakRefs,
		liveCanonicalReplacementAttachedSourceWeakRefs,
		liveCanonicalReplacementPendingSourceWeakRefs,
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
