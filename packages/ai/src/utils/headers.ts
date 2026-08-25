import type { ProviderHeaders } from "../types.ts";
import { setOwnProperty } from "./record.ts";

const HEADER_NAME_MAP_POOL: Map<string, string>[] = [];
const MAX_POOLED_HEADER_NAME_MAPS = 4;
const MAX_POOLED_HEADER_NAMES = 256;

function acquireHeaderNameMap(): Map<string, string> {
	return HEADER_NAME_MAP_POOL.pop() ?? new Map<string, string>();
}

function releaseHeaderNameMap(value: Map<string, string>): void {
	const retain = value.size <= MAX_POOLED_HEADER_NAMES && HEADER_NAME_MAP_POOL.length < MAX_POOLED_HEADER_NAME_MAPS;
	value.clear();
	if (retain) HEADER_NAME_MAP_POOL.push(value);
}

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		setOwnProperty(result, key, value);
	}
	return result;
}

export function providerHeadersToRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) setOwnProperty(result, key, value);
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Merge case-insensitive provider headers without mutating either input. */
export function mergeProviderHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const result: ProviderHeaders = {};
	const overrideNames = override ? Object.keys(override) : undefined;
	const canonicalOverrides = acquireHeaderNameMap();
	try {
		for (let index = 0; index < (overrideNames?.length ?? 0); index++) {
			const name = overrideNames![index]!;
			canonicalOverrides.set(name.toLowerCase(), name);
		}
		if (base) {
			const baseNames = Object.keys(base);
			for (let index = 0; index < baseNames.length; index++) {
				const name = baseNames[index]!;
				if (!canonicalOverrides.has(name.toLowerCase())) setOwnProperty(result, name, base[name]!);
			}
		}
		for (let index = 0; index < (overrideNames?.length ?? 0); index++) {
			const name = overrideNames![index]!;
			if (canonicalOverrides.get(name.toLowerCase()) === name) {
				setOwnProperty(result, name, override![name]!);
			}
		}
		return result;
	} finally {
		releaseHeaderNameMap(canonicalOverrides);
	}
}
