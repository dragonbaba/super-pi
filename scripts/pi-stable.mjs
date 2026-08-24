#!/usr/bin/env node

import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageSegments = ["@earendil-works", "pi-coding-agent", "dist", "cli.js"];
const candidates = [
	process.env.SP_STABLE_PI_CLI ? resolve(process.env.SP_STABLE_PI_CLI) : undefined,
	join(dirname(process.execPath), "node_modules", ...packageSegments),
	join(dirname(dirname(process.execPath)), "lib", "node_modules", ...packageSegments),
	...((process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean).map((root) => join(root, ...packageSegments))),
].filter(Boolean);

const stableCliPath = candidates.find((candidate) => existsSync(candidate));
if (!stableCliPath) {
	throw new Error([
		"The retained stable Pi package was not found.",
		"Expected @earendil-works/pi-coding-agent to remain installed globally.",
		"Set SP_STABLE_PI_CLI to its dist/cli.js path if the global Node layout is non-standard.",
	].join(" "));
}

process.argv[1] = stableCliPath;
await import(pathToFileURL(stableCliPath).href);
