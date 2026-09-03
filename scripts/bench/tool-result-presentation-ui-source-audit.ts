import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface ToolResultPresentationUiSourceAudit {
	readonly registryHardCap: number;
	readonly transitiveSourceFiles: readonly string[];
	readonly resultRenderingArrayMaterializationSites: number;
	readonly resultRenderingArrayLiteralSites: number;
	readonly resultRenderingArraySpreadSites: number;
	readonly resultRenderingCallSpreadSites: number;
	readonly resultRenderingArrayProducingCallSites: number;
	readonly resultRenderingStringProducingCallSites: number;
	readonly resultRenderingArrayConstructorSites: number;
	readonly resultRenderingStringAppendSites: number;
	readonly resultRenderingNumericAppendSites: number;
	readonly resultRenderingUnclassifiedAppendSites: number;
	readonly resultRenderingInlineClosureSites: number;
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
	callSpreads: number;
	arrayProducingCalls: number;
	stringProducingCalls: number;
	arrayConstructors: number;
	stringAppendAssignments: number;
	numericAppendAssignments: number;
	unclassifiedAppendAssignments: number;
	inlineClosures: number;
	serializations: number;
	copyOperations: number;
	promises: number;
	abortControllers: number;
}

const ARRAY_PRODUCING_METHODS = new Set(["filter", "flat", "flatMap", "map", "match", "matchAll", "slice", "split"]);

function declarationName(name: ts.DeclarationName | undefined): string | undefined {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function selectNamedDeclarations(sourceFile: ts.SourceFile, names: readonly string[]): ts.Node[] {
	const declarations = new Map<string, ts.Node>();
	for (const statement of sourceFile.statements) {
		if ((!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) || !statement.name) continue;
		if (names.includes(statement.name.text)) declarations.set(statement.name.text, statement);
	}
	const missing = names.filter((name) => !declarations.has(name));
	if (missing.length > 0) throw new Error(`Missing declarations in ${sourceFile.fileName}: ${missing.join(", ")}`);
	return names.map((name) => declarations.get(name)!);
}

function selectClassMembers(sourceFile: ts.SourceFile, className: string, names: readonly string[]): ts.Node[] {
	const classDeclaration = sourceFile.statements.find(
		(statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
	);
	if (!classDeclaration) throw new Error(`Missing class in ${sourceFile.fileName}: ${className}`);
	const members = new Map<string, ts.Node>();
	for (const member of classDeclaration.members) {
		if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue;
		const name = declarationName(member.name);
		if (name && names.includes(name)) members.set(name, member);
	}
	const missing = names.filter((name) => !members.has(name));
	if (missing.length > 0) throw new Error(`Missing members in ${sourceFile.fileName}:${className}: ${missing.join(", ")}`);
	return names.map((name) => members.get(name)!);
}

function isIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
	return !!node && ts.isIdentifier(node) && node.text === name;
}

function includesTypeFlag(type: ts.Type, flag: ts.TypeFlags): boolean {
	return type.isUnion() ? type.types.some((part) => includesTypeFlag(part, flag)) : (type.flags & flag) !== 0;
}

function includesArrayType(type: ts.Type, checker: ts.TypeChecker): boolean {
	return type.isUnion()
		? type.types.some((part) => includesArrayType(part, checker))
		: checker.isArrayType(type) || checker.isTupleType(type);
}

function countAst(nodes: readonly ts.Node[], checker?: ts.TypeChecker): AstCounts {
	const counts: AstCounts = {
		arrayLiterals: 0,
		arraySpreads: 0,
		callSpreads: 0,
		arrayProducingCalls: 0,
		stringProducingCalls: 0,
		arrayConstructors: 0,
		stringAppendAssignments: 0,
		numericAppendAssignments: 0,
		unclassifiedAppendAssignments: 0,
		inlineClosures: 0,
		serializations: 0,
		copyOperations: 0,
		promises: 0,
		abortControllers: 0,
	};
	const visit = (node: ts.Node): void => {
		if (ts.isArrayLiteralExpression(node)) {
			counts.arrayLiterals++;
		} else if (ts.isSpreadElement(node)) {
			if (ts.isArrayLiteralExpression(node.parent)) counts.arraySpreads++;
			else counts.callSpreads++;
		} else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
			const leftType = checker?.getTypeAtLocation(node.left);
			if (leftType && includesTypeFlag(leftType, ts.TypeFlags.StringLike)) counts.stringAppendAssignments++;
			else if (leftType && includesTypeFlag(leftType, ts.TypeFlags.NumberLike)) counts.numericAppendAssignments++;
			else counts.unclassifiedAppendAssignments++;
		} else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
			counts.inlineClosures++;
		} else if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (ts.isPropertyAccessExpression(expression)) {
				const returnType = checker?.getTypeAtLocation(node);
				if (ARRAY_PRODUCING_METHODS.has(expression.name.text)) {
					if (!checker || !returnType || includesArrayType(returnType, checker)) counts.arrayProducingCalls++;
					else if (includesTypeFlag(returnType, ts.TypeFlags.StringLike)) counts.stringProducingCalls++;
				}
				if (isIdentifierNamed(expression.expression, "JSON") && expression.name.text === "stringify") {
					counts.serializations++;
				}
				if (isIdentifierNamed(expression.expression, "Array") && (expression.name.text === "from" || expression.name.text === "of")) {
					counts.arrayProducingCalls++;
				}
				if (
					(expression.name.text === "slice" || expression.name.text === "map") &&
					(!checker || !returnType || includesArrayType(returnType, checker))
				) counts.copyOperations++;
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
	const visited = new Set<ts.Node>();
	for (const node of nodes) {
		if (visited.has(node)) continue;
		visited.add(node);
		visit(node);
	}
	return counts;
}

function createSourceProgram(rootNames: readonly string[]): ts.Program {
	const configPath = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
	return ts.createProgram({ rootNames: [...rootNames], options: { ...parsed.options, noEmit: true } });
}

function requireSourceFile(program: ts.Program, path: string): ts.SourceFile {
	const sourceFile = program.getSourceFile(path);
	if (!sourceFile) throw new Error(`Missing TypeScript program source: ${path}`);
	return sourceFile;
}

export function auditToolResultPresentationUiSources(): ToolResultPresentationUiSourceAudit {
	const sourcePaths = {
		toolComponent: fileURLToPath(new URL("../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts", import.meta.url)),
		interactive: fileURLToPath(new URL("../../packages/coding-agent/src/modes/interactive/interactive-mode.ts", import.meta.url)),
		agentSession: fileURLToPath(new URL("../../packages/coding-agent/src/core/agent-session.ts", import.meta.url)),
		renderUtils: fileURLToPath(new URL("../../packages/coding-agent/src/core/tools/render-utils.ts", import.meta.url)),
		tuiContainer: fileURLToPath(new URL("../../packages/tui/src/tui.ts", import.meta.url)),
		tuiBox: fileURLToPath(new URL("../../packages/tui/src/components/box.ts", import.meta.url)),
		tuiText: fileURLToPath(new URL("../../packages/tui/src/components/text.ts", import.meta.url)),
		tuiSpacer: fileURLToPath(new URL("../../packages/tui/src/components/spacer.ts", import.meta.url)),
		tuiUtils: fileURLToPath(new URL("../../packages/tui/src/utils.ts", import.meta.url)),
	};
	const program = createSourceProgram(Object.values(sourcePaths));
	const checker = program.getTypeChecker();
	const toolComponent = requireSourceFile(program, sourcePaths.toolComponent);
	const interactive = requireSourceFile(program, sourcePaths.interactive);
	const agentSession = requireSourceFile(program, sourcePaths.agentSession);
	const renderUtils = requireSourceFile(program, sourcePaths.renderUtils);
	const tuiContainer = requireSourceFile(program, sourcePaths.tuiContainer);
	const tuiBox = requireSourceFile(program, sourcePaths.tuiBox);
	const tuiText = requireSourceFile(program, sourcePaths.tuiText);
	const tuiSpacer = requireSourceFile(program, sourcePaths.tuiSpacer);
	const tuiUtils = requireSourceFile(program, sourcePaths.tuiUtils);
	const discoveryOwnershipNodes = [
		...selectClassMembers(toolComponent, "ReadToolGroupComponent", ["setToolResultPresentation", "clearToolResultPresentation"]),
		...selectClassMembers(toolComponent, "ToolExecutionComponent", ["setToolResultPresentation", "clearToolResultPresentation"]),
		...selectClassMembers(interactive, "InteractiveMode", [
			"evictOldestToolResultDiscovery",
			"addToolResultDiscovery",
			"trackToolResultPresentationTarget",
			"attachToolResultPresentation",
			"attachLiveToolResultPresentation",
			"clearToolResultDiscoveries",
			"getToolResultDiscoveryLifecycleCounts",
		]),
		...selectClassMembers(agentSession, "AgentSession", [
			"toolResultPresentationEnabled",
			"getToolResultPresentationForUi",
			"readToolResultContinuation",
			"readToolResultArtifact",
		]),
	];
	const toolResultRenderingNodes = [
		...selectNamedDeclarations(toolComponent, [
			"createToolResultDiscovery",
			"formatToolResultDiscovery",
			"getReadGroupResultText",
			"boundReadGroupPreview",
		]),
		...selectClassMembers(toolComponent, "ReadToolGroupComponent", [
			"setToolResultPresentation",
			"clearToolResultPresentation",
			"getDisplayRows",
			"rebuild",
		]),
		...selectClassMembers(toolComponent, "ToolExecutionComponent", [
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
		...selectNamedDeclarations(renderUtils, ["getTextOutput"]),
	];
	const tuiResultRenderingNodes = [
		...selectClassMembers(tuiContainer, "Container", ["render"]),
		...selectNamedDeclarations(tuiContainer, ["renderContainerInto"]),
		...selectClassMembers(tuiBox, "Box", ["matchCache", "render", "applyBg"]),
		...selectClassMembers(tuiText, "Text", ["render"]),
		...selectClassMembers(tuiSpacer, "Spacer", ["render"]),
		...selectNamedDeclarations(tuiUtils, [
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
	];
	const renderingCounts = countAst(
		[...toolResultRenderingNodes, ...tuiResultRenderingNodes, ...discoveryOwnershipNodes],
		checker,
	);
	const argumentCounts = countAst(
		selectClassMembers(toolComponent, "ToolExecutionComponent", ["serializeArgs"]),
		checker,
	);
	const ownershipCounts = countAst(discoveryOwnershipNodes, checker);
	const interactiveSource = readFileSync(sourcePaths.interactive, "utf8");
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
			"components/spacer.ts",
			"utils.ts/wrapping",
		],
		resultRenderingArrayMaterializationSites:
			renderingCounts.arrayLiterals +
			renderingCounts.arraySpreads +
			renderingCounts.arrayProducingCalls +
			renderingCounts.arrayConstructors,
		resultRenderingArrayLiteralSites: renderingCounts.arrayLiterals,
		resultRenderingArraySpreadSites: renderingCounts.arraySpreads,
		resultRenderingCallSpreadSites: renderingCounts.callSpreads,
		resultRenderingArrayProducingCallSites: renderingCounts.arrayProducingCalls,
		resultRenderingStringProducingCallSites: renderingCounts.stringProducingCalls,
		resultRenderingArrayConstructorSites: renderingCounts.arrayConstructors,
		resultRenderingStringAppendSites: renderingCounts.stringAppendAssignments,
		resultRenderingNumericAppendSites: renderingCounts.numericAppendAssignments,
		resultRenderingUnclassifiedAppendSites: renderingCounts.unclassifiedAppendAssignments,
		resultRenderingInlineClosureSites: renderingCounts.inlineClosures,
		resultRenderingSerializationSites: renderingCounts.serializations,
		argumentSerializationSites: argumentCounts.serializations,
		discoveryOwnershipCopyOperations: ownershipCounts.copyOperations,
		discoveryOwnershipSerializations: ownershipCounts.serializations,
		promises: ownershipCounts.promises,
		abortControllers: ownershipCounts.abortControllers,
	};
}
