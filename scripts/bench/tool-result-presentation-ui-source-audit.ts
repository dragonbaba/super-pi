import { readFileSync } from "node:fs";
import ts from "typescript";

export interface ToolResultPresentationUiSourceAudit {
	readonly registryHardCap: number;
	readonly transitiveSourceFiles: readonly string[];
	readonly resultRenderingArrayMaterializationSites: number;
	readonly resultRenderingArrayLiteralSites: number;
	readonly resultRenderingArraySpreadSites: number;
	readonly resultRenderingArrayProducingCallSites: number;
	readonly resultRenderingArrayConstructorSites: number;
	readonly resultRenderingStringAppendSites: number;
	readonly resultRenderingSerializationSites: number;
	readonly argumentSerializationSites: number;
	readonly discoveryOwnershipCopyOperations: number;
	readonly discoveryOwnershipSerializations: number;
	readonly promises: number;
	readonly abortControllers: number;
}

interface AstCounts {
	arrayLiterals: number;
	arraySpreads: number;
	arrayProducingCalls: number;
	arrayConstructors: number;
	appendAssignments: number;
	serializations: number;
	copyOperations: number;
	promises: number;
	abortControllers: number;
}

const ARRAY_PRODUCING_METHODS = new Set(["filter", "flat", "flatMap", "map", "match", "matchAll", "slice", "split"]);

function sourceRegion(source: string, start: string, end: string, from = 0): string {
	const startIndex = source.indexOf(start, from);
	if (startIndex < 0) throw new Error(`Missing source marker: ${start}`);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (endIndex < 0) throw new Error(`Missing source marker: ${end}`);
	return source.slice(startIndex, endIndex);
}

function declarationName(name: ts.DeclarationName | undefined): string | undefined {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function extractNamedDeclarations(source: string, fileName: string, names: readonly string[]): string {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declarations = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if ((!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) || !statement.name) continue;
		if (names.includes(statement.name.text)) declarations.set(statement.name.text, statement.getText(sourceFile));
	}
	const missing = names.filter((name) => !declarations.has(name));
	if (missing.length > 0) throw new Error(`Missing declarations in ${fileName}: ${missing.join(", ")}`);
	return names.map((name) => declarations.get(name)!).join("\n");
}

function extractClassMethods(source: string, fileName: string, className: string, names: readonly string[]): string {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const classDeclaration = sourceFile.statements.find(
		(statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
	);
	if (!classDeclaration) throw new Error(`Missing class in ${fileName}: ${className}`);
	const methods = new Map<string, string>();
	for (const member of classDeclaration.members) {
		if (!ts.isMethodDeclaration(member)) continue;
		const name = declarationName(member.name);
		if (name && names.includes(name)) methods.set(name, member.getText(sourceFile));
	}
	const missing = names.filter((name) => !methods.has(name));
	if (missing.length > 0) throw new Error(`Missing methods in ${fileName}:${className}: ${missing.join(", ")}`);
	return `class ${className}Audit {\n${names.map((name) => methods.get(name)!).join("\n")}\n}`;
}

function wrapClassMembers(name: string, members: string): string {
	return `class ${name} {\n${members}\n}`;
}

function isIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
	return !!node && ts.isIdentifier(node) && node.text === name;
}

function countAst(source: string, fileName: string): AstCounts {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const counts: AstCounts = {
		arrayLiterals: 0,
		arraySpreads: 0,
		arrayProducingCalls: 0,
		arrayConstructors: 0,
		appendAssignments: 0,
		serializations: 0,
		copyOperations: 0,
		promises: 0,
		abortControllers: 0,
	};
	const visit = (node: ts.Node): void => {
		if (ts.isArrayLiteralExpression(node)) {
			counts.arrayLiterals++;
		} else if (ts.isSpreadElement(node)) {
			counts.arraySpreads++;
		} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
			counts.appendAssignments++;
		} else if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (ts.isPropertyAccessExpression(expression)) {
				if (ARRAY_PRODUCING_METHODS.has(expression.name.text)) counts.arrayProducingCalls++;
				if (isIdentifierNamed(expression.expression, "JSON") && expression.name.text === "stringify") {
					counts.serializations++;
				}
				if (isIdentifierNamed(expression.expression, "Array") && (expression.name.text === "from" || expression.name.text === "of")) {
					counts.arrayProducingCalls++;
				}
				if (expression.name.text === "slice" || expression.name.text === "map") counts.copyOperations++;
			} else if (isIdentifierNamed(expression, "structuredClone")) {
				counts.copyOperations++;
			} else if (isIdentifierNamed(expression, "Array")) {
				counts.arrayProducingCalls++;
			}
		} else if (ts.isNewExpression(node)) {
			if (isIdentifierNamed(node.expression, "Array")) counts.arrayConstructors++;
			if (isIdentifierNamed(node.expression, "Promise")) counts.promises++;
			if (isIdentifierNamed(node.expression, "AbortController")) counts.abortControllers++;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return counts;
}

export function auditToolResultPresentationUiSources(): ToolResultPresentationUiSourceAudit {
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
	const tuiContainerSource = readFileSync(new URL("../../packages/tui/src/tui.ts", import.meta.url), "utf8");
	const tuiBoxSource = readFileSync(new URL("../../packages/tui/src/components/box.ts", import.meta.url), "utf8");
	const tuiTextSource = readFileSync(new URL("../../packages/tui/src/components/text.ts", import.meta.url), "utf8");
	const tuiUtilsSource = readFileSync(new URL("../../packages/tui/src/utils.ts", import.meta.url), "utf8");
	const firstComponentSetter = toolComponentSource.indexOf("\tsetToolResultPresentation(");
	const secondComponentSetter = toolComponentSource.indexOf("\tsetToolResultPresentation(", firstComponentSetter + 1);
	const discoveryOwnershipSource = [
		wrapClassMembers(
			"ReadGroupDiscoveryAudit",
			sourceRegion(toolComponentSource, "\tsetToolResultPresentation(", "\n\tprivate getDisplayRows"),
		),
		wrapClassMembers(
			"ToolDiscoveryAudit",
			sourceRegion(toolComponentSource, "\tsetToolResultPresentation(", "\n\tsetShowImages", secondComponentSetter),
		),
		wrapClassMembers(
			"InteractiveDiscoveryAudit",
			sourceRegion(interactiveSource, "\tprivate evictOldestToolResultDiscovery(", "\n\tprivate retainActiveToolComponent"),
		),
		wrapClassMembers(
			"SessionDiscoveryAudit",
			sourceRegion(agentSessionSource, "\tget toolResultPresentationEnabled", "\n\t/** Read one bounded continuation"),
		),
	].join("\n");
	const toolResultRenderingSource = [
		extractNamedDeclarations(toolComponentSource, "tool-execution.ts", [
			"createToolResultDiscovery",
			"formatToolResultDiscovery",
			"getReadGroupResultText",
			"boundReadGroupPreview",
		]),
		extractClassMethods(toolComponentSource, "tool-execution.ts", "ReadToolGroupComponent", [
			"setToolResultPresentation",
			"clearToolResultPresentation",
			"getDisplayRows",
			"rebuild",
		]),
		extractClassMethods(toolComponentSource, "tool-execution.ts", "ToolExecutionComponent", [
			"createCallFallback",
			"createResultFallback",
			"getCallRenderer",
			"getResultRenderer",
			"isCallRendererArgsOnly",
			"hasRendererDefinition",
			"getRenderShell",
			"getRenderContext",
			"setToolResultPresentation",
			"clearToolResultPresentation",
			"render",
			"updateDisplay",
			"getTextOutput",
			"formatToolExecution",
			"refreshImageTree",
		]),
		extractNamedDeclarations(renderUtilsSource, "render-utils.ts", ["getTextOutput"]),
	].join("\n");
	const tuiResultRenderingSource = [
		extractClassMethods(tuiContainerSource, "tui.ts", "Container", ["render"]),
		extractNamedDeclarations(tuiContainerSource, "tui.ts", ["renderContainerInto"]),
		extractClassMethods(tuiBoxSource, "components/box.ts", "Box", ["matchCache", "render", "applyBg"]),
		extractClassMethods(tuiTextSource, "components/text.ts", "Text", ["render"]),
		extractNamedDeclarations(tuiUtilsSource, "utils.ts", [
			"getGraphemeSegmenter",
			"getWordSegmenter",
			"couldBeEmoji",
			"isPrintableAscii",
			"graphemeWidth",
			"isSimpleTerminalAsciiRun",
			"visibleWidth",
			"extractAnsiCode",
			"findTerminalSequenceEnd",
			"parseOsc8Hyperlink",
			"formatOsc8Hyperlink",
			"formatOsc8Close",
			"getActiveOsc8Close",
			"AnsiCodeTracker",
			"updateTrackerFromText",
			"splitIntoTokensWithAnsi",
			"wrapTextWithAnsi",
			"wrapSingleLine",
			"isWhitespaceChar",
			"isPunctuationChar",
			"breakLongWord",
			"applyBackgroundToLine",
		]),
	].join("\n");
	const transitiveResultRenderingSource = [toolResultRenderingSource, tuiResultRenderingSource, discoveryOwnershipSource].join("\n");
	const argumentSerializationSource = extractClassMethods(
		toolComponentSource,
		"tool-execution.ts",
		"ToolExecutionComponent",
		["serializeArgs"],
	);
	const renderingCounts = countAst(transitiveResultRenderingSource, "transitive-result-rendering.ts");
	const argumentCounts = countAst(argumentSerializationSource, "argument-serialization.ts");
	const ownershipCounts = countAst(discoveryOwnershipSource, "discovery-ownership.ts");
	const registryHardCap = Number(interactiveSource.match(/MAX_TOOL_RESULT_DISCOVERIES\s*=\s*(\d+)/u)?.[1] ?? 0);
	return {
		registryHardCap,
		transitiveSourceFiles: [
			"tool-execution.ts",
			"render-utils.ts",
			"interactive-mode.ts",
			"agent-session.ts",
			"tui.ts/Container",
			"components/box.ts",
			"components/text.ts",
			"utils.ts/wrapping",
		],
		resultRenderingArrayMaterializationSites:
			renderingCounts.arrayLiterals +
			renderingCounts.arraySpreads +
			renderingCounts.arrayProducingCalls +
			renderingCounts.arrayConstructors,
		resultRenderingArrayLiteralSites: renderingCounts.arrayLiterals,
		resultRenderingArraySpreadSites: renderingCounts.arraySpreads,
		resultRenderingArrayProducingCallSites: renderingCounts.arrayProducingCalls,
		resultRenderingArrayConstructorSites: renderingCounts.arrayConstructors,
		resultRenderingStringAppendSites: renderingCounts.appendAssignments,
		resultRenderingSerializationSites: renderingCounts.serializations,
		argumentSerializationSites: argumentCounts.serializations,
		discoveryOwnershipCopyOperations: ownershipCounts.copyOperations,
		discoveryOwnershipSerializations: ownershipCounts.serializations,
		promises: ownershipCounts.promises,
		abortControllers: ownershipCounts.abortControllers,
	};
}
