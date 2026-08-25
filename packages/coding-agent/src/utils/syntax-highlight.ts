import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { decodeHtmlEntityAt } from "./html.ts";
import { ObjectPool } from "./object-pool.ts";
import { HIGHLIGHT_CLASS_ATTRIBUTE_PATTERN } from "./syntax-highlight-regex.ts";

const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};
const eagerLanguageRegistry: Readonly<Record<string, typeof python>> = eagerLanguages;

const eagerLanguageNames = Object.keys(eagerLanguageRegistry);
for (let index = 0; index < eagerLanguageNames.length; index++) {
	const name = eagerLanguageNames[index]!;
	hljs.registerLanguage(name, eagerLanguageRegistry[name]);
}

let allLanguagesPromise: Promise<void> | undefined;

function ignoreHighlightLanguageImport(): void {
	// Eager languages and plaintext fallback remain available.
}

export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = import("highlight.js/lib/index.js").then(
			ignoreHighlightLanguageImport,
			ignoreHighlightLanguageImport,
		);
	}
	return allLanguagesPromise;
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";
const EMPTY_HIGHLIGHT_THEME: HighlightTheme = Object.freeze({});
const MAX_POOLED_HIGHLIGHT_OUTPUT_CHARS = 1024 * 1024;
const MAX_POOLED_HIGHLIGHT_SCOPE_DEPTH = 256;

interface HighlightRenderState {
	output: string;
	textBuffer: string;
	scopes: Array<string | undefined>;
}

const HIGHLIGHT_RENDER_STATE_POOL = new ObjectPool<HighlightRenderState>(
	() => ({ output: "", textBuffer: "", scopes: [] }),
	(state) => {
		state.output = "";
		state.textBuffer = "";
		state.scopes.length = 0;
	},
	8,
	(state) =>
		state.output.length <= MAX_POOLED_HIGHLIGHT_OUTPUT_CHARS &&
		state.textBuffer.length <= MAX_POOLED_HIGHLIGHT_OUTPUT_CHARS &&
		state.scopes.length <= MAX_POOLED_HIGHLIGHT_SCOPE_DEPTH,
);

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = HIGHLIGHT_CLASS_ATTRIBUTE_PATTERN.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	let start = 0;
	while (start < classValue.length) {
		while (start < classValue.length && classValue.charCodeAt(start) <= 0x20) start++;
		let end = start;
		while (end < classValue.length && classValue.charCodeAt(end) > 0x20) end++;
		if (classValue.startsWith(HIGHLIGHT_CLASS_PREFIX, start)) {
			return classValue.slice(start + HIGHLIGHT_CLASS_PREFIX.length, end);
		}
		start = end + 1;
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

function flushHighlightedText(state: HighlightRenderState, theme: HighlightTheme): void {
	if (!state.textBuffer) return;
	const formatter = getActiveFormatter(state.scopes, theme);
	state.output += formatter ? formatter(state.textBuffer) : state.textBuffer;
	state.textBuffer = "";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = EMPTY_HIGHLIGHT_THEME): string {
	const state = HIGHLIGHT_RENDER_STATE_POOL.acquire();

	try {
		let index = 0;
		while (index < html.length) {
			const code = html.charCodeAt(index);
			if (code === 0x3c) {
				if (isSpanOpenTagStart(html, index)) {
					const tagEndIndex = html.indexOf(">", index + 5);
					if (tagEndIndex !== -1) {
						flushHighlightedText(state, theme);
						const tag = html.slice(index, tagEndIndex + 1);
						state.scopes.push(getScopeFromSpanTag(tag));
						index = tagEndIndex + 1;
						continue;
					}
				}

				if (html.startsWith(SPAN_CLOSE, index)) {
					flushHighlightedText(state, theme);
					if (state.scopes.length > 0) state.scopes.pop();
					index += SPAN_CLOSE.length;
					continue;
				}
			}

			if (code === 0x26) {
				const decoded = decodeHtmlEntityAt(html, index);
				if (decoded) {
					state.textBuffer += decoded.text;
					index += decoded.length;
					continue;
				}
			}

			let textEnd = index + 1;
			while (textEnd < html.length) {
				const textCode = html.charCodeAt(textEnd);
				if (textCode === 0x3c || textCode === 0x26) break;
				textEnd++;
			}
			state.textBuffer += html.slice(index, textEnd);
			index = textEnd;
		}
		flushHighlightedText(state, theme);
		return state.output;
	} finally {
		HIGHLIGHT_RENDER_STATE_POOL.release(state);
	}
}

export function highlight(code: string, options?: HighlightOptions): string {
	const html = options?.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options?.languageSubset).value;
	return renderHighlightedHtml(html, options?.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
