export const EMPTY_READONLY_ARRAY: readonly never[] = Object.freeze([]);

export function compareStrings(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0;
}
