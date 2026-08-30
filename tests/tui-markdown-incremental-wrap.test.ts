import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
	Markdown,
	type MarkdownIncrementalMetrics,
	type MarkdownOptions,
	type MarkdownTheme,
} from "../packages/tui/src/components/markdown.ts";

const identityStyle = (text: string): string => text;
const PLAIN_THEME: MarkdownTheme = {
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

const ANSI_THEME: MarkdownTheme = {
	...PLAIN_THEME,
	heading: (text: string): string => `\x1b[35m${text}\x1b[39m`,
	bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
	underline: (text: string): string => `\x1b[4m${text}\x1b[24m`,
};

const SYNTAX_TRANSITION_THEME: MarkdownTheme = {
	...PLAIN_THEME,
	link: (text: string): string => `<link>${text}</link>`,
	linkUrl: (text: string): string => `<url>${text}</url>`,
	underline: (text: string): string => `<underline>${text}</underline>`,
	listBullet: (text: string): string => `<bullet>${text}</bullet>`,
	hr: (text: string): string => `<rule>${text}</rule>`,
};

function createMetrics(): MarkdownIncrementalMetrics {
	return {
		incrementalEligibleUpdates: 0,
		incrementalUpdates: 0,
		fullFallbacks: 0,
		sourceCharactersReparsed: 0,
		sourceCharactersRewrapped: 0,
		parserTokensReused: 0,
		parserTokensRebuilt: 0,
		renderedPrefixLinesReused: 0,
		tailLinesRebuilt: 0,
		cachedTokenCount: 0,
		cachedRenderedLines: 0,
		cachedSourceCharacters: 0,
		lastFallbackReason: "none",
	};
}

function assertStreamingGolden(
	steps: readonly string[],
	width: number,
	theme: MarkdownTheme = PLAIN_THEME,
	options: MarkdownOptions = {},
): void {
	const candidate = new Markdown(steps[0] ?? "", 1, 0, theme, undefined, {
		...options,
		incrementalRenderCache: true,
	});
	for (let index = 0; index < steps.length; index++) {
		const source = steps[index]!;
		candidate.setText(source);
		const candidateLines = candidate.render(width);
		const reference = new Markdown(source, 1, 0, theme, undefined, { ...options, incrementalRenderCache: false });
		assert.deepEqual(candidateLines, reference.render(width), `golden mismatch at step ${index}: ${JSON.stringify(source)}`);
	}
}

test("append-only plain Markdown reuses parser and rendered prefix work", () => {
	const metrics = createMetrics();
	const markdown = new Markdown("x", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true }, metrics);
	markdown.render(40);
	let reusedTokens = 0;
	let maximumCharactersRewrapped = 0;
	for (let index = 0; index < 1_000; index++) {
		markdown.setText(`x${"a".repeat(index + 1)}`);
		const rewrappedBefore = metrics.sourceCharactersRewrapped;
		markdown.render(40);
		maximumCharactersRewrapped = Math.max(
			maximumCharactersRewrapped,
			metrics.sourceCharactersRewrapped - rewrappedBefore,
		);
		reusedTokens += markdown.getLastIncrementalReuseCount();
	}
	assert.ok(reusedTokens > 900, `expected parser/token reuse for append-only updates, got ${reusedTokens}`);
	assert.equal(metrics.incrementalUpdates, 1_000);
	assert.equal(metrics.fullFallbacks, 1);
	assert.equal(metrics.parserTokensReused, 1_000);
	assert.equal(metrics.parserTokensRebuilt, 1);
	assert.equal(metrics.sourceCharactersReparsed, 1_001);
	assert.ok(metrics.sourceCharactersRewrapped < 42_000);
	assert.ok(maximumCharactersRewrapped <= 41);
	assert.ok(metrics.renderedPrefixLinesReused > 10_000);
	assert.ok(metrics.tailLinesRebuilt < 3_000);
	assert.equal(metrics.cachedTokenCount, 1);
	assert.equal(metrics.cachedSourceCharacters, 1_001);
	assert.equal(metrics.lastFallbackReason, "none");
});

test("incremental plain and heading checkpoints stay golden across words and Unicode graphemes", () => {
	assertStreamingGolden([
		"English",
		"English paragraph",
		"English paragraph grows",
		"English paragraph grows one",
		"English paragraph grows one word",
	], 18);
	assertStreamingGolden(["x", "x".repeat(39), "x".repeat(40), "x".repeat(41), "x".repeat(200)], 42);
	assertStreamingGolden(["中", "中文", "中文字符", "中文字符继续增长直到换行"], 12);
	assertStreamingGolden(["🙂", "🙂 family", "🙂 family 👨", "🙂 family 👨‍👩", "🙂 family 👨‍👩‍👧‍👦"], 12);
	assertStreamingGolden(["e", "e\u0301", "e\u0301cole", "e\u0301cole grows"], 10);
	assertStreamingGolden(["# x", "# " + "x".repeat(39), "# " + "x".repeat(41), "# " + "x".repeat(160)], 42, ANSI_THEME);
});

test("non-wrapper heading themes remain on the full-render fallback", () => {
	const metrics = createMetrics();
	const dynamicTheme: MarkdownTheme = {
		...PLAIN_THEME,
		heading: (text: string): string => `[${text.length}]${text.toUpperCase()}`,
	};
	const candidate = new Markdown("# heading", 0, 0, dynamicTheme, undefined, { incrementalRenderCache: true }, metrics);
	candidate.render(30);
	candidate.setText("# heading grows");
	assert.deepEqual(candidate.render(30), new Markdown("# heading grows", 0, 0, dynamicTheme).render(30));
	assert.equal(metrics.incrementalUpdates, 0);
	assert.equal(metrics.lastFallbackReason, "style-state");
});

test("plain checkpoints fall back before list hr URL and email token transitions", () => {
	const matrices: readonly (readonly [string, string])[] = [
		["1", "1. item"],
		["1", "1) item"],
		["--", "---"],
		["https", "https://example.com"],
		["ftp", "ftp://example.com"],
		["FTP", "FTP://example.com"],
		["www", "www.example.com"],
		["user", "user@example.com"],
		["# https", "# https://example.com"],
		[" 1", " 1. item"],
		[" -", " - item"],
		[" --", " ---"],
	];
	for (let index = 0; index < matrices.length; index++) {
		const [initial, transitioned] = matrices[index]!;
		const metrics = createMetrics();
		const candidate = new Markdown(
			initial,
			0,
			0,
			SYNTAX_TRANSITION_THEME,
			undefined,
			{ incrementalRenderCache: true },
			metrics,
		);
		candidate.render(40);
		const incrementalBefore = metrics.incrementalUpdates;
		const fallbacksBefore = metrics.fullFallbacks;
		candidate.setText(transitioned);
		assert.deepEqual(
			candidate.render(40),
			new Markdown(transitioned, 0, 0, SYNTAX_TRANSITION_THEME).render(40),
			`syntax transition ${initial} -> ${transitioned}`,
		);
		assert.equal(metrics.incrementalUpdates, incrementalBefore);
		assert.equal(metrics.fullFallbacks, fallbacksBefore + 1);
		const expectedReason = initial === " -" ? "unsupported-block" : "syntax-transition";
		assert.equal(metrics.lastFallbackReason, expectedReason, `fallback reason ${initial} -> ${transitioned}`);
		const state = candidate as unknown as { incrementalPlainContentLines?: string[] };
		assert.equal(state.incrementalPlainContentLines, undefined);
		const incrementalBeforeTail = metrics.incrementalUpdates;
		const fallbacksBeforeTail = metrics.fullFallbacks;
		candidate.setText(`${transitioned} tail`);
		assert.deepEqual(
			candidate.render(40),
			new Markdown(`${transitioned} tail`, 0, 0, SYNTAX_TRANSITION_THEME).render(40),
		);
		assert.equal(metrics.incrementalUpdates, incrementalBeforeTail);
		assert.equal(metrics.fullFallbacks, fallbacksBeforeTail + 1);
	}
	for (const marker of ["-", "+"]) {
		const candidate = new Markdown(marker, 0, 0, SYNTAX_TRANSITION_THEME, undefined, {
			incrementalRenderCache: true,
		});
		candidate.render(40);
		const state = candidate as unknown as { incrementalPlainContentLines?: string[] };
		assert.equal(state.incrementalPlainContentLines, undefined);
	}
});

test("long pending email words cannot outgrow lexical transition proof", () => {
	for (const prefix of ["", "# ", "## "]) {
		const initial = `${prefix}user@abcdefgh`;
		const transitioned = `${initial}.com`;
		const metrics = createMetrics();
		const candidate = new Markdown(
			initial,
			0,
			0,
			SYNTAX_TRANSITION_THEME,
			undefined,
			{ incrementalRenderCache: true },
			metrics,
		);
		candidate.render(40);
		const incrementalBefore = metrics.incrementalUpdates;
		const fallbacksBefore = metrics.fullFallbacks;
		candidate.setText(transitioned);
		assert.deepEqual(
			candidate.render(40),
			new Markdown(transitioned, 0, 0, SYNTAX_TRANSITION_THEME).render(40),
			`pending email transition ${initial} -> ${transitioned}`,
		);
		assert.equal(metrics.incrementalUpdates, incrementalBefore);
		assert.equal(metrics.fullFallbacks, fallbacksBefore + 1);
		assert.equal(metrics.lastFallbackReason, "syntax-transition");
	}
	const metrics = createMetrics();
	const candidate = new Markdown(
		"user@abcdefgh",
		0,
		0,
		SYNTAX_TRANSITION_THEME,
		undefined,
		{ incrementalRenderCache: true },
		metrics,
	);
	candidate.render(40);
	const state = candidate as unknown as {
		incrementalPlainPendingEmail: boolean;
		incrementalPlainContentLines?: string[];
	};
	assert.equal(state.incrementalPlainPendingEmail, true);
	for (const source of ["user@abcdefghx", "user@abcdefghxy", "user@abcdefghxyz"]) {
		candidate.setText(source);
		assert.deepEqual(candidate.render(40), new Markdown(source, 0, 0, SYNTAX_TRANSITION_THEME).render(40));
		assert.equal(state.incrementalPlainPendingEmail, true);
	}
	const endedWord = "user@abcdefghxyz ordinary";
	candidate.setText(endedWord);
	assert.deepEqual(candidate.render(40), new Markdown(endedWord, 0, 0, SYNTAX_TRANSITION_THEME).render(40));
	assert.equal(state.incrementalPlainPendingEmail, false);
	assert.notEqual(state.incrementalPlainContentLines, undefined);
	const incrementalBefore = metrics.incrementalUpdates;
	candidate.setText(`${endedWord} prose`);
	assert.deepEqual(
		candidate.render(40),
		new Markdown(`${endedWord} prose`, 0, 0, SYNTAX_TRANSITION_THEME).render(40),
	);
	assert.equal(metrics.incrementalUpdates, incrementalBefore + 1);
});

test("benign punctuation retains or reestablishes a plain checkpoint", () => {
	const steps = [
		"ordinary",
		"ordinary,",
		"ordinary, prose",
		"ordinary, prose.",
		"ordinary, prose. (safe",
		"ordinary, prose. (safe)",
		"ordinary, prose. (safe): sentence",
	];
	const metrics = createMetrics();
	const candidate = new Markdown(
		steps[0]!,
		0,
		0,
		SYNTAX_TRANSITION_THEME,
		undefined,
		{ incrementalRenderCache: true },
		metrics,
	);
	for (let index = 0; index < steps.length; index++) {
		const source = steps[index]!;
		candidate.setText(source);
		assert.deepEqual(candidate.render(40), new Markdown(source, 0, 0, SYNTAX_TRANSITION_THEME).render(40));
	}
	assert.equal(metrics.incrementalUpdates, steps.length - 1);
	assert.equal(metrics.fullFallbacks, 1);
	assert.equal(metrics.lastFallbackReason, "none");
});

test("unsafe Markdown structures use full fallback and remain golden", () => {
	const matrices: readonly (readonly string[])[] = [
		["plain", "plain\n", "plain\nnext", "plain\nnext\n"],
		["plain\t", "plain\ttext"],
		["# heading", "# heading grows"],
		["### heading", "### heading grows"],
		["- item", "- item\n- second", "- item\n  - nested"],
		["> quote", "> quote grows", "> quote grows\n> next"],
		["`code", "`code`", "`code` tail"],
		["```ts\nconst x", "```ts\nconst x = 1", "```ts\nconst x = 1;\n```"],
		["[link", "[link](https://example.com)"],
		["![image", "![image](https://example.com/a.png)"],
		["| A | B |", "| A | B |\n| - | - |", "| A | B |\n| - | - |\n| 1 | 2 |"],
		["~~strike", "~~strike~~"],
		["$x", "$x$", "$x$ tail"],
		["<span", "<span>html</span>"],
		["\\*escape", "\\*escape\\*"],
		["\x1b[31mred", "\x1b[31mred text\x1b[0m"],
	];
	for (const steps of matrices) assertStreamingGolden(steps, 32);
});

test("replacement shrink width invalidate and capacity boundaries release incremental cache", () => {
	const metrics = createMetrics();
	const markdown = new Markdown("start", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true }, metrics);
	markdown.render(20);
	markdown.setText("start grows until it wraps onto another line");
	markdown.render(20);
	const state = markdown as unknown as {
		incrementalPlainContentLines?: string[];
		incrementalNormalizedText?: string;
		incrementalTokenContentLines?: string[][];
		incrementalPlainStylePrefix: string;
		incrementalPlainStyleSuffix: string;
		incrementalPlainTailStylePrefix: string;
	};
	const largeLines = state.incrementalPlainContentLines;
	assert.ok(largeLines && largeLines.length > 1);

	markdown.setText("small");
	assert.deepEqual(markdown.render(20), new Markdown("small", 0, 0, PLAIN_THEME).render(20));
	assert.notEqual(state.incrementalPlainContentLines, largeLines);
	assert.equal(metrics.lastFallbackReason, "not-append");
	assert.equal(metrics.cachedSourceCharacters, 5);

	markdown.setText("small grows");
	markdown.render(20);
	markdown.render(10);
	assert.equal(metrics.lastFallbackReason, "width-changed");
	markdown.invalidate();
	assert.equal(state.incrementalPlainContentLines, undefined);
	assert.equal(state.incrementalNormalizedText, undefined);
	assert.equal(state.incrementalTokenContentLines, undefined);
	assert.equal(state.incrementalPlainStylePrefix, "");
	assert.equal(state.incrementalPlainStyleSuffix, "");
	assert.equal(state.incrementalPlainTailStylePrefix, "");
	assert.equal(metrics.cachedTokenCount, 0);
	assert.equal(metrics.cachedRenderedLines, 0);
	assert.equal(metrics.cachedSourceCharacters, 0);

	markdown.setText("x".repeat(256 * 1024 + 1));
	markdown.render(80);
	assert.equal(metrics.lastFallbackReason, "text-capacity");
	assert.equal(metrics.cachedSourceCharacters, 0);
	assert.equal(metrics.cachedRenderedLines, 0);
});

test("an abnormally large pending grapheme drops the incremental tail checkpoint", () => {
	const metrics = createMetrics();
	const markdown = new Markdown("e", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true }, metrics);
	markdown.render(20);
	markdown.setText(`e${"\u0301".repeat(4_096)}`);
	const lines = markdown.render(20);
	assert.deepEqual(lines, new Markdown(`e${"\u0301".repeat(4_096)}`, 0, 0, PLAIN_THEME).render(20));
	assert.equal(metrics.lastFallbackReason, "tail-capacity");
	assert.equal(metrics.cachedSourceCharacters, 0);
	assert.equal(metrics.cachedRenderedLines, 0);
});

test("incremental Markdown cache is instance-local and transform output remains golden", () => {
	const first = new Markdown("alpha", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true });
	const second = new Markdown("beta", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true });
	first.render(20);
	second.render(20);
	const firstState = first as unknown as { incrementalPlainContentLines?: string[] };
	const secondState = second as unknown as { incrementalPlainContentLines?: string[] };
	assert.notEqual(firstState.incrementalPlainContentLines, secondState.incrementalPlainContentLines);
	assertStreamingGolden(["transform", "transform grows", "transform grows safely"], 20, PLAIN_THEME, {
		transform: identityStyle,
	});
});

test("incremental fallback reasons identify unsafe, styled, structural, width, and replacement boundaries", () => {
	const metrics = createMetrics();
	const markdown = new Markdown("plain", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true }, metrics);
	markdown.render(20);
	markdown.setText("plain*");
	markdown.render(20);
	assert.equal(metrics.lastFallbackReason, "unsafe-source");

	const replacementMetrics = createMetrics();
	const replacement = new Markdown(
		"plain replacement",
		0,
		0,
		PLAIN_THEME,
		undefined,
		{ incrementalRenderCache: true },
		replacementMetrics,
	);
	replacement.render(20);
	replacement.setText("replacement");
	replacement.render(20);
	assert.equal(replacementMetrics.lastFallbackReason, "not-append");

	replacement.setText("replacement grows");
	replacement.render(20);
	replacement.render(10);
	assert.equal(replacementMetrics.lastFallbackReason, "width-changed");

	const structuralMetrics = createMetrics();
	const structural = new Markdown("- item", 0, 0, PLAIN_THEME, undefined, { incrementalRenderCache: true }, structuralMetrics);
	structural.render(20);
	assert.equal(structuralMetrics.lastFallbackReason, "unsupported-block");

	const styledMetrics = createMetrics();
	const styled = new Markdown(
		"styled",
		0,
		0,
		PLAIN_THEME,
		{ italic: true },
		{ incrementalRenderCache: true },
		styledMetrics,
	);
	styled.render(20);
	assert.equal(styledMetrics.lastFallbackReason, "styled-content");
});

test("safe append checkpoints remain golden across deterministic randomized streams", () => {
	let seed = 0x51a7e123;
	const nextRandom = (): number => {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed;
	};
	const seeds = ["x", "1", "--", "www", "https", "user", "ordinary"];
	const chunks = [
		"a", "b", "Z", "0", " ", ".", ",", "(", ")", ":", "/", "@", "-", "+",
		"中", "文", "🙂", "e\u0301", "👨‍👩‍👧‍👦",
	];
	for (let stream = 0; stream < 100; stream++) {
		let source = seeds[stream % seeds.length]!;
		const width = 4 + (nextRandom() % 40);
		const candidate = new Markdown(
			source,
			1,
			0,
			SYNTAX_TRANSITION_THEME,
			undefined,
			{ incrementalRenderCache: true },
		);
		for (let update = 0; update < 200; update++) {
			const chunk = chunks[nextRandom() % chunks.length]!;
			if (chunk === " " && source.endsWith(" ")) continue;
			source += chunk;
			candidate.setText(source);
			assert.deepEqual(
				candidate.render(width),
				new Markdown(source, 1, 0, SYNTAX_TRANSITION_THEME).render(width),
				`stream ${stream}, update ${update}, width ${width}`,
			);
		}
	}
});

test("incremental Markdown and wrapping hot functions do not add closures maps sets or array transforms", () => {
	const markdownPath = resolve("packages/tui/src/components/markdown.ts");
	const markdownSource = ts.createSourceFile(
		markdownPath,
		readFileSync(markdownPath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const utilsPath = resolve("packages/tui/src/utils.ts");
	const utilsSource = ts.createSourceFile(
		utilsPath,
		readFileSync(utilsPath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const methodNames = new Set([
		"hasIncrementalPlainSyntaxTransition",
		"hasIncrementalDocumentPrefixTransition",
		"hasIncrementalAutolinkTransition",
		"hasPotentialEmailInTrailingWord",
		"incrementalAsciiPrefixEquals",
		"renderIncrementalPlainAppend",
		"setText",
		"prepareIncrementalPlainStyle",
		"applyIncrementalPlainStyle",
		"isIncrementalPlainRangeSafe",
		"scanIncrementalPlainTail",
		"consumeIncrementalPlainToken",
	]);
	const functionNames = new Set(["splitIntoTokensWithAnsi", "wrapSingleLine"]);
	let methodsChecked = 0;
	let functionsChecked = 0;
	let closures = 0;
	let mapsOrSets = 0;
	let arrayTransforms = 0;
	let objectLiterals = 0;
	const visitMethod = (node: ts.Node): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) closures++;
		if (ts.isObjectLiteralExpression(node)) objectLiterals++;
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
			(node.expression.text === "Map" || node.expression.text === "Set")) mapsOrSets++;
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
			["map", "filter", "flatMap"].includes(node.expression.name.text)) arrayTransforms++;
		ts.forEachChild(node, visitMethod);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && methodNames.has(node.name.text)) {
			methodsChecked++;
			if (node.body) ts.forEachChild(node.body, visitMethod);
			return;
		}
		if (ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text)) {
			functionsChecked++;
			if (node.body) ts.forEachChild(node.body, visitMethod);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(markdownSource);
	visit(utilsSource);
	assert.equal(methodsChecked, methodNames.size);
	assert.equal(functionsChecked, functionNames.size);
	assert.equal(closures, 0);
	assert.equal(mapsOrSets, 0);
	assert.equal(arrayTransforms, 0);
	assert.equal(objectLiterals, 0);
});

test("incremental Markdown benchmark labels CPU percentiles as 100-update batch means", () => {
	const source = readFileSync(resolve("scripts/bench/tui-markdown-incremental-wrap.ts"), "utf8");
	assert.match(source, /batchSize:\s*100/);
	assert.match(source, /cpuP50MsPerBatchMeanUpdate/);
	assert.match(source, /cpuP95MsPerBatchMeanUpdate/);
	assert.doesNotMatch(source, /cpuP50MsPerUpdate/);
	assert.doesNotMatch(source, /cpuP95MsPerUpdate/);
});
