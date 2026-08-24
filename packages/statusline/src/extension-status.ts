import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	Theme,
	ThemeColor,
} from "@super-pi/coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "./pi-runtime-lite.js";
import { wrapTextWithAnsi } from "@super-pi/tui";
import { powerlineExtensionSeparator } from "./powerline.js";
import {
	COMMA_SEPARATOR_PATTERN,
	EMOJI_ONLY_PATTERN,
	GLOBAL_WHITESPACE_PATTERN,
	MISSING_WORD_PATTERN,
	SP_PACKAGE_PREFIX_PATTERN,
	READY_WORD_PATTERN,
	SCOPED_PACKAGE_PREFIX_PATTERN,
	SUCCESS_STATUS_PATTERN,
	TRAILING_PARENTHETICAL_PATTERN,
	WARNING_STATUS_PATTERN,
	WHITESPACE_CHARACTER_PATTERN,
	WHITESPACE_PATTERN,
} from "./regex.js";
import { DEFAULT_EXTENSION_STATUS_ICONS } from "./settings.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { StatuslineConfig } from "./types.js";

export type ExtensionStatusIconAliasMap = ReadonlyMap<string, readonly string[]>;
export interface ExtensionStatusRuntime {
	duplicateExtensions: string[];
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
}

const STATUSLINE_KEY = "statusline";
const COMPATIBLE_STATUS_ICON_KEYS: Readonly<Record<string, string>> = {
	retry: "unknown-error-retry",
	sync: "pisync",
	"unknown-error-retry": "retry",
	pisync: "sync",
};
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();
const EMPTY_HIDDEN_STATUS_KEYS: ReadonlySet<string> = new Set();
function extensionStatusSeparator(config: StatuslineConfig, theme: Theme): string {
	return powerlineExtensionSeparator(theme, config.palettePreset);
}

export function formatExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	theme: Theme,
	config: StatuslineConfig,
	runtime: ExtensionStatusRuntime,
	hiddenKeys: ReadonlySet<string> = EMPTY_HIDDEN_STATUS_KEYS,
): string {
	const separator = extensionStatusSeparator(config, theme);
	const visibleStatuses = formatDuplicateExtensionStatus(runtime, theme);
	for (const [key, value] of statuses) {
		if (visibleStatuses.length >= 5) break;
		if (key === STATUSLINE_KEY || hiddenKeys.has(key) || value.trim().length === 0) continue;
		visibleStatuses.push(
			formatExtensionStatus(key, value, theme, config, runtime.extensionStatusIconAliases),
		);
	}
	return visibleStatuses.join(separator);
}

export function formatExtensionStatus(
	key: string,
	value: string,
	theme: Theme,
	config: Pick<StatuslineConfig, "extensionStatusIcons">,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap = EMPTY_EXTENSION_STATUS_ICON_ALIASES,
): string {
	const safeKey = sanitizeTerminalText(key, 64);
	const safeValue = sanitizeTerminalText(value);
	const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(safeKey, safeValue));
	const text = sanitizeTerminalText(simplifyExtensionStatusText(status.text));
	const color = extensionColor(safeKey, safeValue);
	const textColor = color === "warning" ? "warning" : "muted";
	const icon = extensionStatusIcon(
		key,
		status.icon,
		config.extensionStatusIcons,
		extensionStatusIconAliases,
	);
	const renderedText = theme.fg(textColor, text);
	const safeIcon = icon === undefined ? undefined : sanitizeTerminalText(icon, 16);
	return safeIcon ? `${theme.fg(color, safeIcon)} ${renderedText}` : renderedText;
}

function extensionStatusIcon(
	key: string,
	leadingIcon: string | undefined,
	configuredIcons: Record<string, string>,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
) {
	if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key];
	const namespaceIcon = configuredNamespaceIcon(key, configuredIcons);
	if (namespaceIcon !== undefined) return namespaceIcon;
	const compatibleKey = COMPATIBLE_STATUS_ICON_KEYS[key];
	if (compatibleKey && Object.hasOwn(configuredIcons, compatibleKey)) {
		return configuredIcons[compatibleKey];
	}
	for (const alias of extensionStatusAliasesForKey(key, extensionStatusIconAliases)) {
		if (Object.hasOwn(configuredIcons, alias)) return configuredIcons[alias];
	}
	return leadingIcon ?? DEFAULT_EXTENSION_STATUS_ICONS[key] ?? "🔌";
}

function configuredNamespaceIcon(
	key: string,
	configuredIcons: Readonly<Record<string, string>>,
): string | undefined {
	let match: { baseLength: number; icon: string } | undefined;
	for (const [selector, icon] of Object.entries(configuredIcons)) {
		if (!selector.endsWith(":*")) continue;
		const base = selector.slice(0, -2);
		if (!base || !key.startsWith(`${base}:`)) continue;
		if (!match || base.length > match.baseLength) match = { baseLength: base.length, icon };
	}
	return match?.icon;
}

function extensionStatusAliasesForKey(
	key: string,
	extensionStatusIconAliases: ExtensionStatusIconAliasMap,
): readonly string[] {
	for (const [statusBase, aliases] of extensionStatusIconAliases) {
		if (statusKeyMatchesStatusBase(key, statusBase)) return aliases;
	}
	return [];
}

function statusKeyMatchesStatusBase(key: string, statusBase: string): boolean {
	return key === statusBase || key.startsWith(`${statusBase}:`) || key.startsWith(`${statusBase}/`);
}

export function wrapExtensionStatusline(status: string, width: number): string[] {
	if (!status || width <= 0) return [];
	return wrapTextWithAnsi(status, width);
}

function formatDuplicateExtensionStatus(runtime: ExtensionStatusRuntime, theme: Theme): string[] {
	if (runtime.duplicateExtensions.length === 0) return [];
	const names = runtime.duplicateExtensions
		.slice(0, 2)
		.map((name) => sanitizeTerminalText(name, 64))
		.join(", ");
	const suffix =
		runtime.duplicateExtensions.length > 2 ? ` +${runtime.duplicateExtensions.length - 2}` : "";
	return [`${theme.fg("warning", "⚠️")} ${theme.fg("warning", `dup ${names}${suffix}`)}`];
}

export function splitExtensionStatusIcon(value: string): { icon?: string; text: string } {
	const trimmed = value.trim();
	const [firstToken, ...restTokens] = trimmed.split(WHITESPACE_PATTERN);
	if (firstToken && isEmojiOnlyToken(firstToken)) {
		return { icon: firstToken, text: restTokens.join(" ") };
	}
	return { text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
	return EMOJI_ONLY_PATTERN.test(value);
}

export function extensionColor(key: string, value: string): ThemeColor {
	const normalized = `${key} ${value}`.toLowerCase();
	if (WARNING_STATUS_PATTERN.test(normalized)) return "warning";
	if (normalized.includes("codex")) return "accent";
	if (SUCCESS_STATUS_PATTERN.test(normalized)) return "success";
	return "muted";
}

export function stripExtensionStatusPrefix(key: string, value: string): string {
	const trimmed = value.trim();
	if (trimmed.slice(0, key.length).toLowerCase() !== key.toLowerCase()) return trimmed;
	let cursor = key.length;
	while (cursor < trimmed.length && WHITESPACE_CHARACTER_PATTERN.test(trimmed[cursor] ?? "")) {
		cursor += 1;
	}
	if (trimmed[cursor] !== ":") return trimmed;
	cursor += 1;
	while (cursor < trimmed.length && WHITESPACE_CHARACTER_PATTERN.test(trimmed[cursor] ?? "")) {
		cursor += 1;
	}
	return trimmed.slice(cursor);
}

export function simplifyExtensionStatusText(value: string): string {
	return value
		.trim()
		.replace(READY_WORD_PATTERN, "✓")
		.replace(MISSING_WORD_PATTERN, "✗")
		.replace(COMMA_SEPARATOR_PATTERN, " ")
		.replace(TRAILING_PARENTHETICAL_PATTERN, "")
		.replace(GLOBAL_WHITESPACE_PATTERN, " ");
}

interface InstalledExtensionPackage {
	packageName: string;
	source: string;
	identity: string;
}

interface PackageDiscoveryFileSystem {
	existsSync(path: string): boolean;
	readFileSync(path: string, encoding: "utf8"): string;
}

export interface PackageDiscoveryOptions {
	projectTrusted: boolean;
	agentDir?: string;
	configDirName?: string;
	fileSystem?: PackageDiscoveryFileSystem;
}

export function readInstalledExtensionPackages(
	cwd: string,
	options: PackageDiscoveryOptions = { projectTrusted: false },
): InstalledExtensionPackage[] {
	const packages: InstalledExtensionPackage[] = [];
	const fileSystem = options.fileSystem ?? { existsSync, readFileSync };
	const settingsFiles = extensionSettingsFiles(cwd, options, fileSystem);

	for (const settingsFile of settingsFiles) {
		const baseDirectory = dirname(settingsFile);
		for (const rawSource of readPackageSources(settingsFile, fileSystem)) {
			const source = rawSource.trim();
			if (!source) continue;
			const packageName = packageNameForSource(source, baseDirectory, fileSystem);
			if (!packageName) continue;
			packages.push({
				packageName: sanitizeTerminalText(packageName, 128),
				source,
				identity: sourceIdentity(source, baseDirectory),
			});
		}
	}

	return packages;
}

function extensionSettingsFiles(
	cwd: string,
	options: PackageDiscoveryOptions,
	fileSystem: PackageDiscoveryFileSystem,
): string[] {
	const candidates = [join(options.agentDir ?? getAgentDir(), "settings.json")];
	if (options.projectTrusted) {
		candidates.push(join(cwd, options.configDirName ?? CONFIG_DIR_NAME, "settings.json"));
	}
	return candidates.filter((file) => fileSystem.existsSync(file));
}

export function findDuplicateExtensions(
	installedPackages: readonly InstalledExtensionPackage[],
): string[] {
	const sourcesByPackage = new Map<string, Set<string>>();

	for (const extensionPackage of installedPackages) {
		const sources = sourcesByPackage.get(extensionPackage.packageName) ?? new Set<string>();
		sources.add(extensionPackage.identity);
		sourcesByPackage.set(extensionPackage.packageName, sources);
	}

	return [...sourcesByPackage.entries()]
		.filter(([, sources]) => sources.size > 1)
		.map(([packageName]) => packageName.replace(SCOPED_PACKAGE_PREFIX_PATTERN, "").replace(SP_PACKAGE_PREFIX_PATTERN, ""));
}

export function buildExtensionStatusIconAliases(
	installedPackages: readonly { packageName: string; source?: string }[],
): Map<string, string[]> {
	const packageAliasesByStatusBase = new Map<string, Map<string, string[]>>();

	for (const extensionPackage of installedPackages) {
		const candidate = extensionStatusIconAliasCandidate(
			extensionPackage.packageName,
			extensionPackage.source,
		);
		if (!candidate) continue;
		const aliasesByPackage =
			packageAliasesByStatusBase.get(candidate.statusBase) ?? new Map<string, string[]>();
		const existingAliases = aliasesByPackage.get(extensionPackage.packageName) ?? [];
		aliasesByPackage.set(
			extensionPackage.packageName,
			uniqueStrings([...existingAliases, ...candidate.aliases]),
		);
		packageAliasesByStatusBase.set(candidate.statusBase, aliasesByPackage);
	}

	const aliases = new Map<string, string[]>();
	for (const [statusBase, aliasesByPackage] of packageAliasesByStatusBase) {
		if (aliasesByPackage.size === 1)
			aliases.set(statusBase, [...aliasesByPackage.values()][0] ?? []);
	}
	return aliases;
}

function extensionStatusIconAliasCandidate(
	packageName: string,
	source?: string,
): { statusBase: string; aliases: string[] } | undefined {
	const packageBase = packageBaseName(packageName);
	const statusBase = statusBaseFromPackageBase(packageBase);
	if (!statusBase) return undefined;

	const sourceAliases = source?.startsWith("npm:") ? [source, `npm:${npmPackageName(source)}`] : [];
	return {
		statusBase,
		aliases: uniqueStrings([...sourceAliases, packageName, packageBase, statusBase]),
	};
}

function packageBaseName(packageName: string): string {
	const slashIndex = packageName.lastIndexOf("/");
	return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}

function statusBaseFromPackageBase(packageBase: string): string {
	return packageBase.startsWith("pi-") && packageBase.length > "pi-".length
		? packageBase.slice("pi-".length)
		: packageBase;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function readPackageSources(
	settingsFile: string,
	fileSystem: PackageDiscoveryFileSystem,
): string[] {
	try {
		const settings = JSON.parse(fileSystem.readFileSync(settingsFile, "utf8")) as {
			packages?: unknown[];
		};
		return (settings.packages ?? [])
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (
					entry &&
					typeof entry === "object" &&
					typeof (entry as { source?: unknown }).source === "string"
				) {
					return (entry as { source: string }).source;
				}
				return undefined;
			})
			.filter((source): source is string => source !== undefined);
	} catch {
		return [];
	}
}

function packageNameForSource(
	source: string,
	baseDirectory: string,
	fileSystem: PackageDiscoveryFileSystem,
): string | undefined {
	if (source.startsWith("npm:")) return npmPackageName(source);
	const packageJson = join(resolveSourcePath(source, baseDirectory), "package.json");
	try {
		const packageData = JSON.parse(fileSystem.readFileSync(packageJson, "utf8")) as {
			name?: unknown;
		};
		return typeof packageData.name === "string" ? packageData.name : undefined;
	} catch {
		return undefined;
	}
}

export function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@");
	return spec.split("@")[0] ?? spec;
}

function sourceIdentity(source: string, baseDirectory: string): string {
	if (source.startsWith("npm:")) return `npm:${npmPackageName(source)}`;
	return resolveSourcePath(source, baseDirectory);
}

function resolveSourcePath(source: string, baseDirectory: string): string {
	return isAbsolute(source) ? source : resolve(baseDirectory, source);
}
