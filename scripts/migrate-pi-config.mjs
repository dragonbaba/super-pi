#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
	throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
}

const sourceDir = join(homedir(), ".pi", "agent");
const targetAgentDir = join(homedir(), ".sp", "agent");
const targetDir = join(targetAgentDir, "config");

const configFiles = [
	["settings.json", "settings.json", stripPiPackages],
	["auth.json", "auth.json"],
	["models.json", "models.json"],
	["trust.json", "trust.json"],
	["auxiliary-vision.json", "auxiliary-vision.json"],
	["hermes-memory-config.json", "hermes-memory-config.json"],
	["mcp.json", "mcp.json"],
	["pi-chrome-devtools.json", "sp-chrome-devtools.json"],
	["pi-goal.json", "pi-goal.json"],
	["pi-lsp.json", "pi-lsp.json"],
	["pi-openai-fast.json", "pi-openai-fast.json"],
	["pi-plan-mode.json", "sp-plan-mode.json"],
	["pi-statusline.json", "pi-statusline.json"],
	["subagent-models.json", "subagent-models.json"],
];

function stripPiPackages(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { packages: _piPackages, ...settings } = value;
	return settings;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutObsoleteUpdateState(value) {
	if (!isRecord(value)) return value;
	const { lastUpdateNotificationVersion: _obsoleteUpdateState, ...settings } = value;
	return settings;
}

function valueShape(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value === "object" ? "object" : typeof value;
}

function sameCredentialStructure(source, target) {
	if (valueShape(source) !== valueShape(target)) return false;
	if (Array.isArray(source)) {
		return source.every((sourceValue, index) => index < target.length && sameCredentialStructure(sourceValue, target[index]));
	}
	if (isRecord(source)) {
		return hasSourceRecordEntries(source, target, sameCredentialStructure);
	}
	return true;
}

function hasSourceRecordEntries(source, target, compareValues) {
	if (!isRecord(source) || !isRecord(target)) return false;
	return Object.entries(source).every(([key, sourceValue]) =>
		Object.hasOwn(target, key) && compareValues(sourceValue, target[key]),
	);
}

function isCheckEquivalent(entry) {
	if (!entry.target) return false;
	switch (entry.targetName) {
		case "settings.json":
			return isRecord(entry.target.value) && !Object.hasOwn(entry.target.value, "packages") && isDeepStrictEqual(
				withoutObsoleteUpdateState(entry.value),
				withoutObsoleteUpdateState(entry.target.value),
			);
		case "auth.json":
			// Provider tokens can refresh independently after migration. Verify that
			// every migrated credential slot still exists with the same container
			// shape without comparing or printing credential values.
			return sameCredentialStructure(entry.value, entry.target.value);
		case "trust.json":
			// Super Pi accumulates its own trusted projects. Existing Pi trust
			// decisions must remain intact, while additional target entries are valid.
			return hasSourceRecordEntries(entry.value, entry.target.value, isDeepStrictEqual);
		default:
			return isDeepStrictEqual(entry.value, entry.target.value);
	}
}

async function readJsonIfPresent(path) {
	const raw = await readTextIfPresent(path);
	if (raw === undefined) return undefined;
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON: ${path}: ${error.message}`, { cause: error });
	}
	return { raw, value };
}

async function readTextIfPresent(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

try {
	const sourceStats = await stat(sourceDir);
	if (!sourceStats.isDirectory()) throw new Error(`Pi config source is not a directory: ${sourceDir}`);
} catch (error) {
	if (error?.code === "ENOENT") throw new Error(`Pi config source does not exist: ${sourceDir}`);
	throw error;
}

const entries = [];
for (const [sourceName, targetName, transform] of configFiles) {
	const sourcePath = join(sourceDir, sourceName);
	const source = await readJsonIfPresent(sourcePath);
	if (!source) continue;
	const value = transform ? transform(source.value) : source.value;
	const content = transform ? `${JSON.stringify(value, null, 2)}\n` : source.raw;
	const targetPath = join(targetDir, targetName);
	const target = await readJsonIfPresent(targetPath);
	entries.push({ sourceName, targetName, targetPath, value, content, target });
}

const contextSource = await readTextIfPresent(join(sourceDir, "AGENTS.md"));
if (contextSource !== undefined) {
	const targetPath = join(targetAgentDir, "AGENTS.md");
	const targetContent = await readTextIfPresent(targetPath);
	entries.push({
		sourceName: "AGENTS.md",
		targetName: "AGENTS.md",
		targetPath,
		value: contextSource,
		content: contextSource,
		target: targetContent === undefined ? undefined : { value: targetContent },
	});
}

if (entries.length === 0) throw new Error(`No supported Pi configuration files found in ${sourceDir}`);

const conflicts = entries.filter((entry) =>
	entry.target && !(checkOnly ? isCheckEquivalent(entry) : isDeepStrictEqual(entry.value, entry.target.value)),
);
if (conflicts.length > 0) {
	for (const entry of conflicts) console.error(`conflict ${entry.targetName}`);
	throw new Error("Existing Super Pi configuration differs; refusing to overwrite it.");
}

if (checkOnly) {
	const missing = entries.filter((entry) => !entry.target);
	for (const entry of entries) console.log(`${entry.target ? "verified" : "missing"} ${entry.targetName}`);
	if (missing.length > 0) {
		throw new Error(`${missing.length} supported configuration/context file(s) have not been migrated.`);
	}
	console.log(`Verified ${entries.length} configuration/context file(s) under ${targetAgentDir}`);
	process.exit(0);
}

await mkdir(targetDir, { recursive: true });
let created = 0;
for (const entry of entries) {
	if (entry.target) {
		console.log(`unchanged ${entry.targetName}`);
		continue;
	}
	await writeFile(entry.targetPath, entry.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	created++;
	console.log(`created ${entry.targetName}`);
}
console.log(`Migrated ${created} configuration/context file(s); ${entries.length - created} already matched.`);
console.log(`Source left unchanged: ${sourceDir}`);
