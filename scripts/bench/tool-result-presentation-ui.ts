import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { RELEASE_COMPONENT_RENDER_CACHE, setKeybindings, type TUI } from "@super-pi/tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentationContent,
} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

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
	sampledAllocationBytes: number;
	sampledBytesPerToggleAndRender: number;
	topAllocationSites: AllocationSite[];
}

const PROFILE_ITERATIONS = 300;
const GC_CYCLES = 32;
const COMPONENTS_PER_GC_CYCLE = 16;
const content: ToolResultPresentationContent[] = [
	{ type: "text", text: "ui-discovery-allocation-fixture\n".repeat(1_024) },
	{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
];

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
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

async function forceCollection(): Promise<void> {
	for (let pass = 0; pass < 6; pass++) {
		globalThis.gc!();
		await yieldToEventLoop();
	}
}

async function measureProfile(inspector: Session, component: ToolExecutionComponent): Promise<UiProfile> {
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
		sampledAllocationBytes: allocations.sampledBytes,
		sampledBytesPerToggleAndRender: allocations.sampledBytes / PROFILE_ITERATIONS,
		topAllocationSites: allocations.top,
	};
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

function sourceRegion(source: string, start: string, end: string, from = 0): string {
	const startIndex = source.indexOf(start, from);
	if (startIndex < 0) throw new Error(`Missing source marker: ${start}`);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (endIndex < 0) throw new Error(`Missing source marker: ${end}`);
	return source.slice(startIndex, endIndex);
}

function countMatches(source: string, pattern: RegExp): number {
	return source.match(pattern)?.length ?? 0;
}

if (!globalThis.gc) throw new Error("Run with --expose-gc");
setKeybindings(new KeybindingsManager());
initTheme("dark");
const commit = git(["rev-parse", "HEAD"]);
const worktreeStatusBefore = git(["status", "--porcelain"]);
const toolComponentSource = readFileSync(
	new URL("../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts", import.meta.url),
	"utf8",
);
const interactiveSource = readFileSync(
	new URL("../../packages/coding-agent/src/modes/interactive/interactive-mode.ts", import.meta.url),
	"utf8",
);
const agentSessionSource = readFileSync(
	new URL("../../packages/coding-agent/src/core/agent-session.ts", import.meta.url),
	"utf8",
);
const renderUtilsSource = readFileSync(
	new URL("../../packages/coding-agent/src/core/tools/render-utils.ts", import.meta.url),
	"utf8",
);
const firstComponentSetter = toolComponentSource.indexOf("\tsetToolResultPresentation(");
const secondComponentSetter = toolComponentSource.indexOf("\tsetToolResultPresentation(", firstComponentSetter + 1);
const discoveryHotSource = [
	sourceRegion(toolComponentSource, "export interface ToolResultPresentationDiscoveryState", "type ReadGroupRow"),
	sourceRegion(toolComponentSource, "\tsetToolResultPresentation(", "\n\tprivate getDisplayRows"),
	sourceRegion(toolComponentSource, "\tsetToolResultPresentation(", "\n\tsetShowImages", secondComponentSetter),
	sourceRegion(interactiveSource, "\tprivate evictOldestToolResultDiscovery(", "\n\tprivate retainActiveToolComponent"),
	sourceRegion(agentSessionSource, "\tget toolResultPresentationEnabled", "\n\t/** Read one bounded continuation"),
].join("\n");
const transitiveResultRenderingSource = [
	sourceRegion(toolComponentSource, "function getReadGroupResultText", "\nlet cachedBuiltInToolDefinitions"),
	toolComponentSource.slice(toolComponentSource.indexOf("export class ToolExecutionComponent")),
	sourceRegion(renderUtilsSource, "export function getTextOutput(", "\nexport type ToolRenderResultLike"),
	discoveryHotSource,
].join("\n");
const registryHardCap = Number(interactiveSource.match(/MAX_TOOL_RESULT_DISCOVERIES\s*=\s*(\d+)/u)?.[1] ?? 0);
const inspector = new Session();
inspector.connect();

const plainProfiled = createPlainComponent("ui-profile-plain");
const plainProfile = await measureProfile(inspector, plainProfiled);
plainProfiled[RELEASE_COMPONENT_RENDER_CACHE]();
const profiled = createAttachedComponent(0);
const discoveryProfile = await measureProfile(inspector, profiled.component);
profiled.dispose();

const componentRefs: WeakRef<object>[] = [];
const discoveryRefs: WeakRef<object>[] = [];
captureReleasedFixtures(1, GC_CYCLES * COMPONENTS_PER_GC_CYCLE, componentRefs, discoveryRefs);
await forceCollection();
const liveComponentWeakRefs = componentRefs.reduce((count, ref) => count + (ref.deref() ? 1 : 0), 0);
const liveDiscoveryWeakRefs = discoveryRefs.reduce((count, ref) => count + (ref.deref() ? 1 : 0), 0);
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
		incremental: {
			p50Ms: discoveryProfile.p50Ms - plainProfile.p50Ms,
			p95Ms: discoveryProfile.p95Ms - plainProfile.p95Ms,
			sampledBytesPerToggleAndRender:
				discoveryProfile.sampledBytesPerToggleAndRender - plainProfile.sampledBytesPerToggleAndRender,
		},
	},
	lifecycle: {
		cycles: GC_CYCLES,
		componentsCreated: componentRefs.length,
		liveComponentWeakRefs,
		liveDiscoveryWeakRefs,
		heapSlopeBytesPerCycle: slope(heapSamples.slice(8)),
		heapSamples,
	},
	structure: {
		defaultOffDiscoveryStates: disabledDiscoveryState,
		registryHardCap,
		transitiveSourceFiles: ["tool-execution.ts", "render-utils.ts", "interactive-mode.ts", "agent-session.ts"],
		resultRenderingArrayTransformSites: countMatches(transitiveResultRenderingSource, /\.slice\(|\.map\(|\.filter\(/gu),
		resultRenderingStringAppendSites: countMatches(transitiveResultRenderingSource, /\b(?:text|output|bounded|preview)\s*\+=/gu),
		resultRenderingSerializationSites: countMatches(transitiveResultRenderingSource, /JSON\.stringify/gu),
		discoveryOwnershipCopyOperations: countMatches(discoveryHotSource, /structuredClone|\.slice\(|\.map\(/gu),
		discoveryOwnershipSerializations: countMatches(discoveryHotSource, /JSON\.stringify/gu),
		promises: countMatches(discoveryHotSource, /new\s+Promise/gu),
		abortControllers: countMatches(discoveryHotSource, /new\s+AbortController/gu),
	},
};

inspector.disconnect();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
