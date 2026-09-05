import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	getCapabilities,
	Image,
	RELEASE_COMPONENT_RENDER_CACHE,
	setCapabilities,
	setKeybindings,
	type TUI,
} from "@super-pi/tui";
import ts from "typescript";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import { KeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import {
	createToolOutputEstimatorCounters,
	estimateToolOutputTokens,
} from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	convertToPngWithLoadedConverter,
	type LoadedPngConverter,
} from "../packages/coding-agent/src/utils/image-convert.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	type ToolResultPresentation,
	type ToolResultPresentationContent,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	auditToolResultPresentationUiSources,
	classifyProducingCall,
} from "../scripts/bench/tool-result-presentation-ui-source-audit.ts";

interface DiscoveryState {
	readonly cursor: string;
	readonly artifactId?: string;
	readonly originalEstimatedTokens: number;
	readonly modelEstimatedTokens: number;
}

interface PresentationAwareComponent {
	setToolResultPresentation(toolCallId: string, presentation: ToolResultPresentation): string | undefined;
	clearToolResultPresentation(toolCallId: string, identity?: string): void;
	getToolResultPresentationDiscovery(toolCallId: string): DiscoveryState | undefined;
}

function presentationAware(component: object): PresentationAwareComponent {
	return component as PresentationAwareComponent;
}

function classifyFixtureCalls(source: string): Record<string, "array" | "string" | "other"> {
	const fileName = "tool-result-presentation-type-fixture.ts";
	const options: ts.CompilerOptions = { noEmit: true, target: ts.ScriptTarget.ES2022 };
	const sourceFile = ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.TS);
	const host = ts.createCompilerHost(options);
	const readSourceFile = host.getSourceFile.bind(host);
	host.fileExists = (path) => path === fileName || ts.sys.fileExists(path);
	host.readFile = (path) => path === fileName ? source : ts.sys.readFile(path);
	host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
		path === fileName ? sourceFile : readSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
	const program = ts.createProgram({ rootNames: [fileName], options, host });
	const checker = program.getTypeChecker();
	const result: Record<string, "array" | "string" | "other"> = {};
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			result[node.expression.getText(sourceFile)] = classifyProducingCall(node, checker);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return result;
}

test("TypeChecker classifies RegExpMatchArray without materializing iterators or strings", () => {
	const classifications = classifyFixtureCalls(`
		class CustomMatcher {
			private readonly cached: string[] = [];
			match(): string[] { return this.cached; }
		}
		const text = "x";
		const custom = new CustomMatcher();
		const matched: RegExpMatchArray | null = text.match(/x/);
		const iterator = text.matchAll(/x/g);
		const sliced = text.slice(0);
		const reused = custom.match();
	`);
	assert.equal(classifications["text.match"], "array");
	assert.equal(classifications["text.matchAll"], "other");
	assert.equal(classifications["text.slice"], "string");
	assert.equal(classifications["custom.match"], "other");
});

function createTui(): TUI {
	return { requestRender(): void {} } as TUI;
}

type ConvertedGroupedImage = { data: string; mimeType: string };

interface GroupedImageConversionCall {
	readonly data: string;
	readonly mimeType: string;
}

class DeferredReadToolGroupComponent extends ReadToolGroupComponent {
	readonly conversions: GroupedImageConversionCall[] = [];
	loaderRequests = 0;
	private resolveLoader: ((value: LoadedPngConverter | null) => void) | undefined;
	private rejectLoader: ((error: Error) => void) | undefined;
	private readonly conversionResults: Array<ConvertedGroupedImage | null | Error> = [];

	protected override loadImageConverterForTerminal(): Promise<LoadedPngConverter | null> {
		this.loaderRequests++;
		return new Promise<LoadedPngConverter | null>((resolve, reject) => {
			this.resolveLoader = resolve;
			this.rejectLoader = reject;
		});
	}

	protected override convertImageWithLoadedConverter(
		_converter: LoadedPngConverter,
		data: string,
		mimeType: string,
	): ConvertedGroupedImage | null {
		this.conversions.push({ data, mimeType });
		const result = this.conversionResults.length > 0
			? this.conversionResults.shift()!
			: { data: "Q09OVkVSVEVEX1BORw==", mimeType: "image/png" };
		if (result instanceof Error) throw result;
		return result;
	}

	queueConversionResult(result: ConvertedGroupedImage | null | Error): void {
		this.conversionResults.push(result);
	}

	settleLoader(value: LoadedPngConverter | null = {} as LoadedPngConverter): void {
		this.resolveLoader?.(value);
	}

	failLoader(error = new Error("fixture loader rejected")): void {
		this.rejectLoader?.(error);
	}
}

async function settleGroupedImageConversion(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

setKeybindings(new KeybindingsManager());

function plain(lines: string[]): string {
	return lines.join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "").replaceAll(/\s+/gu, " ");
}

function toolResult(toolCallId: string, content: ToolResultPresentationContent[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

test("small V1 ToolResult UI remains byte-for-byte unchanged", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "small-result" }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-small")!;
	const presentation = owner.create(content, "small")!;
	assert.equal(presentation.version, 1);
	const component = new ToolExecutionComponent("fixture", "small", {}, {}, undefined, createTui(), process.cwd());
	component.updateResult({ content });
	const before = component.render(80);
	assert.equal(presentationAware(component).setToolResultPresentation("small", presentation), undefined);
	assert.deepEqual(component.render(80), before);
	assert.equal(presentationAware(component).getToolResultPresentationDiscovery("small"), undefined);
	owner.release();
	owner.dispose();
});

test("bounded text and image results expose compact discovery without rendering handles", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "large-result-line\n".repeat(2_000) },
		{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
	];
	const message = toolResult("large", content);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-large")!;
	const presentation = owner.create(content, message.toolCallId)!;
	assert.equal(presentation.version, 2);
	const component = new ToolExecutionComponent(
		"fixture",
		message.toolCallId,
		{},
		{ showImages: false },
		undefined,
		createTui(),
		process.cwd(),
	);
	component.updateResult({ content });
	const identity = presentationAware(component).setToolResultPresentation(message.toolCallId, presentation);
	assert.ok(identity);
	const discovery = presentationAware(component).getToolResultPresentationDiscovery(message.toolCallId);
	assert.ok(discovery?.artifactId);

	const collapsed = plain(component.render(44));
	assert.match(collapsed, /Model received a bounded view/);
	assert.match(collapsed, /ctrl\+o.*full result/i);
	assert.doesNotMatch(collapsed, /tr1\.|tra1\./);

	const chunk = owner.readContinuation(discovery.cursor, [message], 128);
	assert.ok(chunk.content.length > 0);
	assert.ok(chunk.estimatedTokens > 0 && chunk.estimatedTokens <= 128);
	const artifact = owner.readArtifact(discovery.artifactId, [message]);
	assert.equal(artifact.content, content);

	component.setExpanded(true);
	const expanded = plain(component.render(100));
	assert.match(expanded, /Full canonical result is shown/);
	assert.match(expanded, /Continuation: available/);
	assert.match(expanded, /Session artifact: available/);
	assert.doesNotMatch(expanded, new RegExp(discovery.cursor.replaceAll(".", "\\.")));
	assert.doesNotMatch(expanded, new RegExp(discovery.artifactId.replaceAll(".", "\\.")));

	initTheme("light");
	component.invalidate();
	assert.match(plain(component.render(61)), /Full canonical result is shown/);
	component[RELEASE_COMPONENT_RENDER_CACHE]();
	assert.equal(presentationAware(component).getToolResultPresentationDiscovery(message.toolCallId), undefined);
	owner.release();
	owner.dispose();
});

test("grouped read rows use the same bounded-result semantics", () => {
	initTheme("dark");
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "grouped-read\n".repeat(2_000) }];
	const message = toolResult("read-large", content);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-read-group")!;
	const presentation = owner.create(content, message.toolCallId)!;
	assert.equal(presentation.version, 2);
	const group = new ReadToolGroupComponent();
	group.updateArgs(message.toolCallId, { path: "large.txt" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	assert.ok(presentationAware(group).setToolResultPresentation(message.toolCallId, presentation));
	assert.match(plain(group.render(52)), /Model received a bounded view/);
	group.setExpanded(true);
	assert.match(plain(group.render(90)), /Full canonical result is shown/);
	presentationAware(group).clearToolResultPresentation(message.toolCallId);
	assert.doesNotMatch(plain(group.render(90)), /Model received a bounded view/);
	owner.release();
	owner.dispose();
});

test("grouped bounded reads honor live image visibility, capability, and width changes", () => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	try {
		const content: ToolResultPresentationContent[] = [
			{ type: "text", text: "grouped-image-text-".repeat(1_000) },
			{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
		];
		const message = toolResult("read-image-settings", content);
		const owner = createToolResultPresentationOwner(
			{ enabled: true, budgetTokens: 128 },
			"ui-read-group-image-settings",
		)!;
		const presentation = owner.create(content, message.toolCallId)!;
		assert.equal(presentation.version, 2);
		const group = new ReadToolGroupComponent();
		const configurable = group as unknown as {
			setShowImages(show: boolean): void;
			setImageWidthCells(width: number): void;
		};
		group.updateArgs(message.toolCallId, { path: "image.png" });
		group.setArgsComplete(message.toolCallId);
		group.updateResult(message.toolCallId, message);
		assert.ok(presentationAware(group).setToolResultPresentation(message.toolCallId, presentation));
		group.setExpanded(true);

		configurable.setImageWidthCells(23);
		configurable.setShowImages(false);
		assert.equal(group.children.some((child) => child instanceof Image), false);
		assert.match(plain(group.render(100)), /grouped-image-text/);
		assert.match(plain(group.render(100)), /Model received a bounded view/);

		configurable.setShowImages(true);
		let image = group.children.find((child): child is Image => child instanceof Image);
		assert.ok(image);
		assert.equal((image as unknown as { options: { maxWidthCells?: number } }).options.maxWidthCells, 23);

		configurable.setShowImages(false);
		assert.equal(group.children.some((child) => child instanceof Image), false);
		configurable.setImageWidthCells(41);
		configurable.setShowImages(true);
		image = group.children.find((child): child is Image => child instanceof Image);
		assert.ok(image);
		assert.equal((image as unknown as { options: { maxWidthCells?: number } }).options.maxWidthCells, 41);

		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		group.invalidate();
		assert.equal(group.children.some((child) => child instanceof Image), false);
		owner.release();
		owner.dispose();
	} finally {
		setCapabilities(previousCapabilities);
	}
});

test("expanded grouped read rows expose complete canonical text beyond preview limits", (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	const longByCharacters = `character-prefix-${"x".repeat(4_001)}-character-tail`;
	const longByLines = `${Array.from({ length: 51 }, (_, index) => `line-${index}-${"y".repeat(96)}`).join("\n")}\nline-tail`;
	const imageData = "QUJDREVGRw==";
	const rows = [
		toolResult("read-characters", [{ type: "text", text: longByCharacters }]),
		toolResult("read-lines", [{ type: "text", text: longByLines }]),
		toolResult("read-image", [
			{ type: "text", text: "image-row-text-".repeat(500) },
			{ type: "image", data: imageData, mimeType: "image/png" },
		]),
		{ ...toolResult("read-error", [{ type: "text", text: `${"error-".repeat(1_000)}error-tail` }]), isError: true },
	];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "ui-read-group-limits")!;
	const group = new ReadToolGroupComponent();
	for (let index = 0; index < rows.length; index++) {
		const message = rows[index]!;
		group.updateArgs(message.toolCallId, { path: `large-${index}.txt` });
		group.setArgsComplete(message.toolCallId);
		group.updateResult(message.toolCallId, message, false, message.isError === true);
		const presentation = owner.create(message.content, message.toolCallId)!;
		assert.equal(presentation.version, 2);
		assert.ok(presentationAware(group).setToolResultPresentation(message.toolCallId, presentation));
		owner.release();
	}
	group.finalize();
	group.setExpanded(true);
	const expanded = plain(group.render(120));
	const compactExpanded = expanded.replaceAll(" ", "");
	assert.match(compactExpanded, /character-tail/);
	assert.match(compactExpanded, /line-tail/);
	assert.match(expanded, /image-row-text/);
	assert.equal(group.children.some((child) => child instanceof Image), true);
	assert.match(expanded, /error-tail/);
	assert.match(expanded, /Full canonical result is shown/);
	owner.dispose();
});

test("expanded grouped rows expose full text only for an attached V2 discovery", () => {
	initTheme("dark");
	const longText = `${"bounded-prefix-".repeat(400)}\n${Array.from({ length: 60 }, (_, index) => `bounded-line-${index}`).join("\n")}\nNON_V2_TAIL`;
	const v2Text = `${"discoverable-prefix-".repeat(400)}\nV2_FULL_TAIL`;
	const group = new ReadToolGroupComponent(false);
	group.updateArgs("read-v1", { path: "v1.txt" });
	group.setArgsComplete("read-v1");
	group.updateResult("read-v1", toolResult("read-v1", [{ type: "text", text: longText }]));
	group.updateArgs("read-pending", { path: "pending.txt" });
	group.updateResult("read-pending", toolResult("read-pending", [{ type: "text", text: longText }]), true);
	group.updateArgs("read-v2", { path: "v2.txt" });
	group.setArgsComplete("read-v2");
	const v2Message = toolResult("read-v2", [{ type: "text", text: v2Text }]);
	group.updateResult("read-v2", v2Message);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "grouped-qualified-full-output")!;
	const presentation = owner.create(v2Message.content, v2Message.toolCallId)!;
	assert.equal(presentation.version, 2);
	assert.ok(group.setToolResultPresentation(v2Message.toolCallId, presentation));
	owner.release();

	group.setExpanded(true);
	let rendered = plain(group.render(120));
	assert.doesNotMatch(rendered, /NON_V2_TAIL/);
	assert.match(rendered, /truncated/);
	assert.match(rendered, /V2_FULL_TAIL/);

	assert.equal(group.detachToolResultPresentation(v2Message.toolCallId), true);
	group.refreshToolResultPresentationView();
	rendered = plain(group.render(120));
	assert.doesNotMatch(rendered, /V2_FULL_TAIL/);
	assert.match(rendered, /truncated/);
	owner.dispose();
});

test("grouped Kitty non-PNG images wait for converted PNG ownership", async (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	let visualInvalidations = 0;
	const group = new DeferredReadToolGroupComponent(true, 32, () => { visualInvalidations++; });
	const message = toolResult("read-kitty-jpeg", [
		{ type: "text", text: "grouped-kitty-text-".repeat(400) },
		{ type: "image", data: "R1JPVVBFRF9KUEVHX1JBV19CWVRFUw==", mimeType: "image/jpeg" },
	]);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "grouped-kitty-jpeg")!;
	const presentation = owner.create(message.content, message.toolCallId)!;
	assert.equal(presentation.version, 2);
	group.updateArgs(message.toolCallId, { path: "grouped-kitty.txt" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	assert.ok(group.setToolResultPresentation(message.toolCallId, presentation));
	owner.release();
	group.setExpanded(true);
	assert.equal(group.loaderRequests, 1);
	assert.equal(group.conversions.length, 0, "source conversion must wait for converter readiness");
	let counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.scheduled, 0);
	assert.equal(counts.loaderWaiters, 1);
	assert.equal(counts.loaderSourceAcquisitions, 0);
	assert.equal(counts.accepted, 0);
	assert.equal(counts.imageComponents, 0, "raw JPEG must not be passed to Kitty as PNG while conversion is pending");
	group.setImageWidthCells(41);
	assert.equal(group.loaderRequests, 1, "a rebuild must reuse the source-free loader waiter");
	assert.equal(group.conversions.length, 0);
	group.settleLoader();
	await settleGroupedImageConversion();
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(group.conversions.length, 1);
	assert.equal(group.conversions[0]?.mimeType, "image/jpeg");
	assert.equal(counts.loaderWaiters, 0);
	assert.equal(counts.loaderSourceAcquisitions, 1);
	assert.equal(counts.accepted, 1);
	assert.equal(counts.scheduled, 1);
	assert.equal(counts.imageComponents, 1);
	assert.equal(visualInvalidations, 1);
	const image = group.children.find((child): child is Image => child instanceof Image);
	assert.ok(image);
	const imageInternals = image as unknown as {
		base64Data: string;
		mimeType: string;
		options: { maxWidthCells?: number };
	};
	assert.equal(imageInternals.base64Data, "Q09OVkVSVEVEX1BORw==");
	assert.equal(imageInternals.mimeType, "image/png");
	assert.equal(imageInternals.options.maxWidthCells, 41);
	group.setExpanded(false);
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.activePending, 0);
	assert.equal(counts.convertedImages, 0);
	assert.equal(counts.sourceReferences, 0);
	assert.equal(counts.imageComponents, 0);
	owner.dispose();
});

test("grouped image conversion rejects hidden, detached, unavailable, and failed warm work", async (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	let visualInvalidations = 0;
	const group = new DeferredReadToolGroupComponent(true, 32, () => { visualInvalidations++; });
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "grouped-kitty-lifecycle")!;
	const attach = (toolCallId: string, mimeType: string, data: string): void => {
		const message = toolResult(toolCallId, [
			{ type: "text", text: `${toolCallId}-`.repeat(1_000) },
			{ type: "image", data, mimeType },
		]);
		group.updateArgs(toolCallId, { path: `${toolCallId}.txt` });
		group.setArgsComplete(toolCallId);
		group.updateResult(toolCallId, message);
		const presentation = owner.create(message.content, message.toolCallId)!;
		assert.equal(presentation.version, 2);
		assert.ok(group.setToolResultPresentation(message.toolCallId, presentation));
		owner.release();
	};

	attach("jpeg-stale", "image/jpeg", "SkVQRUdfU1RBTEU=");
	group.setExpanded(true);
	assert.equal(group.loaderRequests, 1);
	assert.equal(group.conversions.length, 0);
	group.setShowImages(false);
	group.settleLoader();
	await settleGroupedImageConversion();
	let counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.accepted, 0);
	assert.equal(counts.loaderSourceAcquisitions, 0);
	assert.equal(counts.sourceReferences, 0);
	assert.equal(visualInvalidations, 0);

	group.queueConversionResult(null);
	group.setShowImages(true);
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(group.conversions.length, 1);
	assert.equal(counts.rejected, 1);
	assert.equal(counts.imageComponents, 0);

	assert.equal(group.detachToolResultPresentation("jpeg-stale"), true);
	group.refreshToolResultPresentationView();
	assert.equal(group.getGroupedImageConversionLifecycleCounts().sourceReferences, 0);

	group.queueConversionResult(new Error("fixture conversion rejected"));
	attach("webp-rejected", "image/webp", "V0VCUF9SRUpFQ1RFRA==");
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(group.conversions.length, 2);
	assert.equal(counts.rejected, 2);
	assert.equal(counts.imageComponents, 0);

	attach("gif-release", "image/gif", "R0lGX1JFTEVBU0U=");
	assert.equal(group.conversions.length, 3);
	assert.equal(group.getGroupedImageConversionLifecycleCounts().accepted, 1);
	group[RELEASE_COMPONENT_RENDER_CACHE]();
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.accepted, 1);
	assert.equal(counts.activePending, 0);
	assert.equal(counts.loaderWaiters, 0);
	assert.equal(counts.sourceReferences, 0);
	assert.equal(visualInvalidations, 0);
	owner.dispose();
});

test("grouped PNG and non-Kitty images use the direct path without conversion", (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	t.after(() => setCapabilities(previousCapabilities));
	const protocols = ["kitty", "iterm2"] as const;
	for (const protocol of protocols) {
		setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
		const group = new DeferredReadToolGroupComponent(true, 27);
		const message = toolResult(`direct-${protocol}`, [
			{ type: "text", text: `direct-${protocol}-`.repeat(1_000) },
			{
				type: "image",
				data: protocol === "kitty" ? "UE5HX0RJUkVDVA==" : "SlBFR19ESVJFQ1Q=",
				mimeType: protocol === "kitty" ? "image/png" : "image/jpeg",
			},
		]);
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, `direct-${protocol}`)!;
		const presentation = owner.create(message.content, message.toolCallId)!;
		assert.equal(presentation.version, 2);
		group.updateArgs(message.toolCallId, { path: `${protocol}.txt` });
		group.setArgsComplete(message.toolCallId);
		group.updateResult(message.toolCallId, message);
		assert.ok(group.setToolResultPresentation(message.toolCallId, presentation));
		owner.release();
		group.setExpanded(true);
		assert.equal(group.conversions.length, 0);
		assert.equal(group.getGroupedImageConversionLifecycleCounts().scheduled, 0);
		assert.equal(group.getGroupedImageConversionLifecycleCounts().imageComponents, 1);
		group[RELEASE_COMPONENT_RENDER_CACHE]();
		owner.dispose();
	}
});

test("loaded converter boundary decodes only during synchronous warm conversion", () => {
	let decodedBytes: Uint8Array | undefined;
	let frees = 0;
	const output = Uint8Array.from([1, 2, 3, 4]);
	const converter = {
		PhotonImage: {
			new_from_byteslice(bytes: Uint8Array) {
				decodedBytes = bytes;
				return {
					free(): void { frees++; },
					get_bytes(): Uint8Array { return output; },
				};
			},
		},
	} as unknown as LoadedPngConverter;
	const source = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
	const converted = convertToPngWithLoadedConverter(converter, source, "image/jpeg");
	assert.deepEqual(decodedBytes, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
	assert.deepEqual(converted, { data: Buffer.from(output).toString("base64"), mimeType: "image/png" });
	assert.equal(frees, 1);

	decodedBytes = undefined;
	const png = convertToPngWithLoadedConverter(converter, "UE5H", "image/png");
	assert.deepEqual(png, { data: "UE5H", mimeType: "image/png" });
	assert.equal(decodedBytes, undefined, "the direct PNG path must not decode or enter Photon");
});

test("loader settlement after grouped component release cannot reacquire source", async (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	let visualInvalidations = 0;
	const group = new DeferredReadToolGroupComponent(true, 32, () => { visualInvalidations++; });
	const message = toolResult("release-before-loader-reaction", [
		{ type: "text", text: "release-before-loader-".repeat(1_000) },
		{ type: "image", data: "UkVMRUFTRV9CRUZPUkVfTE9BREVS", mimeType: "image/webp" },
	]);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "release-loader")!;
	group.updateArgs(message.toolCallId, { path: "release.webp" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	group.setToolResultPresentation(message.toolCallId, owner.create(message.content, message.toolCallId)!);
	owner.release();
	group.setExpanded(true);
	assert.equal(group.getGroupedImageConversionLifecycleCounts().loaderWaiters, 1);
	group.settleLoader();
	group[RELEASE_COMPONENT_RENDER_CACHE]();
	await settleGroupedImageConversion();
	const counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.loaderSourceAcquisitions, 0);
	assert.equal(counts.base64Decodes, 0);
	assert.equal(counts.typedArrays, 0);
	assert.equal(counts.scheduled, 0);
	assert.equal(counts.accepted, 0);
	assert.equal(counts.loaderTasksDropped, 1);
	assert.equal(visualInvalidations, 0);
	owner.dispose();
});

test("one grouped loader readiness converts JPEG GIF and WebP once per current source", async (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	const group = new DeferredReadToolGroupComponent(true, 32);
	const message = toolResult("grouped-warm-format-matrix", [
		{ type: "text", text: "warm-format-matrix-".repeat(1_000) },
		{ type: "image", data: "SlBFRw==", mimeType: "image/jpeg" },
		{ type: "image", data: "R0lG", mimeType: "image/gif" },
		{ type: "image", data: "V0VCUA==", mimeType: "image/webp" },
	]);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "warm-matrix")!;
	group.updateArgs(message.toolCallId, { path: "formats.bin" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	group.setToolResultPresentation(message.toolCallId, owner.create(message.content, message.toolCallId)!);
	owner.release();
	group.setExpanded(true);
	assert.equal(group.loaderRequests, 1);
	assert.equal(group.conversions.length, 0);
	group.settleLoader();
	await settleGroupedImageConversion();
	let counts = group.getGroupedImageConversionLifecycleCounts();
	assert.deepEqual(group.conversions.map((conversion) => conversion.mimeType), ["image/jpeg", "image/gif", "image/webp"]);
	assert.equal(counts.loaderRequests, 1);
	assert.equal(counts.loaderTasksCreated, 1);
	assert.equal(counts.loaderWaiterHighWaterMark, 1);
	assert.equal(counts.loaderSourceAcquisitions, 3);
	assert.equal(counts.scheduled, 3);
	assert.equal(counts.accepted, 3);
	assert.equal(counts.base64Decodes, 3);
	assert.equal(counts.typedArrays, 3);
	assert.equal(counts.convertedResultObjects, 3);
	assert.equal(counts.imageComponents, 3);
	group.setImageWidthCells(41);
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(group.conversions.length, 3, "warm rebuild must reuse each converted source generation");
	assert.equal(counts.scheduled, 3);
	group.setExpanded(false);
	counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.sourceReferences, 0);
	assert.equal(counts.convertedImages, 0);
	assert.equal(counts.imageComponents, 0);
	owner.dispose();
});

test("unavailable grouped converter is cached without source acquisition or retry", async (t) => {
	initTheme("dark");
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));
	const group = new DeferredReadToolGroupComponent(true, 32);
	const message = toolResult("grouped-unavailable-converter", [
		{ type: "text", text: "unavailable-".repeat(1_000) },
		{ type: "image", data: "VU5BVkFJTEFCTEU=", mimeType: "image/jpeg" },
	]);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "unavailable")!;
	group.updateArgs(message.toolCallId, { path: "unavailable.jpg" });
	group.setArgsComplete(message.toolCallId);
	group.updateResult(message.toolCallId, message);
	group.setToolResultPresentation(message.toolCallId, owner.create(message.content, message.toolCallId)!);
	owner.release();
	group.setExpanded(true);
	group.settleLoader(null);
	await settleGroupedImageConversion();
	group.setImageWidthCells(43);
	const counts = group.getGroupedImageConversionLifecycleCounts();
	assert.equal(counts.loaderRequests, 1);
	assert.equal(counts.loaderSourceAcquisitions, 0);
	assert.equal(counts.scheduled, 0);
	assert.equal(counts.rejected, 1);
	assert.equal(counts.imageComponents, 0);
	owner.dispose();
});

test("never-settling grouped converter readiness does not retain released sources", () => {
	const worker = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			fileURLToPath(new URL("./fixtures/grouped-image-never-settling-gc.ts", import.meta.url)),
		],
		{ encoding: "utf8" },
	);
	assert.equal(worker.status, 0, worker.stderr || worker.stdout);
	const report = JSON.parse(worker.stdout) as {
		componentRetained: boolean;
		rowRetained: boolean;
		resultRetained: boolean;
		contentRetained: boolean;
		blockRetained: boolean;
		stateRetained: boolean;
		loaderRequests: number;
		sourceAcquisitions: number;
	};
	assert.deepEqual(report, {
		componentRetained: false,
		rowRetained: false,
		resultRetained: false,
		contentRetained: false,
		blockRetained: false,
		stateRetained: false,
		loaderRequests: 1,
		sourceAcquisitions: 0,
	});
});

test("interactive live and rebuild paths consume only the internal sidecar with a hard cap", () => {
	const interactive = readFileSync(
		new URL("../packages/coding-agent/src/modes/interactive/interactive-mode.ts", import.meta.url),
		"utf8",
	);
	const session = readFileSync(
		new URL("../packages/coding-agent/src/core/agent-session.ts", import.meta.url),
		"utf8",
	);
	const benchmark = readFileSync(
		new URL("../scripts/bench/tool-result-presentation-ui.ts", import.meta.url),
		"utf8",
	);
	assert.match(interactive, /event\.toolResultPresentation/);
	assert.match(interactive, /collectRecentToolResultPresentationsForUi/);
	assert.match(interactive, /MAX_TOOL_RESULT_DISCOVERIES\s*=\s*128/);
	assert.match(interactive, /pendingToolResultDiscoveries/);
	assert.match(interactive, /attachedToolResultDiscoveries/);
	assert.match(interactive, /clearToolResultDiscoveries/);
	assert.match(session, /getToolResultPresentationForUi/);
	assert.match(session, /toolResultPresentationEnabled/);
	assert.match(benchmark, /auditToolResultPresentationUiSources/);
	assert.match(benchmark, /tool-result-presentation-ui-source-audit\.ts/);
	assert.match(benchmark, /plainFullResultUi/);
	assert.match(benchmark, /boundedDiscoveryUi/);
	assert.match(benchmark, /liveRegistrationEventPath/);
	assert.match(benchmark, /runLiveToolResult/);
	assert.match(benchmark, /sessionSwitchUpdateDisplayCalls/);
	assert.match(benchmark, /measureMixedHistoryRebuild/);
	assert.match(benchmark, /captureCanonicalReplacementLifecycle/);
	assert.match(benchmark, /canonicalReplacementLifecycle/);
	assert.match(benchmark, /canonicalDispositionMatrix/);
	assert.match(benchmark, /groupedCloseoutLifecycle/);
	assert.match(benchmark, /nonInteractiveLazyCanonicalIndex/);
	assert.match(benchmark, /neverSettlingGroupedConverter/);
	assert.match(benchmark, /groupedCompactionDeduplication/);
	assert.match(benchmark, /liveProductionRegistrationWeakRefs/);
	assert.match(benchmark, /releasedProjectionRecordEntries/);
	assert.doesNotMatch(benchmark, /fullResultCopies:\s*0/);
});

test("UI allocation source audit executes the selected production chain and locks structural counts", () => {
	const audit = auditToolResultPresentationUiSources();
	assert.deepEqual(audit.transitiveSourceFiles, [
		"tool-execution.ts",
		"image-convert.ts",
		"photon.ts",
		"exif-orientation.ts",
		"render-utils.ts",
		"interactive-mode.ts",
		"agent-session.ts",
		"tool-result-presentation.ts/touchExactResidentProjectionRecord",
		"tool-result-presentation.ts/inspectToolResultPresentationForUiCandidate",
		"tool-output-budget.ts/candidate-inspection-fallback-estimator-chain",
		"tui.ts/Container",
		"components/box.ts",
		"components/text.ts",
		"components/spacer.ts",
		"utils.ts/wrapping",
	]);
	assert.equal(audit.registryHardCap, 128);
	assert.equal(audit.rebuildCandidateHardCap, 256);
	assert.equal(audit.canonicalIndexHardCap, 65_536);
	assert.equal(audit.resultRenderingArrayMaterializationSites, 39);
	assert.equal(audit.resultRenderingArrayLiteralSites, 31);
	assert.equal(audit.resultRenderingArraySpreadSites, 3);
	assert.equal(audit.resultRenderingCallSpreadSites, 3);
	assert.equal(audit.resultRenderingArrayProducingCallSites, 5);
	assert.equal(audit.resultRenderingStringProducingCallSites, 8, "bounded grouped preview slices only its 4,001-character prefix");
	assert.equal(audit.resultRenderingArrayConstructorSites, 0);
	assert.equal(audit.resultRenderingStringAppendSites, 26);
	assert.equal(audit.resultRenderingNumericAppendSites, 16);
	assert.equal(audit.resultRenderingUnclassifiedAppendSites, 0);
	assert.equal(audit.resultRenderingInlineClosureSites, 0);
	assert.equal(audit.resultRenderingSerializationSites, 0);
	assert.equal(audit.argumentSerializationSites, 1);
	assert.equal(audit.discoveryOwnershipCopyOperations, 0);
	assert.equal(audit.discoveryOwnershipSerializations, 0);
	assert.equal(audit.discoveryRegistrationObjectLiterals, 1);
	assert.equal(audit.discoveryOwnershipObjectLiterals, 6);
	assert.equal(audit.discoveryOwnershipArrayMaterializationSites, 2);
	assert.equal(audit.discoveryOwnershipInlineClosureSites, 1);
	assert.equal(audit.discoveryOwnershipMapConstructors, 9);
	assert.equal(audit.pendingRegistryMapConstructors, 1);
	assert.equal(audit.attachedRegistryMapConstructors, 1);
	assert.equal(audit.promotionArrayMaterializationSites, 0);
	assert.equal(audit.promotionInlineClosureSites, 0);
	assert.equal(audit.promotionCopyOperations, 0);
	assert.equal(audit.promotionSerializations, 0);
	assert.equal(audit.promotionObjectLiterals, 0);
	assert.equal(audit.promotionMapConstructors, 1, "the attached registry is created lazily once per mode lifecycle");
	assert.equal(audit.promotionSetConstructors, 0);
	assert.equal(audit.promotionPromises, 0);
	assert.equal(audit.promotionAbortControllers, 0);
	assert.equal(
		(audit as typeof audit & { discoveryRebuildCallerMapConstructors?: number })
			.discoveryRebuildCallerMapConstructors,
		3,
		"the production rebuild caller must participate in the structural audit",
	);
	assert.equal(audit.discoveryRebuildCallerArrayMaterializationSites, 1);
	assert.equal(audit.discoveryRebuildCallerInlineClosureSites, 1);
	assert.equal(audit.discoveryRebuildCallerCopyOperations, 0);
	assert.equal(audit.discoveryRebuildCallerSerializations, 0);
	assert.equal(audit.discoveryRebuildCallerObjectLiterals, 3);
	assert.equal(audit.discoveryRebuildCallerSetConstructors, 0);
	assert.equal(audit.discoveryRebuildCallerPromises, 0);
	assert.equal(audit.discoveryRebuildCallerAbortControllers, 0);
	assert.equal(audit.exactResidentTouchArrayMaterializationSites, 0);
	assert.equal(audit.exactResidentTouchInlineClosureSites, 0);
	assert.equal(audit.exactResidentTouchCopyOperations, 0);
	assert.equal(audit.exactResidentTouchSerializations, 0);
	assert.equal(audit.exactResidentTouchObjectLiterals, 0);
	assert.equal(audit.exactResidentTouchMapConstructors, 0);
	assert.equal(audit.exactResidentTouchSetConstructors, 0);
	assert.equal(audit.exactResidentTouchPromises, 0);
	assert.equal(audit.exactResidentTouchAbortControllers, 0);
	assert.equal(
		audit.candidateInspectionArrayMaterializationSites,
		2,
		"the conservative source envelope includes the exact-estimator-only arrays even though UI inspection uses fallback estimation",
	);
	assert.equal(audit.candidateInspectionInlineClosureSites, 0);
	assert.equal(audit.candidateInspectionCopyOperations, 0);
	assert.equal(audit.candidateInspectionSerializations, 0);
	assert.equal(
		audit.candidateInspectionObjectLiterals,
		3,
		"the full estimator chain includes scan-state, estimate, and exact-estimator-only input objects",
	);
	assert.equal(audit.candidateInspectionMapConstructors, 0);
	assert.equal(audit.candidateInspectionSetConstructors, 0);
	assert.equal(audit.candidateInspectionPromises, 0);
	assert.equal(audit.candidateInspectionAbortControllers, 0);
	assert.equal(audit.groupedRebuildArrayMaterializationSites, 0);
	assert.equal(audit.groupedRebuildInlineClosureSites, 0);
	assert.equal(audit.groupedRebuildCopyOperations, 0);
	assert.equal(audit.groupedRebuildSerializations, 0);
	assert.equal(audit.groupedRebuildMapConstructors, 0);
	assert.equal(audit.groupedRebuildSetConstructors, 0);
	assert.equal(audit.groupedRebuildPromises, 0);
	assert.equal(audit.groupedRebuildAbortControllers, 0);
	assert.equal(audit.groupedImageConversionArrayMaterializationSites, 1, "one lazy per-row ordinal state array");
	assert.equal(audit.groupedImageConversionInlineClosureSites, 2, "one settle pair per real conversion");
	assert.equal(audit.groupedImageConversionCopyOperations, 0);
	assert.equal(audit.groupedImageConversionSerializations, 0);
	assert.equal(audit.groupedImageConversionObjectLiterals, 1, "one state record per eligible image source generation");
	assert.equal(audit.groupedImageConversionMapConstructors, 1, "one lazy instance-owned conversion registry");
	assert.equal(audit.groupedImageConversionSetConstructors, 0);
	assert.equal(audit.groupedImageConversionPromises, 0, "the grouped owner does not wrap the converter promise");
	assert.equal(audit.groupedImageConversionPromiseProducingCallSites, 2);
	assert.equal(audit.groupedImageLoaderRequestCallSites, 1);
	assert.equal(audit.groupedImageLoaderReactionPromiseSites, 1);
	assert.equal(audit.groupedImageConversionAbortControllers, 0);
	assert.ok(audit.transitiveSourceFiles.includes("image-convert.ts"));
	assert.ok(audit.transitiveSourceFiles.includes("photon.ts"));
	assert.ok(audit.transitiveSourceFiles.includes("exif-orientation.ts"));
	assert.equal(audit.groupedImageColdLoaderArrayMaterializationSites, 1);
	assert.equal(audit.groupedImageColdLoaderInlineClosureSites, 3);
	assert.equal(audit.groupedImageColdLoaderObjectLiterals, 2);
	assert.equal(audit.groupedImageColdLoaderPromiseSites, 2);
	assert.equal(audit.groupedImageColdLoaderDynamicImportSites, 1);
	assert.equal(audit.groupedImageWarmConversionArrayMaterializationSites, 0);
	assert.equal(audit.groupedImageWarmConversionInlineClosureSites, 6);
	assert.equal(audit.groupedImageWarmConversionObjectLiterals, 2);
	assert.equal(audit.groupedImageWarmConversionPromiseSites, 0);
	assert.equal(audit.groupedImageWarmConversionTypedArraySites, 3);
	assert.equal(audit.groupedImageWarmConversionBufferCallSites, 2);
	assert.equal(audit.groupedImageCompatibilityWrapperInlineClosureSites, 0);
	assert.equal(audit.groupedImageCompatibilityWrapperObjectLiterals, 1);
	assert.equal(audit.groupedImageCompatibilityWrapperPromiseSites, 2);
	assert.equal(audit.groupedImageCompatibilityWrapperTypedArraySites, 0);
	assert.equal(audit.groupedImageCompatibilityWrapperBufferCallSites, 0);
	assert.equal(audit.canonicalPayloadRefreshArrayMaterializationSites, 0);
	assert.equal(audit.canonicalPayloadRefreshInlineClosureSites, 0);
	assert.equal(audit.canonicalPayloadRefreshCopyOperations, 0);
	assert.equal(audit.canonicalPayloadRefreshSerializations, 0);
	assert.equal(audit.canonicalPayloadRefreshObjectLiterals, 0);
	assert.equal(audit.canonicalPayloadRefreshMapConstructors, 0);
	assert.equal(audit.canonicalPayloadRefreshSetConstructors, 0);
	assert.equal(audit.canonicalPayloadRefreshPromises, 0);
	assert.equal(audit.canonicalPayloadRefreshAbortControllers, 0);
	assert.equal(audit.discoveryOwnershipSetConstructors, 1, "successful compaction owns one bounded low-frequency component-dedup Set");
	assert.equal(audit.promises, 0);
	assert.equal(audit.abortControllers, 0);
});

test("UI candidate inspection fallback estimator has a bounded transient allocation contract", () => {
	const counters = createToolOutputEstimatorCounters();
	estimateToolOutputTokens([{ type: "text", text: "candidate-inspection-allocation" }], undefined, counters);

	assert.equal(counters.estimatorCalls, 1);
	assert.equal(counters.scanStateObjectsCreated, 1);
	assert.equal(counters.estimateObjectsCreated, 1);
	assert.equal(counters.exactInputObjectsCreated, 0);
	assert.equal(counters.exactEstimatorCalls, 0);
	assert.equal(counters.activeRetainedReferences, 0);
});

test("UI candidate inspection rejects malformed and throwing content before resident lookup or admission", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters },
		"ui-candidate-shape-validation",
	)!;
	const canonical: ToolResultPresentationContent[] = [{ type: "text", text: "canonical-".repeat(1_000) }];
	const presentation = owner.create(canonical, "resident-shape-id");
	assert.equal(presentation?.version, 2);
	owner.release();
	const before = {
		entries: counters.projectionRecordEntries,
		retained: counters.retainedProjectionCodeUnits,
		evictions: counters.projectionRecordEvictions,
		artifacts: counters.artifactDescriptorsCreated,
		hits: counters.projectionRecordHits,
	};
	const malformed: unknown[] = [
		undefined,
		null,
		"not-an-array",
		[null],
		[1],
		[{ type: "text" }],
		[{ type: "text", text: 1 }],
		[{ type: "image", data: "AA==" }],
		[{ type: "image", mimeType: "image/png" }],
		[{ type: "image", data: 1, mimeType: false }],
		[{ type: "unknown", text: "nope" }],
		[{ type: "text", text: "valid" }, { type: "image", data: "AA==" }],
		new Proxy([], { get: () => { throw new Error("throwing array getter"); } }),
		[new Proxy({}, { get: () => { throw new Error("throwing block getter"); } })],
	];
	for (const candidate of malformed) {
		assert.doesNotThrow(() => {
			assert.equal(owner.inspectToolResultPresentationForUiCandidate(candidate, "resident-shape-id"), undefined);
		});
	}
	assert.deepEqual(
		{
			entries: counters.projectionRecordEntries,
			retained: counters.retainedProjectionCodeUnits,
			evictions: counters.projectionRecordEvictions,
			artifacts: counters.artifactDescriptorsCreated,
			hits: counters.projectionRecordHits,
		},
		before,
	);
	assert.equal(owner.inspectToolResultPresentationForUiCandidate([], "empty-valid-id"), "v1");
	owner.dispose();
});
