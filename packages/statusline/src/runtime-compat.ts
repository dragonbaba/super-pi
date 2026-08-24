import * as fs from "node:fs";
import * as path from "node:path";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.js";

export const SUPPORTED_SP_LINE = "0.84.x";
const SP_PACKAGE_NAME = "@super-pi/coding-agent";

export function discoverPiRuntimeVersion(entryPath: unknown = process.argv[1]): string | undefined {
	if (typeof entryPath !== "string" || entryPath.trim() === "") return undefined;
	let current = path.resolve(entryPath);
	try {
		if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
	} catch {
		current = path.dirname(current);
	}
	while (true) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (manifest.name === SP_PACKAGE_NAME) {
				return typeof manifest.version === "string" ? manifest.version : undefined;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

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
