import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function commandExists(
	command: string,
	cwd = process.cwd(),
	pathValue = process.env.PATH ?? "",
) {
	return resolveCommandPath(command, cwd, process.platform, pathValue) !== undefined;
}

export function commandPathValue(
	env: Record<string, string> | undefined,
	platform: NodeJS.Platform = process.platform,
) {
	return (
		environmentValue(env, "PATH", platform) ?? environmentValue(process.env, "PATH", platform) ?? ""
	);
}

export function mergeEnvironment(
	overrides: Record<string, string> | undefined,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform !== "win32") {
		return { ...process.env, ...overrides };
	}

	const environment: NodeJS.ProcessEnv = {};
	const overrideKeys = overrides ? Object.keys(overrides) : undefined;
	const environmentKeys = Object.keys(process.env);
	for (let environmentIndex = 0; environmentIndex < environmentKeys.length; environmentIndex++) {
		const existingKey = environmentKeys[environmentIndex]!;
		let overridden = false;
		for (let overrideIndex = 0; overrideIndex < (overrideKeys?.length ?? 0); overrideIndex++) {
			const overrideKey = overrideKeys![overrideIndex]!;
			if (existingKey.toLowerCase() === overrideKey.toLowerCase()) {
				overridden = true;
				break;
			}
		}
		if (!overridden) environment[existingKey] = process.env[existingKey];
	}
	for (let index = 0; index < (overrideKeys?.length ?? 0); index++) {
		const key = overrideKeys![index]!;
		environment[key] = overrides![key];
	}
	return environment;
}

function environmentValue(
	environment: NodeJS.ProcessEnv | Record<string, string> | undefined,
	name: string,
	platform: NodeJS.Platform,
) {
	if (platform !== "win32") return environment?.[name];
	let value: string | undefined;
	for (const [key, candidate] of Object.entries(environment ?? {})) {
		if (key.toLowerCase() === name.toLowerCase()) value = candidate;
	}
	return value;
}

export function resolveCommandPath(
	command: string,
	cwd = process.cwd(),
	platform: NodeJS.Platform = process.platform,
	pathValue = process.env.PATH ?? "",
) {
	const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	if (command.includes("/") || command.includes("\\")) {
		const commandPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
		return resolveRunnableFile(commandPath, extensions, platform);
	}

	for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
		const resolved = resolveRunnableFile(
			path.resolve(cwd, directory || ".", command),
			extensions,
			platform,
		);
		if (resolved) return resolved;
	}

	return undefined;
}

function resolveRunnableFile(filePath: string, extensions: string[], platform: NodeJS.Platform) {
	for (const extension of extensions) {
		const candidate = `${filePath}${extension}`;
		if (isRunnableFile(candidate, platform)) return candidate;
	}
	return undefined;
}

function isRunnableFile(filePath: string, platform: NodeJS.Platform) {
	if (!existsSync(filePath)) return false;
	try {
		if (!statSync(filePath).isFile()) return false;
		if (platform !== "win32") accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
