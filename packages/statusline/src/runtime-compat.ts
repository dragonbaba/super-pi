import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.js";

export const SUPPORTED_SP_LINE = "1.x or 0.84.x";

export type RuntimeCompatibility =
	| { compatible: true; version: string }
	| { compatible: false; version?: string; reason: string };

export function checkRuntimeCompatibility(version: unknown): RuntimeCompatibility {
	if (typeof version !== "string" || version.trim() === "") {
		return {
			compatible: false,
			reason: `Pi runtime version is unavailable; pi-statusline is disabled (requires ${SUPPORTED_SP_LINE}).`,
		};
	}
	const normalized = version.trim();
	if (!SUPPORTED_SP_VERSION_PATTERN.test(normalized)) {
		return {
			compatible: false,
			version: normalized,
			reason: `Pi ${normalized} is unsupported; pi-statusline is disabled (requires ${SUPPORTED_SP_LINE}).`,
		};
	}
	return { compatible: true, version: normalized };
}
