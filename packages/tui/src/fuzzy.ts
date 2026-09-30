/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

import {
	FUZZY_ALPHA_NUMERIC_PATTERN,
	FUZZY_NUMERIC_ALPHA_PATTERN,
	FUZZY_TOKEN_SEPARATOR_PATTERN,
} from "./regex.ts";
import { isWhitespaceChar } from "./utils.ts";

const WORD_BOUNDARY_PUNCTUATION = "-_./:";

function isWordBoundaryCharacter(character: string): boolean {
	return isWhitespaceChar(character) || WORD_BOUNDARY_PUNCTUATION.includes(character);
}

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

function scoreQuery(normalizedQuery: string, textLower: string): number | undefined {
	if (normalizedQuery.length === 0) {
		return 0;
	}

	if (normalizedQuery.length > textLower.length) {
		return undefined;
	}

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	while (queryIndex < normalizedQuery.length) {
		const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
		if (i === -1) break;

		const isWordBoundary = i === 0 || isWordBoundaryCharacter(textLower[i - 1]!);

		// Reward consecutive matches
		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			// Penalize gaps
			if (lastMatchIndex >= 0) {
				score += (i - lastMatchIndex - 1) * 2;
			}
		}

		// Reward word boundary matches
		if (isWordBoundary) {
			score -= 10;
		}

		// Slight penalty for later matches
		score += i * 0.1;

		lastMatchIndex = i;
		queryIndex++;
	}

	if (queryIndex < normalizedQuery.length) {
		return undefined;
	}

	if (normalizedQuery === textLower) {
		score -= 100;
	}

	return score;
}

function swappedQueryFor(queryLower: string): string {
	const alphaNumericMatch = queryLower.match(FUZZY_ALPHA_NUMERIC_PATTERN);
	const numericAlphaMatch = queryLower.match(FUZZY_NUMERIC_ALPHA_PATTERN);
	return alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

}

function scoreWithSwap(query: string, swappedQuery: string, text: string): number | undefined {
	const score = scoreQuery(query, text);
	if (score !== undefined || !swappedQuery) return score;
	const swappedScore = scoreQuery(swappedQuery, text);
	return swappedScore === undefined ? undefined : swappedScore + 5;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();
	const primary = scoreQuery(queryLower, textLower);
	if (primary !== undefined) return { matches: true, score: primary };
	const swapped = swappedQueryFor(queryLower);
	const score = swapped ? scoreQuery(swapped, textLower) : undefined;
	return score === undefined ? { matches: false, score: 0 } : { matches: true, score: score + 5 };
}

function compareMatchScores(a: { totalScore: number }, b: { totalScore: number }): number {
	return a.totalScore - b.totalScore;
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query.trim().split(FUZZY_TOKEN_SEPARATOR_PATTERN);
	const swappedTokens: string[] = [];
	let tokenCount = 0;
	for (const token of tokens) {
		if (token.length === 0) continue;
		const normalized = token.toLowerCase();
		tokens[tokenCount++] = normalized;
		swappedTokens.push(swappedQueryFor(normalized));
	}
	tokens.length = tokenCount;

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item).toLowerCase();
		let totalScore = 0;
		let allMatch = true;

		for (let index = 0; index < tokens.length; index++) {
			const score = scoreWithSwap(tokens[index]!, swappedTokens[index]!, text);
			if (score !== undefined) {
				totalScore += score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort(compareMatchScores);
	const filtered: T[] = [];
	for (const result of results) filtered.push(result.item);
	return filtered;
}
