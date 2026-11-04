import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { Markdown, type DefaultTextStyle, type MarkdownOptions } from "../packages/tui/src/components/markdown.ts";

initTheme("dark", false);

function growingSource(kind: "table" | "code" | "single-code", size: number): string {
	let source = kind === "table" ? "| Key | Value |\n| --- | --- |\n" : "```ts\n";
	let index = 0;
	while (source.length < size) {
		source += kind === "table"
			? `| field_${index} | **value ${index}** |\n`
			: kind === "code" ? `const value${index} = ${index}; // value\n` : `value${index} + `;
		index++;
	}
	return source;
}

function compareSteps(steps: readonly string[], options: MarkdownOptions = {}, style?: DefaultTextStyle): void {
	const theme = getMarkdownTheme();
	const incremental = new Markdown("", 1, 0, theme, style, { ...options, incrementalRenderCache: true });
	for (let index = 0; index < steps.length; index++) {
		const width = [120, 60, 200, 120][index % 4];
		incremental.setText(steps[index]);
		const full = new Markdown(steps[index], 1, 0, theme, style, { ...options, incrementalRenderCache: false });
		assert.deepEqual(incremental.render(width), full.render(width), `step ${index}, width ${width}`);
		full.invalidate();
	}
	incremental.invalidate();
}

for (const size of [16 * 1024, 64 * 1024, 256 * 1024, 256 * 1024 + 1024]) {
	test(`growing ${size}-character table matches complete rendering through column and reference changes`, () => {
		const source = growingSource("table", size);
		const wider = source + "| longest_column_name_by_far | [reference][target] |\n";
		compareSteps([
			source,
			source + "| 中│e\u0301 | 👩🏽‍💻 and  repeated   spaces |\n",
			wider,
			wider + "\n[target]: https://example.test/target\n",
			wider + "\n[target]: https://example.test/replaced\n",
			"| replaced | small |\n| --- | --- |\n| │ | \x1b[31mred\x1b[0m |",
		]);
	});
	for (const kind of ["code", "single-code"] as const) {
		test(`growing ${size}-character ${kind} matches complete highlighting through partial fences`, () => {
			const source = growingSource(kind, size);
			compareSteps([source, source + "42;\n", source + "42;\n`", source + "42;\n``", source + "42;\n```", "short replacement"]);
		});
	}
}

test("mixed Unicode, nested Markdown, transforms and thinking styles remain full-render equivalent", () => {
	const steps = [
		"- item\n  - │ code `中` and **bold**",
		"- item\n  - │ code `中` and **bold**\n\n[x][ref] $x^2$",
		"- item\n  - │ code `中` and **bold**\n\n[x][ref] $x^2$\n\n[ref]: https://example.test",
		"> quote\n> ```ts\n> /* multiline\n> comment */\n> ```\n\n$$x^2+y^2$$",
		"| \u0600│ | │\u0301 |\n| --- | --- |\n| \x1b]8;;https://example.test\x07link\x1b]8;;\x07 | 😀 |",
	];
	compareSteps(steps);
	compareSteps(steps, { transform: (text, width) => `width ${width}\n\n${text}` });
	compareSteps(steps, {}, { color: text => `\x1b[90m${text}\x1b[39m`, italic: true });
});

test("theme invalidation and very narrow tables preserve full-render output", () => {
	const source = growingSource("table", 16 * 1024);
	const theme = getMarkdownTheme();
	const incremental = new Markdown(source, 1, 0, theme, undefined, { incrementalRenderCache: true });
	try {
		for (const name of ["dark", "light", "dark"]) {
			initTheme(name, false);
			incremental.invalidate();
			for (const width of [4, 8, 120]) {
				const full = new Markdown(source, 1, 0, theme);
				assert.deepEqual(incremental.render(width), full.render(width));
			}
		}
	} finally {
		initTheme("dark", false);
		incremental.invalidate();
	}
});
