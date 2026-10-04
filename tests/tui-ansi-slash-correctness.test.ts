import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { CombinedAutocompleteProvider } from "../packages/tui/src/autocomplete.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { highlightTerminalColumns, sliceByColumn, sliceWithWidth, sliceWithWidthInto } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";
const NO_INVERSE = "\x1b[27m";
const OPTIONS = { signal: new AbortController().signal };

for (const fixture of [
	{ name: "reset at ASCII boundary", line: `${RED}A${RESET}B`, start: 1, length: 1, text: `${RED}${RESET}B`, width: 1 },
	{ name: "multiple boundary codes", line: `${RED}\x1b[1mA${RESET}\x1b[32mB`, start: 1, length: 1, text: `${RED}\x1b[1m${RESET}\x1b[32mB`, width: 1 },
	{ name: "wide glyph boundary", line: `${RED}中${RESET}😀`, start: 2, length: 2, text: `${RED}${RESET}😀`, width: 2 },
	{ name: "combining glyph boundary", line: `${RED}e\u0301${RESET}B`, start: 1, length: 1, text: `${RED}${RESET}B`, width: 1 },
	{ name: "OSC hyperlink close", line: "\x1b]8;;https://example.com\x07A\x1b]8;;\x07B", start: 1, length: 1, text: "\x1b]8;;https://example.com\x07\x1b]8;;\x07B", width: 1 },
	{ name: "codes without trailing text", line: `${RED}A${RESET}`, start: 1, length: 1, text: `${RED}${RESET}`, width: 0 },
	{ name: "tab columns", line: `${RED}\t${RESET}B`, start: 3, length: 1, text: `${RED}${RESET}B`, width: 1 },
]) {
	test(`column slicing preserves ANSI order: ${fixture.name}`, () => {
		for (const strict of [false, true]) {
			assert.equal(sliceByColumn(fixture.line, fixture.start, fixture.length, strict), fixture.text);
			const expected = { text: fixture.text, width: fixture.width };
			assert.deepEqual(sliceWithWidth(fixture.line, fixture.start, fixture.length, strict), expected);
			const scratch = { text: "stale", width: 999 };
			sliceWithWidthInto(fixture.line, fixture.start, fixture.length, strict, scratch);
			assert.deepEqual(scratch, expected);
			sliceWithWidthInto("next", 0, 0, strict, scratch);
			assert.deepEqual(scratch, { text: "", width: 0 });
		}
	});
}

test("strict wide-glyph clipping and empty slices retain their column semantics", () => {
	assert.deepEqual(sliceWithWidth("中B", 0, 1, true), { text: "", width: 0 });
	assert.deepEqual(sliceWithWidth("中B", 0, 1, false), { text: "中", width: 2 });
	assert.deepEqual(sliceWithWidth("中B", 1, 2, true), { text: "B", width: 1 });
	assert.equal(sliceByColumn(`${RED}A${RESET}B`, 3, 1), "");
});

test("selection preserves reset order at both the selected and following boundary", () => {
	assert.equal(highlightTerminalColumns(`${RED}A${RESET}BC`, 1, 2, 3),
		`${RED}A${INVERSE}${RED}${INVERSE}${RESET}${INVERSE}B${NO_INVERSE}${RED}${RESET}C`);
	assert.equal(highlightTerminalColumns(`${RED}A${RESET}BC`, 0, 1, 3),
		`${INVERSE}${RED}${INVERSE}A${NO_INVERSE}${RED}${RESET}BC`);
});

test("production Alt selection emits reset after inherited color and releases scratch", async () => {
	const terminal = new FakeTerminal(20, 4);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const lines = [`${RED}A${RESET}BC`];
	tui.addChild({ render: () => lines, invalidate() {} });
	const selection = tui as unknown as {
		selectionAnchor?: { row: number; col: number };
		selectionFocus?: { row: number; col: number; boundary: boolean };
	};
	try {
		tui.start();
		tui.renderNow();
		selection.selectionAnchor = { row: 0, col: 1 };
		selection.selectionFocus = { row: 0, col: 2, boundary: true };
		terminal.writes.length = 0;
		tui.renderNow(true);
		await tui.flushTerminalFrames();
		assert.ok(terminal.writes.join("").includes(`${RED}${INVERSE}${RESET}${INVERSE}B${NO_INVERSE}`), JSON.stringify(terminal.writes));
		assert.deepEqual(tui.getAltCompositionRetainedReferenceCounts(), { overlayLineReferences: 0, selectionPointReferences: 0 });
	} finally {
		await tui.dispose({ preserveScreen: true });
	}
	assert.deepEqual(tui.getAltCompositionRetainedReferenceCounts(), { overlayLineReferences: 0, selectionPointReferences: 0 });
});

for (const whitespace of ["", "  ", "\t", "\u3000\u00a0"]) {
	test(`slash name completion preserves leading whitespace ${JSON.stringify(whitespace)}`, async () => {
		const provider = new CombinedAutocompleteProvider([{ name: "help", description: "Help", argumentHint: "[topic]" }], process.cwd());
		const text = `${whitespace}/he`;
		const lines = ["unchanged", `${text} tail`];
		const result = await provider.getSuggestions(lines, 1, text.length, OPTIONS);
		assert.ok(result);
		assert.equal(result.prefix, "/he");
		assert.deepEqual(result.items, [{ value: "help", label: "help", description: "[topic] — Help" }]);
		assert.deepEqual(provider.applyCompletion(lines, 1, text.length, result.items[0]!, result.prefix), {
			lines: ["unchanged", `${whitespace}/help  tail`], cursorLine: 1, cursorCol: whitespace.length + 6,
		});
		assert.equal(lines[1], `${text} tail`, "input array stays caller-owned");
	});
}

test("indented slash argument completion receives the original arguments and replaces only their prefix", async () => {
	let received: string | undefined;
	const provider = new CombinedAutocompleteProvider([{
		name: "help", getArgumentCompletions(argument) {
			received = argument;
			return [{ value: "topic full", label: "topic full" }];
		},
	}], process.cwd());
	const text = " \t/help  to";
	const result = await provider.getSuggestions([`${text}!`], 0, text.length, OPTIONS);
	assert.ok(result);
	assert.equal(received, " to");
	assert.equal(result.prefix, " to");
	assert.deepEqual(provider.applyCompletion([`${text}!`], 0, text.length, result.items[0]!, result.prefix), {
		lines: [" \t/help topic full!"], cursorLine: 0, cursorCol: 18,
	});
});

test("forced paths, non-command prefixes and unknown arguments do not become slash completions", async () => {
	const provider = new CombinedAutocompleteProvider([{ name: "__super_pi_nonexistent_path__" }], process.cwd());
	for (const text of ["say /__super_pi_nonexistent_path__", "  /__super_pi_nonexistent_path__ "]) {
		assert.equal(await provider.getSuggestions([text], 0, text.length, OPTIONS), null);
	}
	const text = "  /__super_pi_nonexistent_path__";
	assert.equal(await provider.getSuggestions([text], 0, text.length, { ...OPTIONS, force: true }), null);
});

function identity(text: string): string { return text; }
const EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

test("Editor input opens indented slash menu, Tab applies it and disposal releases autocomplete", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(80, 12), false);
	const editor = new Editor(tui, EDITOR_THEME);
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "help" }], process.cwd()));
	tui.addChild(editor);
	try {
		tui.start();
		editor.setText("  /h");
		editor.handleInput("e");
		await nextTurn();
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.handleInput("\t");
		assert.equal(editor.getText(), "  /help ");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
		assert.equal(editor.isShowingAutocomplete(), false);
	} finally {
		await tui.dispose({ preserveScreen: true });
	}
	const raw = editor as unknown as { autocompleteAbort?: AbortController; autocompleteList?: unknown; autocompleteDebounceTimer?: unknown };
	assert.equal(raw.autocompleteAbort, undefined);
	assert.equal(raw.autocompleteList, undefined);
	assert.equal(raw.autocompleteDebounceTimer, undefined);
});
