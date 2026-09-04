import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface ToolResultPresentationUiSourceAudit {
	readonly registryHardCap: number;
	readonly rebuildCandidateHardCap: number;
	readonly canonicalIndexHardCap: number;
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
	readonly discoveryOwnershipArrayMaterializationSites: number;
	readonly discoveryOwnershipInlineClosureSites: number;
	readonly discoveryRegistrationObjectLiterals: number;
	readonly discoveryOwnershipObjectLiterals: number;
	readonly discoveryOwnershipMapConstructors: number;
	readonly discoveryOwnershipSetConstructors: number;
	readonly pendingRegistryMapConstructors: number;
	readonly attachedRegistryMapConstructors: number;
	readonly promotionArrayMaterializationSites: number;
	readonly promotionInlineClosureSites: number;
	readonly promotionCopyOperations: number;
	readonly promotionSerializations: number;
	readonly promotionObjectLiterals: number;
	readonly promotionMapConstructors: number;
	readonly promotionSetConstructors: number;
	readonly promotionPromises: number;
	readonly promotionAbortControllers: number;
	readonly discoveryRebuildCallerArrayMaterializationSites: number;
	readonly discoveryRebuildCallerInlineClosureSites: number;
	readonly discoveryRebuildCallerCopyOperations: number;
	readonly discoveryRebuildCallerSerializations: number;
	readonly discoveryRebuildCallerObjectLiterals: number;
	readonly discoveryRebuildCallerMapConstructors: number;
	readonly discoveryRebuildCallerSetConstructors: number;
	readonly discoveryRebuildCallerPromises: number;
	readonly discoveryRebuildCallerAbortControllers: number;
	readonly exactResidentTouchArrayMaterializationSites: number;
	readonly exactResidentTouchInlineClosureSites: number;
	readonly exactResidentTouchCopyOperations: number;
	readonly exactResidentTouchSerializations: number;
	readonly exactResidentTouchObjectLiterals: number;
	readonly exactResidentTouchMapConstructors: number;
	readonly exactResidentTouchSetConstructors: number;
	readonly exactResidentTouchPromises: number;
	readonly exactResidentTouchAbortControllers: number;
	readonly candidateInspectionArrayMaterializationSites: number;
	readonly candidateInspectionInlineClosureSites: number;
	readonly candidateInspectionCopyOperations: number;
	readonly candidateInspectionSerializations: number;
	readonly candidateInspectionObjectLiterals: number;
	readonly candidateInspectionMapConstructors: number;
	readonly candidateInspectionSetConstructors: number;
	readonly candidateInspectionPromises: number;
	readonly candidateInspectionAbortControllers: number;
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
	objectLiterals: number;
	mapConstructors: number;
	setConstructors: number;
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

function includesArrayType(type: ts.Type, checker: ts.TypeChecker, visited = new Set<ts.Type>()): boolean {
	if (visited.has(type)) return false;
	visited.add(type);
	if (type.isUnion()) return type.types.some((part) => includesArrayType(part, checker, visited));
	if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
	if ((type.flags & ts.TypeFlags.Object) === 0) return false;
	const objectType = type as ts.ObjectType;
	if ((objectType.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) === 0) return false;
	const baseTypes = checker.getBaseTypes(type as ts.InterfaceType);
	return baseTypes?.some((base) => includesArrayType(base, checker, visited)) === true;
}

function classifyProducingCallType(type: ts.Type, checker: ts.TypeChecker): "array" | "string" | "other" {
	if (includesArrayType(type, checker)) return "array";
	if (includesTypeFlag(type, ts.TypeFlags.StringLike)) return "string";
	return "other";
}

function isDefaultLibraryDeclaration(declaration: ts.SignatureDeclaration): boolean {
	const sourceFile = declaration.getSourceFile();
	return sourceFile.isDeclarationFile && sourceFile.hasNoDefaultLib && /^lib(?:\..+)?\.d\.ts$/u.test(basename(sourceFile.fileName));
}

export function classifyProducingCall(node: ts.CallExpression, checker: ts.TypeChecker): "array" | "string" | "other" {
	if (!ts.isPropertyAccessExpression(node.expression)) return "other";
	const name = node.expression.name.text;
	if (!ARRAY_PRODUCING_METHODS.has(name)) return "other";
	const declaration = checker.getResolvedSignature(node)?.getDeclaration();
	if (!declaration || !isDefaultLibraryDeclaration(declaration)) return "other";
	const receiverType = checker.getTypeAtLocation(node.expression.expression);
	const arrayReceiver = includesArrayType(receiverType, checker);
	const stringReceiver = includesTypeFlag(receiverType, ts.TypeFlags.StringLike);
	if (
		((name === "filter" || name === "flat" || name === "flatMap" || name === "map") && !arrayReceiver) ||
		((name === "match" || name === "matchAll" || name === "split") && !stringReceiver) ||
		(name === "slice" && !arrayReceiver && !stringReceiver)
	) return "other";
	return classifyProducingCallType(checker.getTypeAtLocation(node), checker);
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
		objectLiterals: 0,
		mapConstructors: 0,
		setConstructors: 0,
		promises: 0,
		abortControllers: 0,
	};
	const visit = (node: ts.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			counts.objectLiterals++;
		} else if (ts.isArrayLiteralExpression(node)) {
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
					const classification = checker ? classifyProducingCall(node, checker) : "array";
					if (classification === "array") counts.arrayProducingCalls++;
					else if (classification === "string") counts.stringProducingCalls++;
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
			if (isIdentifierNamed(node.expression, "Map")) counts.mapConstructors++;
			if (isIdentifierNamed(node.expression, "Set")) counts.setConstructors++;
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
		toolResultPresentation: fileURLToPath(new URL("../../packages/coding-agent/src/core/tool-result-presentation.ts", import.meta.url)),
		toolOutputBudget: fileURLToPath(new URL("../../packages/coding-agent/src/core/tool-output-budget.ts", import.meta.url)),
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
	const toolResultPresentation = requireSourceFile(program, sourcePaths.toolResultPresentation);
	const toolOutputBudget = requireSourceFile(program, sourcePaths.toolOutputBudget);
	const renderUtils = requireSourceFile(program, sourcePaths.renderUtils);
	const tuiContainer = requireSourceFile(program, sourcePaths.tuiContainer);
	const tuiBox = requireSourceFile(program, sourcePaths.tuiBox);
	const tuiText = requireSourceFile(program, sourcePaths.tuiText);
	const tuiSpacer = requireSourceFile(program, sourcePaths.tuiSpacer);
	const tuiUtils = requireSourceFile(program, sourcePaths.tuiUtils);
	const discoveryRegistrationNodes = selectClassMembers(interactive, "InteractiveMode", [
		"createToolResultDiscoveryRegistration",
	]);
	const discoveryRebuildCallerNodes = selectClassMembers(interactive, "InteractiveMode", ["renderSessionItems"]);
	const discoveryCoreOwnershipNodes = [
		...selectClassMembers(toolComponent, "ReadToolGroupComponent", ["setToolResultPresentation", "clearToolResultPresentation", "detachToolResultPresentation"]),
		...selectClassMembers(toolComponent, "ToolExecutionComponent", ["setToolResultPresentation", "clearToolResultPresentation", "detachToolResultPresentation"]),
		...selectClassMembers(interactive, "InteractiveMode", [
			"updateToolResultDiscoveryHighWaterMarks",
			"evictOldestAttachedToolResultDiscovery",
			"createToolResultDiscoveryRegistration",
			"addPendingToolResultDiscovery",
			"releasePendingToolResultDiscovery",
			"removePendingToolResultDiscoveryForAmbiguity",
			"removeAttachedToolResultDiscoveryForAmbiguity",
			"addAttachedToolResultDiscovery",
			"trackToolResultPresentationTarget",
			"attachToolResultPresentation",
			"attachLiveToolResultPresentation",
			"clearPendingToolResultDiscoveries",
			"clearAttachedToolResultDiscoveries",
			"clearToolResultDiscoveriesAfterCanonicalHistoryReplacement",
			"clearToolResultDiscoveries",
			"getToolResultDiscoveryLifecycleCounts",
		]),
		...selectClassMembers(agentSession, "AgentSession", [
			"toolResultPresentationEnabled",
			"_recordToolResultUiCanonicalMessage",
			"_rebuildToolResultUiCanonicalIndex",
			"_synchronizeToolResultUiCanonicalIndex",
			"getToolResultPresentationSourceStatusForUi",
			"isCurrentToolResultPresentationSourceForUi",
			"getToolResultPresentationForUi",
			"collectRecentToolResultPresentationsForUi",
			"getToolResultPresentationUiRebuildCounts",
			"readToolResultContinuation",
			"readToolResultArtifact",
		]),
	];
	const discoveryOwnershipNodes = [...discoveryCoreOwnershipNodes, ...discoveryRebuildCallerNodes];
	const pendingRegistryCounts = countAst(
		selectClassMembers(interactive, "InteractiveMode", ["addPendingToolResultDiscovery"]),
		checker,
	);
	const attachedRegistryCounts = countAst(
		selectClassMembers(interactive, "InteractiveMode", ["addAttachedToolResultDiscovery"]),
		checker,
	);
	const promotionCounts = countAst(
		selectClassMembers(interactive, "InteractiveMode", [
			"evictOldestAttachedToolResultDiscovery",
			"releasePendingToolResultDiscovery",
			"addAttachedToolResultDiscovery",
			"attachToolResultPresentation",
			"attachLiveToolResultPresentation",
		]),
		checker,
	);
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
			"detachToolResultPresentation",
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
			"detachToolResultPresentation",
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
		[...toolResultRenderingNodes, ...tuiResultRenderingNodes, ...discoveryCoreOwnershipNodes],
		checker,
	);
	const argumentCounts = countAst(
		selectClassMembers(toolComponent, "ToolExecutionComponent", ["serializeArgs"]),
		checker,
	);
	const ownershipCounts = countAst(discoveryOwnershipNodes, checker);
	const rebuildCallerCounts = countAst(discoveryRebuildCallerNodes, checker);
	const registrationCounts = countAst(discoveryRegistrationNodes, checker);
	const exactResidentTouchCounts = countAst(
		selectClassMembers(toolResultPresentation, "ToolResultPresentationOwner", [
			"touchExactResidentProjectionRecord",
		]),
		checker,
	);
	const candidateInspectionCounts = countAst(
		[
			...selectClassMembers(toolResultPresentation, "ToolResultPresentationOwner", [
				"inspectToolResultPresentationForUiCandidate",
			]),
			// The UI call supplies no exact estimator. Include the complete fallback
			// scan chain plus estimateToolOutputTokens itself; the latter deliberately
			// makes this a conservative envelope that also exposes allocations in its
			// dormant exact-estimator branch.
			...selectNamedDeclarations(toolOutputBudget, [
				"estimateToolOutputTokens",
				"createScanState",
				"scanText",
				"addAsciiRunTokens",
				"beginOrExtendAsciiRun",
				"isAsciiHex",
				"printableAsciiSymbolBit",
				"isCjk",
				"isCombiningOrJoiner",
			]),
		],
		checker,
	);
	const interactiveSource = readFileSync(sourcePaths.interactive, "utf8");
	const agentSessionSource = readFileSync(sourcePaths.agentSession, "utf8");
	const registryHardCap = Number(interactiveSource.match(/MAX_TOOL_RESULT_DISCOVERIES\s*=\s*(\d+)/u)?.[1] ?? 0);
	const rebuildCandidateHardCap = Number(
		agentSessionSource.match(/MAX_TOOL_RESULT_UI_REBUILD_CANDIDATES\s*=\s*(\d+)/u)?.[1] ?? 0,
	);
	const canonicalIndexHardCap = Number(
		agentSessionSource.match(/MAX_TOOL_RESULT_UI_CANONICAL_INDEX_ENTRIES\s*=\s*(\d[\d_]*)/u)?.[1]?.replaceAll("_", "") ?? 0,
	);
	return {
		registryHardCap,
		rebuildCandidateHardCap,
		canonicalIndexHardCap,
		transitiveSourceFiles: [
			"tool-execution.ts",
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
		discoveryOwnershipArrayMaterializationSites:
			ownershipCounts.arrayLiterals +
			ownershipCounts.arraySpreads +
			ownershipCounts.arrayProducingCalls +
			ownershipCounts.arrayConstructors,
		discoveryOwnershipInlineClosureSites: ownershipCounts.inlineClosures,
		discoveryRegistrationObjectLiterals: registrationCounts.objectLiterals,
		discoveryOwnershipObjectLiterals: ownershipCounts.objectLiterals,
		discoveryOwnershipMapConstructors: ownershipCounts.mapConstructors,
		discoveryOwnershipSetConstructors: ownershipCounts.setConstructors,
		pendingRegistryMapConstructors: pendingRegistryCounts.mapConstructors,
		attachedRegistryMapConstructors: attachedRegistryCounts.mapConstructors,
		promotionArrayMaterializationSites:
			promotionCounts.arrayLiterals +
			promotionCounts.arraySpreads +
			promotionCounts.arrayProducingCalls +
			promotionCounts.arrayConstructors,
		promotionInlineClosureSites: promotionCounts.inlineClosures,
		promotionCopyOperations: promotionCounts.copyOperations,
		promotionSerializations: promotionCounts.serializations,
		promotionObjectLiterals: promotionCounts.objectLiterals,
		promotionMapConstructors: promotionCounts.mapConstructors,
		promotionSetConstructors: promotionCounts.setConstructors,
		promotionPromises: promotionCounts.promises,
		promotionAbortControllers: promotionCounts.abortControllers,
		discoveryRebuildCallerArrayMaterializationSites:
			rebuildCallerCounts.arrayLiterals +
			rebuildCallerCounts.arraySpreads +
			rebuildCallerCounts.arrayProducingCalls +
			rebuildCallerCounts.arrayConstructors,
		discoveryRebuildCallerInlineClosureSites: rebuildCallerCounts.inlineClosures,
		discoveryRebuildCallerCopyOperations: rebuildCallerCounts.copyOperations,
		discoveryRebuildCallerSerializations: rebuildCallerCounts.serializations,
		discoveryRebuildCallerObjectLiterals: rebuildCallerCounts.objectLiterals,
		discoveryRebuildCallerMapConstructors: rebuildCallerCounts.mapConstructors,
		discoveryRebuildCallerSetConstructors: rebuildCallerCounts.setConstructors,
		discoveryRebuildCallerPromises: rebuildCallerCounts.promises,
		discoveryRebuildCallerAbortControllers: rebuildCallerCounts.abortControllers,
		exactResidentTouchArrayMaterializationSites:
			exactResidentTouchCounts.arrayLiterals +
			exactResidentTouchCounts.arraySpreads +
			exactResidentTouchCounts.arrayProducingCalls +
			exactResidentTouchCounts.arrayConstructors,
		exactResidentTouchInlineClosureSites: exactResidentTouchCounts.inlineClosures,
		exactResidentTouchCopyOperations: exactResidentTouchCounts.copyOperations,
		exactResidentTouchSerializations: exactResidentTouchCounts.serializations,
		exactResidentTouchObjectLiterals: exactResidentTouchCounts.objectLiterals,
		exactResidentTouchMapConstructors: exactResidentTouchCounts.mapConstructors,
		exactResidentTouchSetConstructors: exactResidentTouchCounts.setConstructors,
		exactResidentTouchPromises: exactResidentTouchCounts.promises,
		exactResidentTouchAbortControllers: exactResidentTouchCounts.abortControllers,
		candidateInspectionArrayMaterializationSites:
			candidateInspectionCounts.arrayLiterals +
			candidateInspectionCounts.arraySpreads +
			candidateInspectionCounts.arrayProducingCalls +
			candidateInspectionCounts.arrayConstructors,
		candidateInspectionInlineClosureSites: candidateInspectionCounts.inlineClosures,
		candidateInspectionCopyOperations: candidateInspectionCounts.copyOperations,
		candidateInspectionSerializations: candidateInspectionCounts.serializations,
		candidateInspectionObjectLiterals: candidateInspectionCounts.objectLiterals,
		candidateInspectionMapConstructors: candidateInspectionCounts.mapConstructors,
		candidateInspectionSetConstructors: candidateInspectionCounts.setConstructors,
		candidateInspectionPromises: candidateInspectionCounts.promises,
		candidateInspectionAbortControllers: candidateInspectionCounts.abortControllers,
		promises: ownershipCounts.promises,
		abortControllers: ownershipCounts.abortControllers,
	};
}
