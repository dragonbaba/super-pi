import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { renderLatex } from "../latex.ts";
import {
	ANSI_RESET_PATTERN,
	MARKDOWN_BLOCK_START_PATTERN,
	MARKDOWN_BRACKET_BLOCK_PATTERN,
	MARKDOWN_DOLLAR_BLOCK_PATTERN,
	MARKDOWN_DOLLAR_WHITESPACE_PATTERN,
	MARKDOWN_ENVIRONMENT_NAME_PATTERN,
	MARKDOWN_FENCE_START_PATTERN,
	MARKDOWN_IDENTIFIER_PATTERN,
	MARKDOWN_LEADING_DIGIT_PATTERN,
	MARKDOWN_ORDERED_LIST_MARKER_PATTERN,
	MARKDOWN_PENDING_BRACKET_BLOCK_PATTERN,
	MARKDOWN_PENDING_DOLLAR_BLOCK_PATTERN,
	MARKDOWN_PENDING_MATH_PATTERN,
	MARKDOWN_STRICT_STRIKETHROUGH_PATTERN,
	MARKDOWN_TRAILING_WHITESPACE_PATTERN,
	MARKDOWN_UNORDERED_LIST_MARKER_PATTERN,
	TAB_PATTERN,
	TRAILING_LINE_FEED_PATTERN,
} from "../regex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, isWhitespaceChar, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = MARKDOWN_STRICT_STRIKETHROUGH_PATTERN.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return MARKDOWN_PENDING_MATH_PATTERN.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !MARKDOWN_DOLLAR_WHITESPACE_PATTERN.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(MARKDOWN_TRAILING_WHITESPACE_PATTERN.test(source.slice(opening.length, closingIndex)) ||
			MARKDOWN_LEADING_DIGIT_PATTERN.test(source.slice(closingIndex + 1)) ||
			(MARKDOWN_ENVIRONMENT_NAME_PATTERN.test(source.slice(opening.length, closingIndex)) &&
				MARKDOWN_IDENTIFIER_PATTERN.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = MARKDOWN_DOLLAR_BLOCK_PATTERN.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = MARKDOWN_BRACKET_BLOCK_PATTERN.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = MARKDOWN_PENDING_BRACKET_BLOCK_PATTERN.exec(source);
	if (pendingBracket) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = MARKDOWN_PENDING_DOLLAR_BLOCK_PATTERN.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = MARKDOWN_BLOCK_START_PATTERN.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			let firstIndex = source.indexOf("$");
			const parenthesisIndex = source.indexOf("\\(");
			if (parenthesisIndex >= 0 && (firstIndex < 0 || parenthesisIndex < firstIndex)) firstIndex = parenthesisIndex;
			const bracketIndex = source.indexOf("\\[");
			if (bracketIndex >= 0 && (firstIndex < 0 || bracketIndex < firstIndex)) firstIndex = bracketIndex;
			return firstIndex >= 0 ? firstIndex : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = MARKDOWN_FENCE_START_PATTERN.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(TRAILING_LINE_FEED_PATTERN, "");
}

const markdownParser = new Marked();
const MAX_INCREMENTAL_MARKDOWN_TEXT_LENGTH = 256 * 1024;
const MAX_INCREMENTAL_MARKDOWN_TOKENS = 8192;
const MAX_INCREMENTAL_MARKDOWN_RENDERED_CHARACTERS = 4 * 1024 * 1024;

function getTokenSignature(token: unknown): string | undefined {
	try {
		return JSON.stringify(token);
	} catch {
		return undefined;
	}
}
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	renderLatex?: boolean;
	/** Reuse unchanged token rendering while streaming append-only Markdown. */
	incrementalRenderCache?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

function applyTextPreservingNewlines(text: string, applyText: (text: string) => string): string {
	let start = 0;
	let result = "";
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		if (newline === -1) return result + applyText(text.slice(start));
		result += applyText(text.slice(start, newline)) + "\n";
		start = newline + 1;
	}
	return result;
}

function buildTableBorder(columnWidths: readonly number[], left: string, separator: string, right: string): string {
	let border = left;
	for (let index = 0; index < columnWidths.length; index++) {
		if (index > 0) border += separator;
		border += "─".repeat(columnWidths[index] + 2);
	}
	return border + right;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private incrementalNormalizedText?: string;
	private incrementalWidth?: number;
	private incrementalLinksSignature?: string;
	private incrementalTokenSignatures?: Array<string | undefined>;
	private incrementalTokenContentLines?: string[][];
	private lastIncrementalReuseCount = 0;
	private lastParserTokenCount = 0;
	private readonly applyDefaultInlineText = (text: string): string => this.applyDefaultStyle(text);
	private readonly defaultInlineStyleContext: InlineStyleContext = {
		applyText: this.applyDefaultInlineText,
		stylePrefix: "",
	};

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	getLastIncrementalReuseCount(): number {
		return this.lastIncrementalReuseCount;
	}

	getLastParserTokenCount(): number {
		return this.lastParserTokenCount;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.incrementalNormalizedText = undefined;
		this.incrementalWidth = undefined;
		this.incrementalLinksSignature = undefined;
		this.incrementalTokenSignatures = undefined;
		this.incrementalTokenContentLines = undefined;
		this.lastIncrementalReuseCount = 0;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = text.replace(TAB_PATTERN, "   ");

		// Parse markdown to HTML-like tokens
		const tokens = markdownParser.lexer(normalizedText);
		this.lastParserTokenCount = tokens.length;
		trimPartialClosingFences(tokens);

		const incrementalEligible = this.options.incrementalRenderCache === true &&
			normalizedText.length <= MAX_INCREMENTAL_MARKDOWN_TEXT_LENGTH &&
			tokens.length <= MAX_INCREMENTAL_MARKDOWN_TOKENS;
		const linksSignature = incrementalEligible ? getTokenSignature(tokens.links ?? {}) : undefined;
		const tokenSignatures = incrementalEligible ? new Array<string | undefined>(tokens.length) : undefined;
		let signaturesValid = incrementalEligible && linksSignature !== undefined;
		if (tokenSignatures) {
			for (let i = 0; i < tokens.length; i++) {
				const signature = getTokenSignature(tokens[i]);
				tokenSignatures[i] = signature;
				if (signature === undefined) signaturesValid = false;
			}
		}
		let reuseCount = 0;
		if (
			signaturesValid &&
			this.incrementalNormalizedText !== undefined &&
			normalizedText.startsWith(this.incrementalNormalizedText) &&
			this.incrementalWidth === width &&
			this.incrementalLinksSignature === linksSignature &&
			this.incrementalTokenSignatures &&
			this.incrementalTokenContentLines
		) {
			const comparable = Math.min(tokens.length, this.incrementalTokenSignatures.length);
			while (reuseCount < comparable && tokenSignatures?.[reuseCount] === this.incrementalTokenSignatures[reuseCount]) reuseCount++;
			reuseCount = Math.max(0, reuseCount - 1);
		}
		this.lastIncrementalReuseCount = reuseCount;
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const tokenContentLines = incrementalEligible ? new Array<string[]>(tokens.length) : undefined;
		const contentLines: string[] = [];
		let renderedCharacterCount = 0;
		for (let i = 0; i < tokens.length; i++) {
			let lines: string[];
			if (i < reuseCount) {
				lines = this.incrementalTokenContentLines![i];
			} else {
				const tokenLines = this.renderToken(tokens[i], contentWidth, tokens[i + 1]?.type);
				const wrappedLines: string[] = [];
				for (const line of tokenLines) {
					if (isImageLine(line)) wrappedLines.push(line);
					else wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
				}
				lines = [];
				for (const line of wrappedLines) {
					if (isImageLine(line)) { lines.push(line); continue; }
					const lineWithMargins = leftMargin + line + rightMargin;
					if (bgFn) lines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
					else {
						const visibleLen = visibleWidth(lineWithMargins);
						lines.push(lineWithMargins + " ".repeat(Math.max(0, width - visibleLen)));
					}
				}
			}
			if (tokenContentLines) tokenContentLines[i] = lines;
			for (const line of lines) {
				contentLines.push(line);
				renderedCharacterCount += line.length;
			}
		}
		if (signaturesValid && renderedCharacterCount <= MAX_INCREMENTAL_MARKDOWN_RENDERED_CHARACTERS) {
			this.incrementalNormalizedText = normalizedText;
			this.incrementalWidth = width;
			this.incrementalLinksSignature = linksSignature;
			this.incrementalTokenSignatures = tokenSignatures;
			this.incrementalTokenContentLines = tokenContentLines;
		} else {
			this.incrementalNormalizedText = undefined;
			this.incrementalWidth = undefined;
			this.incrementalLinksSignature = undefined;
			this.incrementalTokenSignatures = undefined;
			this.incrementalTokenContentLines = undefined;
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		this.defaultInlineStyleContext.stylePrefix = this.getDefaultStylePrefix();
		return this.defaultInlineStyleContext;
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "latexBlock": {
				const latexToken = token as LatexToken;
				const rendered =
					!latexToken.pending && this.options.renderLatex !== false
						? (renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim())
						: latexToken.raw.trim();
				for (const line of rendered.split("\n")) {
					lines.push(this.applyDefaultStyle(line));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(ANSI_RESET_PATTERN, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const latexToken = token as LatexToken;
					const rendered =
						!latexToken.pending && this.options.renderLatex !== false
							? (renderLatex(latexToken.text) ?? latexToken.raw)
							: latexToken.raw;
					result += applyTextPreservingNewlines(rendered, applyText);
					break;
				}

				case "escape":
					result += applyTextPreservingNewlines(
						this.options.preserveBackslashEscapes ? token.raw : token.text,
						applyText,
					);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextPreservingNewlines(token.text, applyText);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextPreservingNewlines(token.raw, applyText);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextPreservingNewlines(token.text, applyText);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = MARKDOWN_ORDERED_LIST_MARKER_PATTERN.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = MARKDOWN_UNORDERED_LIST_MARKER_PATTERN.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		let longest = 0;
		let wordStart = -1;
		for (let index = 0; index <= text.length; index++) {
			if (index < text.length && !isWhitespaceChar(text[index])) {
				if (wordStart < 0) wordStart = index;
				continue;
			}
			if (wordStart >= 0) {
				const width = visibleWidth(text.slice(wordStart, index));
				if (width > longest) longest = width;
				wordStart = -1;
			}
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = 0;
		for (let index = 0; index < numCols; index++) minCellsWidth += minColumnWidths[index];

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				let totalWeight = 0;
				for (let index = 0; index < numCols; index++) totalWeight += Math.max(0, minWordWidths[index] - 1);
				let allocated = 0;
				for (let index = 0; index < numCols; index++) {
					const weight = Math.max(0, minWordWidths[index] - 1);
					const growth = totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
					minColumnWidths[index] += growth;
					allocated += growth;
				}
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = 0;
			for (let index = 0; index < numCols; index++) minCellsWidth += minColumnWidths[index];
		}

		// Calculate column widths that fit within available width
		let totalNaturalWidth = borderOverhead;
		for (let index = 0; index < numCols; index++) totalNaturalWidth += naturalWidths[index];
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = new Array<number>(numCols);
			for (let index = 0; index < numCols; index++) {
				columnWidths[index] = Math.max(naturalWidths[index], minColumnWidths[index]);
			}
		} else {
			// Need to shrink columns to fit
			let totalGrowPotential = 0;
			for (let index = 0; index < numCols; index++) {
				totalGrowPotential += Math.max(0, naturalWidths[index] - minColumnWidths[index]);
			}
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = new Array<number>(numCols);
			let allocated = 0;
			for (let index = 0; index < numCols; index++) {
				const minWidth = minColumnWidths[index];
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				columnWidths[index] = minWidth + grow;
				allocated += columnWidths[index];
			}

			// Adjust for rounding errors - distribute remaining space
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		lines.push(buildTableBorder(columnWidths, "┌", "┬", "┐"));

		// Render header with wrapping
		const headerCellLines = new Array<string[]>(numCols);
		let headerLineCount = 0;
		for (let index = 0; index < numCols; index++) {
			const text = this.renderInlineTokens(token.header[index].tokens || [], styleContext);
			const cellLines = this.wrapCellText(text, columnWidths[index]);
			headerCellLines[index] = cellLines;
			if (cellLines.length > headerLineCount) headerLineCount = cellLines.length;
		}

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			let rowLine = "│ ";
			for (let colIdx = 0; colIdx < numCols; colIdx++) {
				if (colIdx > 0) rowLine += " │ ";
				const cellLines = headerCellLines[colIdx];
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				rowLine += this.theme.bold(padded);
			}
			lines.push(rowLine + " │");
		}

		// Render separator
		const separatorLine = buildTableBorder(columnWidths, "├", "┼", "┤");
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines = new Array<string[]>(numCols);
			let rowLineCount = 0;
			for (let index = 0; index < numCols; index++) {
				const text = this.renderInlineTokens(row[index]?.tokens || [], styleContext);
				const cellLines = this.wrapCellText(text, columnWidths[index]);
				rowCellLines[index] = cellLines;
				if (cellLines.length > rowLineCount) rowLineCount = cellLines.length;
			}

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				let rowLine = "│ ";
				for (let colIdx = 0; colIdx < numCols; colIdx++) {
					if (colIdx > 0) rowLine += " │ ";
					const cellLines = rowCellLines[colIdx];
					const text = cellLines[lineIdx] || "";
					rowLine += text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				}
				lines.push(rowLine + " │");
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		lines.push(buildTableBorder(columnWidths, "└", "┴", "┘"));

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
