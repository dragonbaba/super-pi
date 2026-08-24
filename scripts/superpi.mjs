#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const bundledConfigDir = join(repositoryRoot, ".sp");
const bundledSettingsDir = join(bundledConfigDir, "config");
const cliPath = join(repositoryRoot, "packages", "coding-agent", "dist", "cli.js");
const packageCommands = new Set(["auth", "config", "install", "list", "remove", "uninstall", "update"]);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function appendResource(args, flag, path) {
	if (!existsSync(path)) {
		throw new Error(`Bundled Super Pi resource is missing: ${path}. Run npm run build:offline first.`);
	}
	args.push(flag, path);
}

function bundledArguments() {
	const args = [];
	const settings = readJson(join(bundledSettingsDir, "settings.json"));
	for (const packageSource of settings.packages ?? []) {
		if (typeof packageSource !== "string") {
			throw new Error("Bundled Super Pi settings only support local string package paths.");
		}
		const packageDir = resolve(bundledSettingsDir, packageSource);
		const manifest = readJson(join(packageDir, "package.json"));
		for (const extension of manifest.pi?.extensions ?? []) {
			appendResource(args, "--extension", resolve(packageDir, extension));
		}
		for (const skill of manifest.pi?.skills ?? []) {
			appendResource(args, "--skill", resolve(packageDir, skill));
		}
		for (const prompt of manifest.pi?.prompts ?? []) {
			appendResource(args, "--prompt-template", resolve(packageDir, prompt));
		}
	}

	const directExtensionsDir = join(bundledConfigDir, "extensions");
	if (existsSync(directExtensionsDir)) {
		for (const entry of readdirSync(directExtensionsDir, { withFileTypes: true })) {
			if (entry.isFile() && /\.(?:js|ts)$/u.test(entry.name)) {
				appendResource(args, "--extension", join(directExtensionsDir, entry.name));
			}
		}
	}
	for (const [directory, flag] of [["skills", "--skill"], ["prompts", "--prompt-template"]]) {
		const path = join(bundledConfigDir, directory);
		if (existsSync(path)) appendResource(args, flag, path);
	}
	return args;
}

if (!existsSync(cliPath)) {
	throw new Error(`Super Pi CLI is not built: ${cliPath}. Run npm run build:offline first.`);
}

const userArgs = process.argv.slice(2);
const firstArgument = userArgs.find((argument) => !argument.startsWith("-"));
if (!firstArgument || !packageCommands.has(firstArgument)) {
	process.argv.splice(2, 0, ...bundledArguments());
}

process.env.SP_SOURCE_LAUNCHER = fileURLToPath(import.meta.url);
process.env.SP_BUNDLED_AGENTS_DIR = join(bundledConfigDir, "agents");
process.argv[1] = cliPath;
await import(pathToFileURL(cliPath).href);
