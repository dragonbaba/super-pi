import assert from "node:assert/strict";
import test from "node:test";
import {
	FUZZY_ALPHA_NUMERIC_PATTERN,
	FUZZY_NUMERIC_ALPHA_PATTERN,
	FUZZY_TOKEN_SEPARATOR_PATTERN,
} from "../packages/tui/src/regex.ts";
import { isWhitespaceChar } from "../packages/tui/src/utils.ts";
import { fuzzyFilter, fuzzyMatch } from "../packages/tui/src/fuzzy.ts";

const WORD_BOUNDARY_PUNCTUATION = "-_./:";
const isWordBoundaryCharacter = (character: string): boolean =>
	isWhitespaceChar(character) || WORD_BOUNDARY_PUNCTUATION.includes(character);

// Semantic oracle copied from the pre-S6 implementation. This intentionally
// keeps the old scan so the test detects score or tie-order drift as well as
// changes to the match set.
function legacyFuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();
	const matchQuery = (normalizedQuery: string): { matches: boolean; score: number } => {
		if (normalizedQuery.length === 0) return { matches: true, score: 0 };
		if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;
		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
			if (textLower[i] !== normalizedQuery[queryIndex]) continue;
			const isWordBoundary = i === 0 || isWordBoundaryCharacter(textLower[i - 1]!);
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
			}
			if (isWordBoundary) score -= 10;
			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}
		if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
		if (normalizedQuery === textLower) score -= 100;
		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) return primaryMatch;
	const alphaNumericMatch = queryLower.match(FUZZY_ALPHA_NUMERIC_PATTERN);
	const numericAlphaMatch = queryLower.match(FUZZY_NUMERIC_ALPHA_PATTERN);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";
	if (!swappedQuery) return primaryMatch;
	const swappedMatch = matchQuery(swappedQuery);
	return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : primaryMatch;
}

function legacyFuzzyFilter(items: string[], query: string): string[] {
	if (!query.trim()) return items;
	const tokens = query.trim().split(FUZZY_TOKEN_SEPARATOR_PATTERN).filter((token) => token.length > 0);
	if (tokens.length === 0) return items;
	const results: { item: string; totalScore: number; index: number }[] = [];
	for (const [index, item] of items.entries()) {
		let totalScore = 0;
		let allMatch = true;
		for (const token of tokens) {
			const match = legacyFuzzyMatch(token, item);
			if (!match.matches) {
				allMatch = false;
				break;
			}
			totalScore += match.score;
		}
		if (allMatch) results.push({ item, totalScore, index });
	}
	results.sort((a, b) => a.totalScore - b.totalScore || a.index - b.index);
	return results.map(({ item }) => item);
}

const queries = [
	"",
	"a",
	"fb",
	"foo",
	"a1",
	"1a",
	"Ab12",
	"12Ab",
	"中文",
	"a.b",
	"a b",
	"\t",
	"😀a",
	"zzzz",
];
const texts = [
	"",
	"foo_bar",
	"Foo Bar",
	"alphabet soup",
	"abc123",
	"123abc",
	"a-b/c:d",
	"a  b",
	"中文文本",
	"字a字",
	"12Ab value",
	"Ab12 value",
	"one-two three",
	"😀 Alpha",
	"plain text",
];

test("fuzzyMatch keeps the pre-S6 match set and scores", () => {
	for (const query of queries) {
		for (const text of texts) {
			assert.deepEqual(fuzzyMatch(query, text), legacyFuzzyMatch(query, text), `${JSON.stringify({ query, text })}`);
		}
	}
});

test("fuzzyFilter keeps token semantics and stable ties", () => {
	const items = ["foo_bar", "foobar", "bar foo", "12Ab", "Ab12", "中文文本", "a-b/c", "a b"];
	for (const query of ["", "fb", "foo b", "12ab", "ab12", "中文", "a/b", "missing"]) {
		const expected = legacyFuzzyFilter(items, query);
		const actual = fuzzyFilter(items, query, (item) => item);
		assert.deepEqual(actual, expected, query);
	}
});
