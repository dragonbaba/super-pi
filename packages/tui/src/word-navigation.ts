import { getWordSegmenter, isPunctuationChar, isWhitespaceChar } from "./utils.ts";

const wordSegmenter = getWordSegmenter();

/**
 * Options for word navigation functions.
 * When omitted, uses the default Intl.Segmenter word segmentation.
 */
export interface WordNavigationOptions {
	/** Custom segmenter returning word segments for the given text. */
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	/** Predicate identifying atomic segments that should be treated as single units (e.g. paste markers). */
	isAtomicSegment?: (segment: string) => boolean;
}

/**
 * Find the cursor position after moving one word backward from `cursor` in `text`.
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;

	const textBeforeCursor = text.slice(0, cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? [...segmentFn(textBeforeCursor)] : [...wordSegmenter.segment(textBeforeCursor)];
	let newCursor = cursor;

	// Skip trailing whitespace
	while (
		segments.length > 0 &&
		!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
		isWhitespaceChar(segments[segments.length - 1]?.segment || "")
	) {
		newCursor -= segments.pop()?.segment.length || 0;
	}

	if (segments.length === 0) return newCursor;

	const last = segments[segments.length - 1]!;

	if (isAtomic?.(last.segment)) {
		// Skip one atomic segment.
		newCursor -= last.segment.length;
	} else if (last.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		const segment = last.segment;
		let punctuationEnd = 0;
		for (let index = segment.length - 1; index >= 0; index--) {
			if (isPunctuationChar(segment[index]!)) {
				punctuationEnd = index + 1;
				break;
			}
		}
		if (punctuationEnd === 0) {
			newCursor -= segment.length;
		} else {
			newCursor -= segment.length - punctuationEnd;
		}
	} else {
		// Skip non-word non-whitespace run (punctuation)
		while (
			segments.length > 0 &&
			!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
			!segments[segments.length - 1]?.isWordLike &&
			!isWhitespaceChar(segments[segments.length - 1]?.segment || "")
		) {
			newCursor -= segments.pop()?.segment.length || 0;
		}
	}

	return newCursor;
}

/**
 * Find the cursor position after moving one word forward from `cursor` in `text`.
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor >= text.length) return text.length;

	const textAfterCursor = text.slice(cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter.segment(textAfterCursor);
	const iterator = segments[Symbol.iterator]();
	let next = iterator.next();
	let newCursor = cursor;

	// Skip leading whitespace
	while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
		newCursor += next.value.segment.length;
		next = iterator.next();
	}

	if (next.done) return newCursor;

	if (isAtomic?.(next.value.segment)) {
		// Skip one atomic segment.
		newCursor += next.value.segment.length;
	} else if (next.value.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		const segment = next.value.segment;
		let punctuationIndex = segment.length;
		for (let index = 0; index < segment.length; index++) {
			if (isPunctuationChar(segment[index]!)) {
				punctuationIndex = index;
				break;
			}
		}
		newCursor += punctuationIndex;
	} else {
		// Skip non-word non-whitespace run (punctuation)
		while (
			!next.done &&
			!isAtomic?.(next.value.segment) &&
			!next.value.isWordLike &&
			!isWhitespaceChar(next.value.segment)
		) {
			newCursor += next.value.segment.length;
			next = iterator.next();
		}
	}

	return newCursor;
}
