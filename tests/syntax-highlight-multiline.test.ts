import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { getMarkdownTheme, highlightCode, initTheme, theme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { renderHighlightedHtml } from "../packages/coding-agent/src/utils/syntax-highlight.ts";
import { Markdown } from "../packages/tui/src/components/markdown.ts";

test("multiline scopes format nonempty lines independently, including decoded newlines", () => {
	const calls: string[] = [];
	const format = (text: string) => { calls.push(text); return `<S>${text}</S>`; };
	assert.equal(renderHighlightedHtml('<span class="hljs-string">\nfirst\n\nsecond&#10;last\n</span>', { string: format }),
		"\n<S>first</S>\n\n<S>second</S>\n<S>last</S>\n");
	assert.deepEqual(calls, ["first", "second", "last"]);
	assert.equal(renderHighlightedHtml('<span class="hljs-string">a\r\nb</span>', { string: format }), "<S>a\r</S>\n<S>b</S>");
	assert.equal(renderHighlightedHtml("plain\n\n&amp;\n"), "plain\n\n&\n");
});

test("nested scopes restore their parent across lines and preserve scope fallback", () => {
	const styles = { string: (text: string) => `<S>${text}</S>`, subst: (text: string) => `<T>${text}</T>` };
	assert.equal(renderHighlightedHtml('<span class="hljs-string">a\n<span class="hljs-subst">x\n\ny</span>\nz<span class="hljs-unknown">\nw</span></span>', styles),
		"<S>a</S>\n<T>x</T>\n\n<T>y</T>\n<S>z</S>\n<S>w</S>");
	for (const scope of ["string.special", "string-extra"]) {
		assert.equal(renderHighlightedHtml(`<span class="hljs-${scope}">a\nb</span>`, styles), "<S>a</S>\n<S>b</S>");
	}
});

test("Python docstrings and JavaScript comments preserve colors through both theme entry points and Markdown", () => {
	initTheme("dark");
	for (const [lang, code, color] of [
		["python", '"""\nline one\n\nline two\n"""\nafter', "syntaxString"],
		["javascript", "/*\nline one\n\nline two\n*/\nafter", "syntaxComment"],
	] as const) {
		const plain = code.split("\n");
		const expected = plain.map((line, index) => line && index < plain.length - 1 ? theme.fg(color, line) : line);
		assert.deepEqual(highlightCode(code, lang), expected);
		const markdownTheme = getMarkdownTheme();
		assert.deepEqual(markdownTheme.highlightCode!(code, lang), expected);
		const component = new Markdown(`\`\`\`${lang}\n${code}\n\`\`\``, 0, 0, markdownTheme);
		const rendered = component.render(80);
		assert.ok(rendered.some(line => line.includes(theme.fg(color, "line two"))), "later Markdown row must reopen its color after terminal reset");
		assert.equal(component.render(80), rendered, "unchanged Markdown keeps its render cache");
		component.invalidate();
	}
});

test("multiline template interpolation uses text color and then restores the surrounding string", () => {
	initTheme("dark");
	const code = "`first\n${name}\nlast`";
	const expected = [theme.fg("syntaxString", "`first"), theme.fg("text", "${name}"), theme.fg("syntaxString", "last`")];
	assert.deepEqual(highlightCode(code, "javascript"), expected);
	assert.deepEqual(getMarkdownTheme().highlightCode!(code, "javascript"), expected);
});

test("formatter reentry and exceptions cannot corrupt another render", () => {
	const inner = { string: (text: string) => `<I>${text}</I>` };
	assert.equal(renderHighlightedHtml('<span class="hljs-string">a\nb</span>', {
		string: text => `${text}:${renderHighlightedHtml('<span class="hljs-string">x\ny</span>', inner)}`,
	}), "a:<I>x</I>\n<I>y</I>\nb:<I>x</I>\n<I>y</I>");
	const failure = new Error("formatter failure");
	assert.throws(() => renderHighlightedHtml('<span class="hljs-string">a\nb</span>', {
		string: text => { if (text === "b") throw failure; return text; },
	}), error => error === failure);
	assert.equal(renderHighlightedHtml("plain"), "plain");
	assert.equal(renderHighlightedHtml('<span class="hljs-string">after</span>', inner), "<I>after</I>");
});

test("HTML rendering keeps line scanning call-owned with no pool, closures or line arrays", () => {
	const path = "packages/coding-agent/src/utils/syntax-highlight.ts";
	const text = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	assert.doesNotMatch(text, /ObjectPool|HIGHLIGHT_RENDER_STATE_POOL/);
	for (const name of ["renderHighlightedHtml", "formatHighlightedText", "getActiveFormatter", "getScopeFormatter", "getScopeFromSpanTag", "isSpanOpenTagStart"]) {
		const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
		assert.ok(fn, name);
		let arrays = 0;
		function inspect(node: ts.Node): void {
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node) && !ts.isObjectLiteralExpression(node));
			if (ts.isArrayLiteralExpression(node)) arrays++;
			if (ts.isCallExpression(node)) assert.doesNotMatch(node.expression.getText(source), /\.(?:split|map|filter|join|then|catch|finally|bind)$/);
			ts.forEachChild(node, inspect);
		}
		inspect(fn);
		assert.equal(arrays, name === "renderHighlightedHtml" ? 1 : 0, "only one call-owned scope stack");
	}
});
