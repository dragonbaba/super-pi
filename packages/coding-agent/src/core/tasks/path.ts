import * as path from "node:path";

function comparable(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Lexical containment for already canonical workspace reservations; does not resolve symlinks. */
export function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(comparable(root), comparable(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
