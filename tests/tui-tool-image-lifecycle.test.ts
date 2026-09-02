import assert from "node:assert/strict";
import test from "node:test";
import {
	Container,
	getCapabilities,
	RELEASE_COMPONENT_RENDER_CACHE,
	setCapabilities,
	TuiAltScreen,
	type TUI,
	VStack,
} from "@super-pi/tui";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

type ConvertedImage = { data: string; mimeType: string };

interface DeferredConversion {
	resolve(value: ConvertedImage | null): void;
	reject(error: Error): void;
}

class DeferredToolExecutionComponent extends ToolExecutionComponent {
	readonly conversions: DeferredConversion[] = [];

	protected override convertImageForTerminal(): Promise<ConvertedImage | null> {
		return new Promise<ConvertedImage | null>((resolve, reject) => {
			this.conversions.push({ resolve, reject });
		});
	}
}

function imageResult(...sources: string[]): {
	content: Array<{ type: string; data: string; mimeType: string }>;
} {
	const content = new Array<{ type: string; data: string; mimeType: string }>(sources.length);
	for (let index = 0; index < sources.length; index++) {
		content[index] = { type: "image", data: sources[index]!, mimeType: "image/jpeg" };
	}
	return { content };
}

function createCountingTui(): TUI & { requestRenderCalls: number } {
	return {
		requestRenderCalls: 0,
		requestRender(): void { this.requestRenderCalls++; },
	} as TUI & { requestRenderCalls: number };
}

async function settlePromiseCallbacks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("cache-only release rejects a late image conversion without detached-owner invalidation", async () => {
	initTheme("dark");
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const tui = createCountingTui();
		let visualInvalidations = 0;
		const component = new DeferredToolExecutionComponent(
			"image",
			"image-1",
			{},
			{ showImages: true, onVisualInvalidate: () => { visualInvalidations++; } },
			undefined,
			tui,
			process.cwd(),
		);
		component.updateResult(imageResult("source-a"), true);
		assert.equal(component.conversions.length, 1);
		assert.equal(component.getImageConversionLifecycleCounts().activePending, 1);
		const requestRenderCalls = tui.requestRenderCalls;

		component[RELEASE_COMPONENT_RENDER_CACHE]();
		assert.deepEqual(component.getImageConversionLifecycleCounts(), {
			activePending: 0,
			activePendingHighWaterMark: 1,
			scheduled: 1,
			accepted: 0,
			dropped: 0,
			rejected: 0,
			convertedImages: 0,
			imageComponents: 0,
			imageSpacers: 0,
			sourceReferences: 0,
			pendingSourceReferences: 0,
			pendingGenerationReferences: 0,
		});
		component.conversions[0]!.resolve({ data: "old-png", mimeType: "image/png" });
		await settlePromiseCallbacks();
		const afterLateCompletion = component.getImageConversionLifecycleCounts();
		assert.equal(afterLateCompletion.dropped, 1);
		assert.equal(afterLateCompletion.accepted, 0);
		assert.equal(afterLateCompletion.convertedImages, 0);
		assert.equal(afterLateCompletion.imageComponents, 0);
		assert.equal(afterLateCompletion.activePending, 0);
		assert.equal(visualInvalidations, 0);
		assert.equal(tui.requestRenderCalls, requestRenderCalls);
	} finally {
		setCapabilities(previous);
	}
});

test("same-source ABA accepts only the current numeric image task generation", async () => {
	initTheme("dark");
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const tui = createCountingTui();
		let visualInvalidations = 0;
		const component = new DeferredToolExecutionComponent(
			"image",
			"image-aba",
			{},
			{ showImages: true, onVisualInvalidate: () => { visualInvalidations++; } },
			undefined,
			tui,
			process.cwd(),
		);
		const sourceA = imageResult("source-a");
		component.updateResult(sourceA, true);
		component[RELEASE_COMPONENT_RENDER_CACHE]();
		component.updateResult(sourceA, true);
		assert.equal(component.conversions.length, 2);
		assert.equal(component.getImageConversionLifecycleCounts().activePending, 1);

		component.conversions[0]!.resolve({ data: "stale-a", mimeType: "image/png" });
		await settlePromiseCallbacks();
		let counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.activePending, 1);
		assert.equal(counts.accepted, 0);
		assert.equal(counts.dropped, 1);
		assert.equal(visualInvalidations, 0);

		component.conversions[1]!.resolve({ data: "current-a", mimeType: "image/png" });
		await settlePromiseCallbacks();
		counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.activePending, 0);
		assert.equal(counts.accepted, 1);
		assert.equal(counts.dropped, 1);
		assert.equal(counts.convertedImages, 1);
		assert.equal(visualInvalidations, 1);
		assert.equal(tui.requestRenderCalls, 1);
		assert.ok(component.render(80).length > 0);
	} finally {
		setCapabilities(previous);
	}
});

test("parallel image conversion rejection is observed and release clears logical ownership", async () => {
	initTheme("dark");
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const tui = createCountingTui();
		const component = new DeferredToolExecutionComponent(
			"image",
			"image-parallel",
			{},
			{ showImages: true },
			undefined,
			tui,
			process.cwd(),
		);
		component.updateResult(imageResult("a", "b", "c", "d", "e", "f", "g", "h"), true);
		assert.equal(component.conversions.length, 8);
		assert.equal(component.getImageConversionLifecycleCounts().activePendingHighWaterMark, 8);
		component.conversions[0]!.reject(new Error("fixture conversion rejection"));
		component.conversions[1]!.resolve(null);
		await settlePromiseCallbacks();
		let counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.rejected, 1);
		assert.equal(counts.activePending, 6);

		component[RELEASE_COMPONENT_RENDER_CACHE]();
		for (let index = 2; index < component.conversions.length; index++) {
			component.conversions[index]!.resolve({ data: `stale-${index}`, mimeType: "image/png" });
		}
		await settlePromiseCallbacks();
		counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.activePending, 0);
		assert.equal(counts.accepted, 0);
		assert.equal(counts.convertedImages, 0);
		assert.equal(counts.pendingSourceReferences, 0);
		assert.equal(counts.pendingGenerationReferences, 0);
	} finally {
		setCapabilities(previous);
	}
});

test("image source replacement and ordinal shrink logically cancel obsolete generations", async () => {
	initTheme("dark");
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const component = new DeferredToolExecutionComponent(
			"image",
			"image-source-cycle",
			{},
			{ showImages: true },
			undefined,
			createCountingTui(),
			process.cwd(),
		);
		component.updateResult(imageResult("a"), true);
		component.updateResult(imageResult("b"), true);
		component.updateResult(imageResult("a"), true);
		assert.equal(component.conversions.length, 3);
		assert.equal(component.getImageConversionLifecycleCounts().activePending, 1);
		component.conversions[0]!.resolve({ data: "stale-a", mimeType: "image/png" });
		component.conversions[1]!.resolve({ data: "stale-b", mimeType: "image/png" });
		component.conversions[2]!.resolve({ data: "current-a", mimeType: "image/png" });
		await settlePromiseCallbacks();
		let counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.accepted, 1);
		assert.equal(counts.dropped, 2);
		assert.equal(counts.activePending, 0);

		component.updateResult(imageResult("a", "b", "c", "d"), true);
		assert.equal(component.conversions.length, 6);
		assert.equal(component.getImageConversionLifecycleCounts().activePending, 3);
		component.updateResult(imageResult("a"), true);
		assert.equal(component.getImageConversionLifecycleCounts().activePending, 0);
		for (let index = 3; index < component.conversions.length; index++) {
			component.conversions[index]!.resolve({ data: `shrunk-${index}`, mimeType: "image/png" });
		}
		await settlePromiseCallbacks();
		counts = component.getImageConversionLifecycleCounts();
		assert.equal(counts.convertedImages, 1);
		assert.equal(counts.activePending, 0);
		assert.equal(counts.pendingGenerationReferences, 0);
	} finally {
		setCapabilities(previous);
	}
});

test("selective root and overlay ownership preserve or cancel pending tool conversion exactly once", async () => {
	initTheme("dark");
	const previous = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const tui = new TuiAltScreen(new FakeTerminal(100, 30), false, undefined, { mouse: false });
		const tool = new DeferredToolExecutionComponent(
			"image",
			"shared-image",
			{},
			{ showImages: true },
			undefined,
			tui,
			process.cwd(),
		);
		tool.updateResult(imageResult("source-a"), true);
		const oldWrapper = new Container();
		oldWrapper.addChild(tool);
		const rootA = new VStack([oldWrapper]);
		const newWrapper = new Container();
		newWrapper.addChild(tool);
		const rootB = new VStack([newWrapper]);
		tui.setLayoutRoot(rootA);
		tui.start();
		tui.renderNow(true);
		tui.setLayoutRoot(rootB);
		assert.equal(tool.getImageConversionLifecycleCounts().activePending, 1);
		tool.conversions[0]!.resolve({ data: "shared-current", mimeType: "image/png" });
		await settlePromiseCallbacks();
		assert.equal(tool.getImageConversionLifecycleCounts().accepted, 1);

		tool.updateResult(imageResult("source-b"), true);
		assert.equal(tool.getImageConversionLifecycleCounts().activePending, 1);
		tui.setLayoutRoot(new VStack([]));
		assert.equal(tool.getImageConversionLifecycleCounts().activePending, 0);
		tool.conversions[1]!.resolve({ data: "detached-b", mimeType: "image/png" });
		await settlePromiseCallbacks();
		assert.equal(tool.getImageConversionLifecycleCounts().accepted, 1);
		assert.equal(tool.getImageConversionLifecycleCounts().dropped, 1);

		tool.updateResult(imageResult("source-c"), true);
		const direct = tui.showOverlay(tool);
		const remainingWrapper = new Container();
		remainingWrapper.addChild(tool);
		const remaining = tui.showOverlay(remainingWrapper);
		direct.hide();
		assert.equal(tool.getImageConversionLifecycleCounts().activePending, 1);
		remaining.hide();
		assert.equal(tool.getImageConversionLifecycleCounts().activePending, 0);
		tool.conversions[2]!.resolve({ data: "detached-c", mimeType: "image/png" });
		await settlePromiseCallbacks();
		assert.equal(tool.getImageConversionLifecycleCounts().accepted, 1);
		assert.equal(tool.getImageConversionLifecycleCounts().dropped, 2);
		await tui.dispose({ preserveScreen: true });
	} finally {
		setCapabilities(previous);
	}
});
