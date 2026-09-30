import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import promptUrlWidgetExtension from "../.sp/extensions/prompt-url-widget.ts";
import { renderTextResult } from "../packages/chrome-devtools/src/render.ts";
import { HStack } from "../packages/tui/src/components/h-stack.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { renderLatex } from "../packages/tui/src/latex.ts";
import { menuOptions, menuScenes, syntaxTheme } from "./helpers/menu-allocation-fixture.ts";
import { animationGolden } from "./helpers/animation-allocation-fixture.ts";
import { treeGolden } from "./helpers/tree-allocation-fixture.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { getKittyImagePlacement, registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";

const root = new URL("../", import.meta.url);
const paths: Record<string, readonly string[]> = {
	"packages/tui/src/autocomplete.ts": ["getSuggestions", "getFileSuggestions", "getFuzzyFileSuggestions", "buildFdPathQuery", "toDisplayPath", "escapeRegex", "getAutocompleteSearchText"],
	"packages/tui/src/terminal-image.ts": ["getKittyImagePlacement"],
	"packages/coding-agent/src/core/tools/edit.ts": ["getRenderablePreviewInput", "getEditResultErrorText"],
	"packages/coding-agent/src/extensions/llama/ui.ts": ["filterResults", "getModelId", "render"],
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts": ["renderSessionEntries", "renderInitialMessages"],
	"packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts": ["formatKeyText", "formatKeys", "formatKeyPart"],
	"packages/ai/src/api/openai-responses-shared.ts": ["normalizeIdPart", "buildForeignResponsesItemId", "processResponsesStream", "createSlot", "getSlot", "getOrCreateSlot", "pushToolCallDelta", "finalizeResponse", "backfillReasoningSignatures", "joinReasoningText", "convertToolResultOutput", "convertResponsesTools"],
	"packages/ai/src/api/transform-messages.ts": ["transformMessages", "transformMessage", "transformContentBlock", "insertSyntheticToolResults", "replaceImagesWithPlaceholder"],
	"packages/tui/src/fuzzy.ts": ["fuzzyMatch", "fuzzyFilter", "scoreQuery", "scoreWithSwap", "swappedQueryFor"],
	"packages/tui/src/latex.ts": ["renderLatex", "joinLayouts", "renderLayout", "parseEnvironment", "renderMatrix", "renderEnvironmentRows"],
	"packages/tui/src/components/h-stack.ts": ["render"],
	"packages/tui/src/components/v-stack.ts": ["render"],
	"packages/tui/src/components/scroll-view.ts": ["render", "markScrollbarActivity"],
	"packages/tui/src/components/stack.ts": ["visibleStackEntries", "removeChild"],
	"packages/tui/src/components/settings-list.ts": ["renderMainList", "applyFilter", "getSettingLabel"],
	"packages/tui/src/components/markdown.ts": ["renderToken", "renderInlineTokens", "renderList", "renderTable"],
	"packages/tui/src/layout.ts": ["getScrollViewBox", "findScrollViewBox", "getScrollViewsAt", "collectScrollViews"],
	"packages/tui/src/tui-alt-screen.ts": ["prepareKittyScreen"],
	"packages/chrome-devtools/src/render.ts": ["render", "truncateLine", "textContent"],
	"packages/coding-agent/src/modes/interactive/components/footer.ts": ["render", "getExtensionStatusLine"],
	"packages/coding-agent/src/modes/interactive/components/armin.ts": ["render", "tickGlitch", "tickRain", "tickCrt", "clearGrid", "createEmptyGrid"],
	"packages/coding-agent/src/modes/interactive/components/daxnuts.ts": ["render", "centerColoredLine"],
	"packages/coding-agent/src/modes/interactive/components/model-selector.ts": ["filterModels", "setScope", "getSelectorItemSearchText"],
	"packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts": ["refresh", "buildItems", "getFooterText", "getItemSearchText", "getItemIds", "getSortedIds", "clearAll", "enableAll", "move", "handleInput"],
	"packages/coding-agent/src/modes/interactive/components/tree-selector.ts": ["render", "renderHorizontalViewport", "getEntryDisplayText", "formatToolCall", "shortenPath", "recalculateVisualStructure", "findVisibleAncestor", "getGutter", "normalizeEntryText", "applyFilter", "passesFilter", "formatHelpKeys", "compactRawKeys", "handleInput"],
	"packages/tui-kit/src/components/rendering.ts": ["menuHint", "renderFrame", "appendMutedLines", "truncateOwnedLines", "bindingText", "safeMenuText", "replaceTerminalControls"],
	"packages/tui-kit/src/components/index.ts": ["render", "renderSettingsRows"],
	"packages/tui-kit/src/components/browse.ts": ["render", "listRows", "detailLines", "browseDetailSource", "browseHint", "detailHint", "renderSearchInput", "boundedLines", "searchableItemText", "bindingText"],
	"packages/tui-kit/src/components/multi-select.ts": ["render"],
	"packages/tui-kit/src/components/review.ts": ["compactReviewHint", "renderAdaptiveReviewFrame", "reviewSegments", "hardWrapLine", "sanitizeDocumentText", "formatReviewLines", "plainReviewLines", "reviewBindingText"],
	"packages/tui-kit/src/components/syntax-highlighting.ts": ["highlightCode", "renderHighlightedHtml", "styleSyntaxText", "scopeFromTag", "decodeEntity"],
	".sp/extensions/prompt-url-widget.ts": ["render", "setWidget", "updatePromptContext", "getUserText"],
};

const ARRAY_CALLBACK_METHODS = new Set(["map", "filter", "flatMap", "reduce", "reduceRight", "find", "findLast", "findIndex", "findLastIndex", "some", "every", "forEach"]);

function inspectAllocationBody(node: ts.Node, tree: ts.SourceFile, failures: string[]): void {
	if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) failures.push(`callback: ${node.getText(tree).slice(0, 45)}`);
	if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) failures.push(`regex: ${node.getText(tree)}`);
	if (ts.isNewExpression(node) && /^(RegExp|String)$/.test(node.expression.getText(tree))) failures.push(node.getText(tree));
	if (ts.isCallExpression(node)) {
		const callee = node.expression;
		if (ts.isIdentifier(callee) && callee.text === "RegExp") failures.push(`regex call: ${node.getText(tree)}`);
		const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
			: ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
		if (method !== undefined && ARRAY_CALLBACK_METHODS.has(method)) failures.push(`array callback call: ${node.getText(tree).slice(0, 60)}`);
	}
	ts.forEachChild(node, child => inspectAllocationBody(child, tree, failures));
}

test("production allocation cleanup checks named bodies for inline functions, regex construction and array callback calls", () => {
	for (const [path, names] of Object.entries(paths)) {
		const source = readFileSync(new URL(path, root), "utf8");
		const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
		const found = new Set<string>();
		const failures: string[] = [];
		function visit(node: ts.Node): void {
			if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body && names.includes(node.name.getText(tree))) {
				found.add(node.name.getText(tree));
				inspectAllocationBody(node.body, tree, failures);
			}
			ts.forEachChild(node, visit);
		}
		visit(tree);
		assert.deepEqual(failures, [], path);
		for (const name of names) assert.ok(found.has(name), `${path}: gate must actually inspect ${name}`);
	}
});

test("allocation source gate detects module-callback arrays and callable RegExp without blanket banning String conversion or stable sort", () => {
	for (const source of ["items.map(moduleHelper);", "items['filter'](moduleHelper);", "RegExp(pattern);", "new RegExp(pattern);", "new String(value);", "const callback = () => value;", "const pattern = /x/;"]) {
		const tree = ts.createSourceFile("gate-fixture.ts", `{ ${source} }`, ts.ScriptTarget.Latest, true);
		const failures: string[] = [];
		inspectAllocationBody(tree.statements[0]!, tree, failures);
		assert.ok(failures.length > 0, source);
	}
	const accepted = ts.createSourceFile("gate-fixture.ts", "{ String(externalValue); items.sort(stableComparator); }", ts.ScriptTarget.Latest, true);
	const failures: string[] = [];
	inspectAllocationBody(accepted.statements[0]!, accepted, failures);
	assert.deepEqual(failures, []);
});

test("LaTeX matrices, alignment, cases, fractions and malformed inputs retain the pre-cleanup golden", () => {
	const golden = JSON.parse(readFileSync(new URL("fixtures/hot-latex-golden.json", import.meta.url), "utf8"));
	assert.equal(golden.baseline, "6ebe643f1dcf6eded74da3b59bb3f177a720dbee");
	for (const row of golden.values) assert.equal(renderLatex(row.source, { display: row.display }) ?? null, row.expected, `${row.source} display=${row.display}`);
});

test("menu navigation/search/layout and syntax colors retain the pre-cleanup production golden", async () => {
	const jiti = createJiti(import.meta.url);
	const { createMenuScreenComponent } = await jiti.import<any>("../packages/tui-kit/src/components/index.ts");
	const { highlightCode } = await jiti.import<any>("../packages/tui-kit/src/components/syntax-highlighting.ts");
	const golden = JSON.parse(readFileSync(new URL("fixtures/hot-menu-golden.json", import.meta.url), "utf8"));
	assert.equal(golden.baseline, "6ebe643f1dcf6eded74da3b59bb3f177a720dbee");
	for (const row of golden.values) {
		const component = createMenuScreenComponent(menuOptions(menuScenes[row.scene], row.rows));
		try {
			assert.deepEqual(component.render(row.width), row.initial, `initial scene ${row.scene}`);
			component.handleInput("down");
			assert.deepEqual(component.render(row.width), row.down, `navigation scene ${row.scene}`);
			if (["browse", "settings", "multiSelect"].includes(menuScenes[row.scene].kind)) component.handleInput("a");
			assert.deepEqual(component.render(row.width), row.searched, `search scene ${row.scene}`);
		} finally { component.dispose(); }
	}
	for (const row of golden.syntax) assert.equal(highlightCode(row.code, row.language, syntaxTheme), row.expected);
});

test("stack and scroll outputs do not mutate a child's cached lines, including failures and reentrant render", () => {
	const cached = Object.freeze(["one", "two"]);
	const child = { render: () => cached as unknown as string[], invalidate() {} };
	const vertical = new VStack([child, { component: child, visible: () => false }]);
	assert.deepEqual(vertical.render(8), ["one", "two"]);
	const horizontal = new HStack([child, child], { gap: 1 });
	assert.equal(horizontal.render(15).length, 2);
	const scroll = new ScrollView(child);
	assert.deepEqual(scroll.render(8), ["one", "two"]);
	assert.deepEqual(cached, ["one", "two"]);
	const failure = new HStack([{ render() { throw new Error("child failed"); }, invalidate() {} }]);
	assert.throws(() => failure.render(8), /child failed/);
	assert.deepEqual(vertical.render(8), ["one", "two"]);
	const reentrant = new HStack([{ render() { vertical.render(7); return ["r"]; }, invalidate() {} }]);
	assert.equal(reentrant.render(8).length, 1);
	scroll[RELEASE_COMPONENT_RENDER_CACHE]();
	assert.equal((scroll as any).requestRenderCallback, undefined);
	assert.equal((scroll as any).scrollbarHideTimer, undefined);
});

test("real HStack and VStack visibility traversals retain the initial boundary under container mutation", () => {
	for (const Constructor of [HStack, VStack]) {
		for (const action of ["append", "remove", "clear", "reenter"] as const) {
			const visits: string[] = [];
			const a = { render: () => ["AAA"], invalidate() {} };
			const b = { render: () => ["BBB"], invalidate() {} };
			const c = { render: () => ["CCC"], invalidate() {} };
			const stack = new Constructor();
			let changed = false;
			stack.addChild(a, { visible() {
				visits.push("A");
				if (!changed) {
					changed = true;
					if (action === "append" || action === "reenter") stack.addChild(b, { visible() { visits.push("B"); return true; } });
					else if (action === "remove") stack.removeChild(b);
					else stack.clear();
					if (action === "reenter") assert.match(stripVTControlCharacters(stack.render(30).join("\n")), /BBB/);
				}
				return true;
			} });
			if (action === "remove" || action === "clear") {
				stack.addChild(b, { visible() { visits.push("B"); return true; } });
				stack.addChild(c, { visible() { visits.push("C"); return true; } });
			}
			const first = stripVTControlCharacters(stack.render(30).join("\n"));
			assert.match(first, /AAA/);
			assert.doesNotMatch(first, /BBB/, `${Constructor.name}: ${action}`);
			assert.equal(first.includes("CCC"), action === "remove");
			assert.deepEqual(visits, action === "remove" ? ["A", "C"] : action === "reenter" ? ["A", "A", "B"] : ["A"]);
			const next = stripVTControlCharacters(stack.render(30).join("\n"));
			assert.equal(next.includes("BBB"), action === "append" || action === "reenter");
			if (action === "clear") assert.equal(next, "");
		}
	}
});

test("animation ticks retain all seven effects and release the animation owner", async () => {
	const jiti = createJiti(import.meta.url);
	const { ArminComponent } = await jiti.import<any>("../packages/coding-agent/src/modes/interactive/components/armin.ts");
	const { initTheme } = await jiti.import<any>("../packages/coding-agent/src/modes/interactive/theme/theme.ts");
	initTheme("dark");
	const golden = JSON.parse(readFileSync(new URL("fixtures/hot-animation-golden.json", import.meta.url), "utf8"));
	assert.deepEqual(animationGolden(ArminComponent), golden.values);
});

test("key hint scanning preserves empty parts, modifiers and separators", async () => {
	const jiti = createJiti(import.meta.url);
	const { formatKeyText } = await jiti.import<any>("../packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts");
	for (const input of ["", "/", "++//", "alt+x/ctrl+pageUp", "shift+", "+enter", "ALT+😀"]) {
		for (const capitalize of [false, true]) {
			const expected = input.split("/").map(key => key.split("+").map(part => {
				const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
				return capitalize ? display.charAt(0).toUpperCase() + display.slice(1) : display;
			}).join("+")).join("/");
			assert.equal(formatKeyText(input, { capitalize }), expected);
		}
	}
});

test("session tree filters, hidden ancestors, branching gutters and horizontal view retain the baseline golden", async () => {
	const jiti = createJiti(import.meta.url);
	const { TreeSelectorComponent } = await jiti.import<any>("../packages/coding-agent/src/modes/interactive/components/tree-selector.ts");
	const { initTheme } = await jiti.import<any>("../packages/coding-agent/src/modes/interactive/theme/theme.ts");
	initTheme("dark");
	const golden = JSON.parse(readFileSync(new URL("fixtures/hot-tree-golden.json", import.meta.url), "utf8"));
	assert.deepEqual(treeGolden(TreeSelectorComponent), golden.values);
});

test("Kitty cache reuses its bounded owner entries, retransmits changed generations and releases on disposal", async (t) => {
	const tui = new TuiAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
	const raw = tui as any;
	const lines: string[] = [];
	const metadata = { imageId: 780001, columns: 1, rows: 1, widthPx: 1, heightPx: 1 };
	const first = `\x1b_Ga=T,i=${metadata.imageId},f=100,q=2,c=1,r=1;AAAA\x1b\\`;
	try {
		registerKittyImageMetadata(metadata);
		raw.prepareKittyScreen([first], lines);
		assert.deepEqual(lines, [first]);
		const entry = raw.uploadedKittyImages.get(metadata.imageId);
		let entryIterators = 0;
		const cache: Map<number, unknown> = raw.uploadedKittyImages;
		const iterateEntries = cache[Symbol.iterator];
		t.mock.method(cache, Symbol.iterator, function (this: Map<number, unknown>) {
			entryIterators++;
			return iterateEntries.call(this);
		});
		lines.length = 0;
		raw.prepareKittyScreen([first], lines);
		assert.equal(entryIterators, 0, "warm bounded cache scans values without allocating entry tuples");
		assert.equal(raw.uploadedKittyImages.get(metadata.imageId), entry);
		assert.deepEqual(lines, [getKittyImagePlacement(first)!.replacementLine]);
		registerKittyImageMetadata(metadata);
		lines.length = 0;
		raw.prepareKittyScreen([first], lines);
		assert.equal(raw.uploadedKittyImages.get(metadata.imageId), entry);
		assert.deepEqual(lines, [first]);
		for (let index = 1; index <= 18; index++) {
			registerKittyImageMetadata({ ...metadata, imageId: metadata.imageId + index });
			raw.prepareKittyScreen([first.replace(String(metadata.imageId), String(metadata.imageId + index))], []);
		}
		assert.equal(raw.uploadedKittyImages.size, 17, "one visible and at most sixteen offscreen images");
		const deletion = raw.prepareKittyScreen([], []);
		assert.ok(deletion.includes("a=d"));
		assert.equal(raw.uploadedKittyImages.size, 16);
	} finally { await tui.dispose({ preserveScreen: true }); }
	assert.equal(raw.uploadedKittyImages.size, 0);
	assert.equal(tui.getAltFinalUnmountRetainedReferenceCounts().layoutRenderOwnerReferences, 0);
});

test("Chrome result rendering preserves empty text separators, CRLF, tabs and Unicode code-point truncation", () => {
	const component = renderTextResult({ content: [{ type: "text", text: "" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "😀a\tb\r\nx" }], details: undefined }, { expanded: true, isPartial: false }, { bold: text => text, fg: (_color, text) => text });
	assert.deepEqual(component.render(3), ["", "😀a ", "x"]);
	assert.deepEqual(component.render(1), ["", "😀", "x"]);
});

test("actual edit result renderer preserves empty text block separators and ignores images", async () => {
	const jiti = createJiti(import.meta.url);
	const { createEditToolDefinition } = await jiti.import<any>("../packages/coding-agent/src/core/tools/edit.ts");
	const definition = createEditToolDefinition(process.cwd());
	const component = definition.renderResult(
		{ content: [{ type: "text", text: "" }, { type: "image", data: "ignored" }, { type: "text", text: "error" }, { type: "text", text: "" }], details: undefined },
		{ expanded: true, isPartial: false },
		{ fg: (_color: string, text: string) => text },
		{ args: {}, state: {}, isError: true, expanded: true },
	);
	assert.deepEqual(component.render(40), ["", " ".repeat(40), " error".padEnd(40), " ".repeat(40)]);
});

function widgetFixture() {
	const handlers = new Map<string, Function>();
	const factories: Function[] = [];
	const rendered: string[] = [];
	const requests: Array<{ target: string; resolve: (result: any) => void }> = [];
	let sessionName: string | undefined;
	let entries: any[] = [];
	let clears = 0;
	const pi: any = {
		on(name: string, handler: Function) { handlers.set(name, handler); },
		getSessionName: () => sessionName,
		setSessionName(name: string) { sessionName = name; },
		exec(_command: string, args: string[]) { return new Promise(resolve => requests.push({ target: args[2]!, resolve })); },
	};
	const ctx: any = {
		hasUI: true, cwd: process.cwd(), sessionManager: { getEntries: () => entries },
		ui: { setWidget(_name: string, factory: Function | undefined) {
			if (!factory) { clears++; return; }
			factories.push(factory);
			const component = factory(undefined, { fg: (_color: string, text: string) => text });
			rendered.push(stripVTControlCharacters(component.render(160).join("\n")));
		} },
	};
	promptUrlWidgetExtension(pi);
	return { handlers, factories, rendered, requests, ctx, name: () => sessionName, setName: (value: string) => { sessionName = value; }, setEntries: (value: any[]) => { entries = value; }, clears: () => clears };
}

test("URL widget factory has one owner, rejects stale metadata across prompt/session boundaries and preserves user session names", async () => {
	const first = widgetFixture();
	const second = widgetFixture();
	first.handlers.get("before_agent_start")!({ prompt: "You are given one or more GitHub PR URLs: https://github.com/o/r/pull/1" }, first.ctx);
	first.setName("my session");
	first.handlers.get("before_agent_start")!({ prompt: "Analyze GitHub issue(s): https://github.com/o/r/issues/2" }, first.ctx);
	assert.equal(first.factories[0], first.factories[1]);
	first.requests[1]!.resolve({ code: 0, stdout: JSON.stringify({ title: "New issue", author: { name: " Name ", login: "author" } }) });
	await nextTurn();
	assert.match(first.rendered.at(-1)!, /New issue\s*\n\s*Name \(@author\)/);
	assert.equal(first.factories[0], first.factories[2]);
	first.requests[0]!.resolve({ code: 0, stdout: JSON.stringify({ title: "Stale PR" }) });
	await nextTurn();
	assert.equal(first.rendered.length, 3);
	assert.equal(first.name(), "my session");
	second.handlers.get("before_agent_start")!({ prompt: "Analyze GitHub issue(s): https://github.com/o/r/issues/3" }, second.ctx);
	assert.notEqual(second.factories[0], first.factories[0]);
	second.handlers.get("session_shutdown")!();
	second.requests[0]!.resolve({ code: 0, stdout: JSON.stringify({ title: "After shutdown" }) });
	await nextTurn();
	assert.equal(second.rendered.length, 1);
	first.setEntries([{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "Analyze GitHub issue(s): https://github.com/o/r/issues/4" }] } }, { type: "message", message: { role: "user", content: "ordinary prompt" } }]);
	first.handlers.get("session_start")!({ reason: "resume" }, first.ctx);
	assert.match(first.rendered.at(-1)!, /issues\/4/);
	first.setEntries([]);
	first.handlers.get("session_start")!({ reason: "new" }, first.ctx);
	first.requests[2]!.resolve({ code: 0, stdout: JSON.stringify({ title: "Old session" }) });
	await nextTurn();
	assert.equal(first.clears(), 1);
	assert.doesNotMatch(first.rendered.at(-1)!, /Old session/);
});
