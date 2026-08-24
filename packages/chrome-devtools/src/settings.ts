import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigDir } from "@super-pi/coding-agent";
import { CHROME_DEVTOOLS_TOOL_NAMES, type ChromeDevToolsToolName } from "./tool-names.js";

const NEW_SETTINGS_FILE_NAME = "sp-chrome-devtools.json";
const LEGACY_SETTINGS_FILE_NAME = "sp-chrome-devtools-settings.json";
export interface ChromeDevToolsSettings {
	tools: ChromeDevToolsToolName[];
	updatedAt: number;
}

export interface SettingsFileOperations {
	write(path: string, data: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
	write: (path, data) => writeFile(path, data, "utf8").then(() => undefined),
	rename,
};

export type SettingsLoadResult =
	| { kind: "missing"; notice?: string }
	| { kind: "invalid"; reason: string; notice?: string }
	| { kind: "loaded"; settings: ChromeDevToolsSettings; notice?: string };

export async function loadSettings(): Promise<SettingsLoadResult> {
	await settingsSaveQueue;
	const newPath = settingsFilePath();
	const newSettings = await readSettingsFile(newPath);
	if (newSettings.kind !== "missing") {
		return withLegacyIgnoredNotice(newSettings);
	}

	const legacyPath = legacySettingsFilePath();
	const legacySettings = await readSettingsFile(legacyPath);
	const concurrentlyCreatedSettings = await readSettingsFile(newPath);
	if (concurrentlyCreatedSettings.kind !== "missing") {
		return withLegacyIgnoredNotice(concurrentlyCreatedSettings);
	}
	if (legacySettings.kind === "missing") return { kind: "missing" };
	if (legacySettings.kind === "invalid") return legacySettings;

	return {
		...legacySettings,
		notice: `Using legacy ${LEGACY_SETTINGS_FILE_NAME}; rename it to ${NEW_SETTINGS_FILE_NAME}. Future saves write ${NEW_SETTINGS_FILE_NAME} without modifying the legacy file.`,
	};
}

interface SettingsDocumentResult {
	result: SettingsLoadResult;
	document?: Record<string, unknown>;
}

async function readSettingsDocument(filePath: string): Promise<SettingsDocumentResult> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { result: { kind: "missing" } };
		return { result: { kind: "invalid", reason: `${filePath}: ${formatError(error)}` } };
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const settings = normalizeChromeDevtoolsSettings(parsed);
		if (settings) {
			return {
				result: { kind: "loaded", settings },
				document: { ...(parsed as Record<string, unknown>) },
			};
		}
		return {
			result: {
				kind: "invalid",
				reason: `${filePath}: expected tools to be an array of Chrome DevTools tool names`,
			},
		};
	} catch (error) {
		return { result: { kind: "invalid", reason: `${filePath}: ${formatError(error)}` } };
	}
}

async function readSettingsFile(filePath: string): Promise<SettingsLoadResult> {
	return (await readSettingsDocument(filePath)).result;
}

async function withLegacyIgnoredNotice(settings: SettingsLoadResult): Promise<SettingsLoadResult> {
	if (!(await fileExists(legacySettingsFilePath()))) return settings;
	return {
		...settings,
		notice: `Chrome DevTools legacy settings ignored: ${legacySettingsFilePath()} exists, but ${settingsFilePath()} takes precedence. Delete ${LEGACY_SETTINGS_FILE_NAME} after confirming your settings.`,
	};
}

async function fileExists(filePath: string) {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function pathEntryExists(filePath: string) {
	try {
		await lstat(filePath);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

export function normalizeChromeDevtoolsSettings(
	value: unknown,
): ChromeDevToolsSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const settings = value as { tools?: unknown; updatedAt?: unknown };
	if (typeof settings.updatedAt !== "number") return undefined;

	if (settings.tools === "enabled") {
		return { tools: [...CHROME_DEVTOOLS_TOOL_NAMES], updatedAt: settings.updatedAt };
	}
	if (settings.tools === "disabled") return { tools: [], updatedAt: settings.updatedAt };

	if (!Array.isArray(settings.tools)) return undefined;
	if (!settings.tools.every(isChromeDevtoolsToolName)) return undefined;
	return { tools: orderedUniqueChromeDevtoolsTools(settings.tools), updatedAt: settings.updatedAt };
}

function isChromeDevtoolsToolName(value: unknown): value is ChromeDevToolsToolName {
	return typeof value === "string" && CHROME_DEVTOOLS_TOOL_NAMES.includes(value as never);
}

function orderedUniqueChromeDevtoolsTools(tools: readonly ChromeDevToolsToolName[]) {
	const selectedTools = new Set(tools);
	return CHROME_DEVTOOLS_TOOL_NAMES.filter((toolName) => selectedTools.has(toolName));
}

let settingsSaveQueue = Promise.resolve();

export function saveSettings(
	settings: ChromeDevToolsSettings,
	operations: Partial<SettingsFileOperations> = {},
): Promise<void> {
	const operation = settingsSaveQueue.then(() => saveSettingsNow(settings, operations));
	settingsSaveQueue = operation.catch(() => undefined);
	return operation;
}

async function saveSettingsNow(
	settings: ChromeDevToolsSettings,
	operations: Partial<SettingsFileOperations>,
): Promise<void> {
	const filePath = settingsFilePath();
	let current = await readSettingsDocument(filePath);
	const replaceCanonical = current.result.kind !== "missing";
	if (!replaceCanonical) current = await readSettingsDocument(legacySettingsFilePath());
	if (current.result.kind === "invalid") {
		throw new Error(
			`Cannot save Chrome DevTools settings until you repair ${current.result.reason}`,
		);
	}
	const nextDocument = {
		...(current.document ?? {}),
		tools: [...settings.tools],
		updatedAt: settings.updatedAt,
	};
	await mkdir(dirname(filePath), { recursive: true });
	const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
			tempFile,
			`${JSON.stringify(nextDocument, null, 2)}\n`,
		);
		if (!replaceCanonical && (await pathEntryExists(filePath))) {
			throw new Error(
				`${NEW_SETTINGS_FILE_NAME} was created concurrently; reopen settings and retry.`,
			);
		}
		await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(tempFile, filePath);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function settingsFilePath() {
	return join(getConfigDir(), NEW_SETTINGS_FILE_NAME);
}

function legacySettingsFilePath() {
	return join(getConfigDir(), LEGACY_SETTINGS_FILE_NAME);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
