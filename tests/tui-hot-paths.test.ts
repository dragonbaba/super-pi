import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Editor } from "../packages/tui/src/components/editor.ts";
import { Markdown, type MarkdownTheme } from "../packages/tui/src/components/markdown.ts";
import { fuzzyMatch } from "../packages/tui/src/fuzzy.ts";
import { parseKey } from "../packages/tui/src/keys.ts";
import { renderLatex } from "../packages/tui/src/latex.ts";
import { parseKeyboardProtocolNegotiationSequence } from "../packages/tui/src/terminal.ts";
import { cropKittyImageLine, registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";
import { allocateStackSizes } from "../packages/tui/src/components/stack.ts";
import { isPunctuationChar, isWhitespaceChar } from "../packages/tui/src/utils.ts";
import { findWordBackward, findWordForward } from "../packages/tui/src/word-navigation.ts";

const EMPTY_COMPONENT = { render: (): string[] => [], invalidate: (): void => {} };

const HOT_REGEX_FREE_FILES = [
	"packages/tui/src/components/editor.ts",
	"packages/tui/src/components/input.ts",
	"packages/tui/src/components/markdown.ts",
	"packages/tui/src/components/text.ts",
	"packages/tui/src/fuzzy.ts",
	"packages/tui/src/keys.ts",
	"packages/tui/src/latex.ts",
	"packages/tui/src/stdin-buffer.ts",
	"packages/tui/src/terminal.ts",
	"packages/tui/src/terminal-image.ts",
	"packages/tui/src/tui-alt-screen.ts",
	"packages/tui/src/utils.ts",
	"packages/tui/src/word-navigation.ts",
	"packages/ai/src/api/pi-messages.ts",
	"packages/ai/src/api/openrouter-images.ts",
	"packages/ai/src/utils/json-parse.ts",
	"packages/coding-agent/src/core/bash-executor.ts",
	"packages/coding-agent/src/core/tools/find.ts",
	"packages/coding-agent/src/core/tools/grep.ts",
	"packages/coding-agent/src/core/tools/render-utils.ts",
	"packages/coding-agent/src/modes/interactive/components/diff.ts",
	"packages/coding-agent/src/modes/interactive/components/session-selector.ts",
	"packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
	"packages/coding-agent/src/modes/interactive/components/user-message-selector.ts",
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
	"packages/tui-kit/src/components/syntax-highlighting.ts",
];

const identityStyle = (text: string): string => text;
const PLAIN_MARKDOWN_THEME: MarkdownTheme = {
	heading: identityStyle,
	link: identityStyle,
	linkUrl: identityStyle,
	code: identityStyle,
	codeBlock: identityStyle,
	codeBlockBorder: identityStyle,
	quote: identityStyle,
	quoteBorder: identityStyle,
	hr: identityStyle,
	listBullet: identityStyle,
	bold: identityStyle,
	italic: identityStyle,
	strikethrough: identityStyle,
	underline: identityStyle,
};

test("whitespace and punctuation classification preserve expected character semantics", () => {
	const whitespace = [
		"\t",
		"\n",
		"\v",
		"\f",
		"\r",
		" ",
		"\u00a0",
		"\u1680",
		"\u2007",
		"\u2028",
		"\u2029",
		"\u202f",
		"\u205f",
		"\u3000",
		"\ufeff",
	];
	for (const character of whitespace) assert.equal(isWhitespaceChar(character), true, JSON.stringify(character));
	assert.equal(isWhitespaceChar("alpha"), false);
	assert.equal(isWhitespaceChar("alpha beta"), true);
	assert.equal(isPunctuationChar("."), true);
	assert.equal(isPunctuationChar("字"), false);
});

test("word navigation finds ASCII punctuation without allocating match arrays", () => {
	const segment = (text: string): Iterable<Intl.SegmentData> => [
		{ segment: text, index: 0, input: text, isWordLike: true },
	];
	const options = { segment };
	assert.equal(findWordBackward("alpha.beta", 10, options), 6);
	assert.equal(findWordForward("alpha.beta", 0, options), 5);
});

test("fuzzy, LaTeX, and terminal input behavior remains stable", () => {
	assert.deepEqual(fuzzyMatch("fb", "foo_bar"), { matches: true, score: -18.6 });
	assert.equal(renderLatex(String.raw`\frac{a+b}{c}`, { display: true }), "a+b\n───\n c");
	assert.equal(renderLatex(String.raw`\frac{x}{😀}`), "x/😀");
	assert.equal(renderLatex("x\u00a0+\u00a0y"), "x + y");
	assert.equal(parseKey("\u001b[97;5:2u"), "ctrl+a");
	assert.deepEqual(parseKeyboardProtocolNegotiationSequence("\u001b[?7u"), {
		type: "kitty-flags",
		flags: 7,
	});
});

test("editor expands registered paste markers in one pass and preserves unknown markers", () => {
	const editor = new Editor({} as never, { borderColor: (value) => value, selectList: {} as never });
	editor.setText("a [paste #1 11 chars] b [paste #2 +12 lines] c [paste #9 9 chars]");
	const pastes = (editor as unknown as { pastes: Map<number, string> }).pastes;
	pastes.set(1, "first value");
	pastes.set(2, "second value");
	assert.equal(editor.getExpandedText(), "a first value b second value c [paste #9 9 chars]");
});

test("Kitty image cropping replaces prior crop controls without filter arrays", () => {
	registerKittyImageMetadata({ imageId: 71, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const line = "prefix\x1b_Ga=T,i=71,y=2,h=3,r=4;payload\x1b\\suffix";
	assert.equal(
		cropKittyImageLine(line, 1, 2),
		"prefix\x1b_Ga=T,i=71,y=10,h=20,r=2;payload\x1b\\suffix",
	);
});

test("stack allocation preserves weighted grow, bounded grow, and shrink behavior", () => {
	assert.deepEqual(
		allocateStackSizes(
			[
				{ component: EMPTY_COMPONENT, basis: 1, grow: 1 },
				{ component: EMPTY_COMPONENT, basis: 1, grow: 2 },
			],
			[1, 1],
			8,
			0,
		),
		[4, 4],
	);
	assert.deepEqual(
		allocateStackSizes(
			[
				{ component: EMPTY_COMPONENT, basis: 5, shrink: 1, minSize: 2 },
				{ component: EMPTY_COMPONENT, basis: 5, shrink: 1, minSize: 1 },
			],
			[5, 5],
			6,
			0,
		),
		[2, 4],
	);
	assert.deepEqual(
		allocateStackSizes(
			[
				{ component: EMPTY_COMPONENT, basis: 1, grow: 1, maxSize: 2 },
				{ component: EMPTY_COMPONENT, basis: 1, grow: 1 },
			],
			[1, 1],
			7,
			0,
		),
		[2, 5],
	);
});

test("markdown table rendering preserves borders and fixed output width", () => {
	const markdown = new Markdown("| A | B |\n| --- | --- |\n| alpha | beta |", 0, 0, PLAIN_MARKDOWN_THEME);
	assert.deepEqual(markdown.render(20), [
		"┌───────┬──────┐    ",
		"│ A     │ B    │    ",
		"├───────┼──────┤    ",
		"│ alpha │ beta │    ",
		"└───────┴──────┘    ",
	]);
});

test("selected hot runtime modules keep regular-expression literals in dedicated modules", () => {
	const violations: string[] = [];
	for (const file of HOT_REGEX_FREE_FILES) {
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
				const location = source.getLineAndCharacterOfPosition(node.getStart(source));
				violations.push(`${file}:${location.line + 1}:${location.character + 1}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	assert.deepEqual(violations, []);
});
