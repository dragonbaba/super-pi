import type { Theme, ThemeColor } from "@super-pi/coding-agent";
import hljs from "highlight.js";
import {
	HIGHLIGHT_CLASS_ATTRIBUTE_PATTERN,
	HIGHLIGHT_CLASS_SEPARATOR_PATTERN,
} from "./syntax-highlighting-regex.ts";

export type SyntaxTheme = Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "italic" | "underline">>;

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "fish",
	ps1: "powershell",
	sql: "sql",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	sass: "sass",
	less: "less",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	xml: "xml",
	md: "markdown",
	markdown: "markdown",
	dockerfile: "dockerfile",
	makefile: "makefile",
	cmake: "cmake",
	lua: "lua",
	perl: "perl",
	r: "r",
	scala: "scala",
	clj: "clojure",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	ml: "ocaml",
	vim: "vim",
	graphql: "graphql",
	proto: "protobuf",
	tf: "hcl",
	hcl: "hcl",
};

const SCOPE_COLORS: Readonly<Record<string, ThemeColor>> = {
	keyword: "syntaxKeyword",
	built_in: "syntaxType",
	literal: "syntaxNumber",
	number: "syntaxNumber",
	regexp: "syntaxString",
	string: "syntaxString",
	comment: "syntaxComment",
	doctag: "syntaxComment",
	meta: "muted",
	function: "syntaxFunction",
	title: "syntaxFunction",
	class: "syntaxType",
	type: "syntaxType",
	tag: "syntaxPunctuation",
	name: "syntaxKeyword",
	attr: "syntaxVariable",
	variable: "syntaxVariable",
	params: "syntaxVariable",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
	addition: "toolDiffAdded",
	deletion: "toolDiffRemoved",
};

export function getLanguageFromPath(filePath: string): string | undefined {
	const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

export function highlightCode(
	code: string,
	language: string | undefined,
	theme: SyntaxTheme,
): string {
	if (!language || !hljs.getLanguage(language)) {
		return theme.fg("mdCodeBlock", theme.fg("mdCodeBlock", code));
	}
	try {
		const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
		return theme.fg("mdCodeBlock", renderHighlightedHtml(html, theme));
	} catch {
		return theme.fg("mdCodeBlock", code);
	}
}

function renderHighlightedHtml(
	html: string,
	theme: SyntaxTheme,
): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	for (let index = 0; index < html.length; ) {
		if (html.startsWith("<span", index)) {
			const tagEnd = html.indexOf(">", index + 5);
			if (tagEnd >= 0) {
				if (textBuffer) { output += styleSyntaxText(textBuffer, scopes, theme); textBuffer = ""; }
				scopes.push(scopeFromTag(html.slice(index, tagEnd + 1)));
				index = tagEnd + 1;
				continue;
			}
		}
		if (html.startsWith("</span>", index)) {
			if (textBuffer) { output += styleSyntaxText(textBuffer, scopes, theme); textBuffer = ""; }
			scopes.pop();
			index += "</span>".length;
			continue;
		}
		if (html[index] === "&") {
			const entityEnd = html.indexOf(";", index + 1);
			if (entityEnd >= 0) {
				const decoded = decodeEntity(html.slice(index + 1, entityEnd));
				if (decoded !== undefined) {
					textBuffer += decoded;
					index = entityEnd + 1;
					continue;
				}
			}
		}
		textBuffer += html[index];
		index += 1;
	}
	if (textBuffer) { output += styleSyntaxText(textBuffer, scopes, theme); textBuffer = ""; }
	return output;
}

function scopeFromTag(tag: string): string | undefined {
	const classMatch = HIGHLIGHT_CLASS_ATTRIBUTE_PATTERN.exec(tag);
	const classValue = classMatch?.[1] || classMatch?.[2];
	if (!classValue) return undefined;
	for (const className of classValue.split(HIGHLIGHT_CLASS_SEPARATOR_PATTERN)) if (className.startsWith("hljs-")) return className.slice("hljs-".length);
	return undefined;
}

function isSyntaxScope(scope: string): boolean {
	return typeof SCOPE_COLORS[scope] === "string" || scope === "emphasis" || scope === "strong" || scope === "link";
}

function styleSyntaxText(text: string, scopes: readonly (string | undefined)[], theme: SyntaxTheme): string {
	for (let index = scopes.length - 1; index >= 0; index--) {
		let scope = scopes[index];
		if (!scope) continue;
		if (!isSyntaxScope(scope)) {
			const dotIndex = scope.indexOf(".");
			const dashIndex = scope.indexOf("-");
			const separatorIndex = dotIndex < 0 ? dashIndex : dashIndex < 0 ? dotIndex : Math.min(dotIndex, dashIndex);
			scope = separatorIndex < 0 ? scope : scope.slice(0, separatorIndex);
			if (!isSyntaxScope(scope)) continue;
		}
		if (scope === "emphasis") return theme.italic?.(text) ?? text;
		if (scope === "strong") return theme.bold(text);
		if (scope === "link") return theme.underline?.(text) ?? text;
		return theme.fg(SCOPE_COLORS[scope]!, text);
	}
	return text;
}

function decodeEntity(entity: string): string | undefined {
	if (NAMED_ENTITIES[entity] !== undefined) return NAMED_ENTITIES[entity];
	const radix = entity.startsWith("#x") || entity.startsWith("#X") ? 16 : 10;
	const digits =
		entity.startsWith("#x") || entity.startsWith("#X") ? entity.slice(2) : entity.slice(1);
	if (!entity.startsWith("#") || !digits) return undefined;
	const codePoint = Number.parseInt(digits, radix);
	if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return undefined;
	}
}
