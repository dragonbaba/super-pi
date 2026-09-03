import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELEASE_COMPONENT_RENDER_CACHE, setKeybindings, type TUI } from "@super-pi/tui";
import ts from "typescript";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import { KeybindingsManager } from "../packages/coding-agent/src/core/keybindings.ts";
import {
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

test("expanded grouped read rows expose complete canonical text beyond preview limits", () => {
	initTheme("dark");
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
	assert.match(expanded, /image\/png/);
	assert.match(expanded, /error-tail/);
	assert.match(expanded, /Full canonical result is shown/);
	owner.dispose();
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
	assert.match(benchmark, /liveProductionRegistrationWeakRefs/);
	assert.match(benchmark, /releasedProjectionRecordEntries/);
	assert.doesNotMatch(benchmark, /fullResultCopies:\s*0/);
});

test("UI allocation source audit executes the selected production chain and locks structural counts", () => {
	const audit = auditToolResultPresentationUiSources();
	assert.deepEqual(audit.transitiveSourceFiles, [
		"tool-execution.ts",
		"render-utils.ts",
		"interactive-mode.ts",
		"agent-session.ts",
		"tui.ts/Container",
		"components/box.ts",
		"components/text.ts",
		"components/spacer.ts",
		"utils.ts/wrapping",
	]);
	assert.equal(audit.registryHardCap, 128);
	assert.equal(audit.rebuildCandidateHardCap, 256);
	assert.equal(audit.resultRenderingArrayMaterializationSites, 38);
	assert.equal(audit.resultRenderingArrayLiteralSites, 30);
	assert.equal(audit.resultRenderingArraySpreadSites, 3);
	assert.equal(audit.resultRenderingCallSpreadSites, 3);
	assert.equal(audit.resultRenderingArrayProducingCallSites, 5);
	assert.equal(audit.resultRenderingStringProducingCallSites, 7);
	assert.equal(audit.resultRenderingArrayConstructorSites, 0);
	assert.equal(audit.resultRenderingStringAppendSites, 25);
	assert.equal(audit.resultRenderingNumericAppendSites, 15);
	assert.equal(audit.resultRenderingUnclassifiedAppendSites, 0);
	assert.equal(audit.resultRenderingInlineClosureSites, 0);
	assert.equal(audit.resultRenderingSerializationSites, 0);
	assert.equal(audit.argumentSerializationSites, 1);
	assert.equal(audit.discoveryOwnershipCopyOperations, 0);
	assert.equal(audit.discoveryOwnershipSerializations, 0);
	assert.equal(audit.discoveryRegistrationObjectLiterals, 1);
	assert.equal(audit.discoveryOwnershipObjectLiterals, 3);
	assert.equal(audit.discoveryOwnershipMapConstructors, 5);
	assert.equal(
		(audit as typeof audit & { discoveryRebuildCallerMapConstructors?: number })
			.discoveryRebuildCallerMapConstructors,
		1,
		"the production rebuild caller must participate in the structural audit",
	);
	assert.equal(audit.discoveryOwnershipSetConstructors, 0);
	assert.equal(audit.promises, 0);
	assert.equal(audit.abortControllers, 0);
});
