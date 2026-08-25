import { fuzzyMatch } from "@super-pi/tui";
import type { SessionInfo } from "../../../core/session-manager.ts";
import {
	WHITESPACE_CHARACTER_PATTERN,
	WHITESPACE_RUN_PATTERN,
	WHITESPACE_SEPARATOR_PATTERN,
} from "./session-selector-search-regex.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

const SESSION_SEARCH_TEXT_CACHE = new WeakMap<SessionInfo, string>();

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(WHITESPACE_RUN_PATTERN, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
	const cached = SESSION_SEARCH_TEXT_CACHE.get(session);
	if (cached !== undefined) return cached;
	const text = `${session.id} ${session.name ?? ""} ${session.firstMessage} ${session.cwd}`;
	SESSION_SEARCH_TEXT_CACHE.set(session, text);
	return text;
}

function appendSearchToken(
	tokens: { kind: "fuzzy" | "phrase"; value: string }[],
	kind: "fuzzy" | "phrase",
	value: string,
): void {
	const normalized = value.trim();
	if (normalized) tokens.push({ kind, value: normalized });
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { tokens: [] };
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				appendSearchToken(tokens, "phrase", buf);
				buf = "";
				inQuote = false;
			} else {
				appendSearchToken(tokens, "fuzzy", buf);
				buf = "";
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && WHITESPACE_CHARACTER_PATTERN.test(ch)) {
			appendSearchToken(tokens, "fuzzy", buf);
			buf = "";
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		const fallbackTokens: { kind: "fuzzy"; value: string }[] = [];
		for (const value of trimmed.split(WHITESPACE_SEPARATOR_PATTERN)) {
			const normalized = value.trim();
			if (normalized) fallbackTokens.push({ kind: "fuzzy", value: normalized });
		}
		return { tokens: fallbackTokens };
	}

	appendSearchToken(tokens, inQuote ? "phrase" : "fuzzy", buf);

	return { tokens };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = normalizeWhitespaceLower(text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	let nameFiltered = sessions;
	if (nameFilter !== "all") {
		nameFiltered = [];
		for (const session of sessions) {
			if (matchesNameFilter(session, nameFilter)) nameFiltered.push(session);
		}
	}
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	const sortedSessions = new Array<SessionInfo>(scored.length);
	for (let index = 0; index < scored.length; index++) sortedSessions[index] = scored[index]!.session;
	return sortedSessions;
}
