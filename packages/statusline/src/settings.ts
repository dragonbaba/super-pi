import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-runtime-lite.js";
import { segmentPaletteForPreset } from "./presets/index.js";
import { HEX_COLOR_PATTERN, LINE_SEPARATOR_PATTERN } from "./regex.js";
import { sanitizeTerminalText, unknownTerminalText } from "./terminal-text.js";
import {
	type ConfigSegmentName,
	DENSITIES,
	LINE_BREAK_SEGMENT_NAME,
	PALETTE_NAMES,
	PALETTE_PRESET_NAMES,
	type PaletteName,
	SEGMENT_NAMES,
	SEPARATOR_NAMES,
	type SegmentName,
	type SegmentPalette,
	type StatuslineConfig,
	TRUNCATION_DIRECTIONS,
} from "./types.js";

export const SETTINGS_FILE_NAME = "pi-statusline.json";
const LEGACY_SETTINGS_FILE_NAME = "pi-statusline-settings.json";

export const DEFAULT_EXTENSION_STATUS_ICONS: Record<string, string> = {
	accounts: "👤",
	caffeinate: "💊",
	"chrome-devtools": "🌐",
	firecrawl: "🔥",
	"github-pr": "🔎",
	goal: "🎯",
	"google-genai": "✨",
	lsp: "🧰",
	"plan-mode": "📝",
	retry: "🔁",
	subagents: "🧑‍🤝‍🧑",
	sync: "🔄",
	usage: "📊",
	"codex-usage": "📊",
	pisync: "🔄",
	"unknown-error-retry": "🔁",
};

const LEGACY_STATUS_ICON_KEYS = {
	pisync: "sync",
	"unknown-error-retry": "retry",
} as const;

const DEFAULT_SEGMENTS: SegmentName[] = [
	"model", "thinking", "cwd", "branch", "tools", "context", "time",
];

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
	palettePreset: "tokyo-night",
	palette: segmentPaletteForPreset("tokyo-night"),
	density: "compact",
	separator: "none",
	segments: DEFAULT_SEGMENTS,
	segmentText: {
		brand: { prefix: "", suffix: "" },
		provider: { prefix: "🔌 ", suffix: "" },
		model: {
			prefix: "🤖 ",
			suffix: "",
			truncationLength: 36,
			truncationSymbol: "…",
			truncationDirection: "start",
		},
		thinking: { prefix: "🧠 ", suffix: "" },
		cwd: { prefix: "📁 ", suffix: "" },
		branch: { prefix: "🌿 ", suffix: "" },
		tools: { prefix: "", suffix: "" },
		context: { prefix: "🪟 ctx ", suffix: "" },
		tokens: { prefix: "🔢 ", suffix: "" },
		cache: { prefix: "📦 ", suffix: "" },
		cost: { prefix: "💸 $", suffix: "" },
		speed: { prefix: "⚡ ", suffix: "" },
		time: { prefix: "🕒 ", suffix: "" },
		turn: { prefix: "🔁 #", suffix: "" },
	},
	extensionStatusIcons: DEFAULT_EXTENSION_STATUS_ICONS,
};

export interface StatuslineConfigDiagnostic {
	severity: "warning" | "error";
	code: "unknown" | "invalid" | "parse" | "io";
	path: string;
	message: string;
}

export interface LoadedStatuslineSettings {
	config: StatuslineConfig;
	source: "built-in" | "user";
	settingsPath: string;
	rawDocument?: string;
	diagnostics: StatuslineConfigDiagnostic[];
}

let pendingSettingsNotice: string | undefined;

export function settingsFilePath(agentDir = getAgentDir()): string {
	return join(agentDir, SETTINGS_FILE_NAME);
}

export function createDefaultConfig(): StatuslineConfig {
	return cloneConfig(DEFAULT_STATUSLINE_CONFIG);
}

export function normalizeStatuslineConfig(value: unknown): {
	config: StatuslineConfig;
	diagnostics: StatuslineConfigDiagnostic[];
} {
	const config = createDefaultConfig();
	const diagnostics: StatuslineConfigDiagnostic[] = [];
	if (!isRecord(value)) {
		return {
			config,
			diagnostics: [invalidDiagnostic("", "Settings must contain a JSON object", "error")],
		};
	}
	const knownRoot = new Set([
		"palettePreset",
		"palette",
		"density",
		"separator",
		"segments",
		"segmentText",
		"extensionStatusIcons",
	]);
	for (const key of Object.keys(value)) {
		if (!knownRoot.has(key)) diagnostics.push(unknownDiagnostic(key));
	}

	normalizePalette(value.palette, config, diagnostics);
	normalizeEnum(value, "palettePreset", PALETTE_PRESET_NAMES, config, diagnostics);
	if (!isRecord(value.palette) && isPaletteName(config.palettePreset)) {
		config.palette = segmentPaletteForPreset(config.palettePreset);
	}
	normalizeEnum(value, "density", DENSITIES, config, diagnostics);
	normalizeEnum(value, "separator", SEPARATOR_NAMES, config, diagnostics);

	if (value.segments !== undefined) {
		if (!Array.isArray(value.segments)) {
			diagnostics.push(invalidDiagnostic("segments", "Expected an array of segment names"));
		} else {
			const segments: ConfigSegmentName[] = [];
			const seen = new Set<SegmentName>();
			for (const [index, item] of value.segments.entries()) {
				const path = `segments[${index}]`;
				if (typeof item !== "string" || !isConfigSegmentName(item)) {
					diagnostics.push(invalidDiagnostic(path, "Unknown or non-string segment name"));
					continue;
				}
				if (item === LINE_BREAK_SEGMENT_NAME) {
					if (segments.at(-1) === LINE_BREAK_SEGMENT_NAME) {
						diagnostics.push(
							invalidDiagnostic(path, "Consecutive line_break segments are not allowed"),
						);
						continue;
					}
					segments.push(item);
					continue;
				}
				if (seen.has(item)) {
					diagnostics.push(invalidDiagnostic(path, `Duplicate segment ${JSON.stringify(item)}`));
					continue;
				}
				seen.add(item);
				segments.push(item);
			}
			config.segments = segments;
		}
	}

	if (value.segmentText !== undefined) {
		if (!isRecord(value.segmentText)) {
			diagnostics.push(invalidDiagnostic("segmentText", "Expected an object"));
		} else {
			for (const [name, presentation] of Object.entries(value.segmentText)) {
				const path = `segmentText.${name}`;
				if (!isSegmentName(name)) {
					diagnostics.push(unknownDiagnostic(path));
					continue;
				}
				if (!isRecord(presentation)) {
					diagnostics.push(invalidDiagnostic(path, "Expected an object"));
					continue;
				}
				const knownFields = new Set([
					"prefix",
					"suffix",
					...(name === "model"
						? ["truncationLength", "truncationSymbol", "truncationDirection"]
						: []),
				]);
				for (const key of Object.keys(presentation)) {
					if (!knownFields.has(key)) diagnostics.push(unknownDiagnostic(`${path}.${key}`));
				}
				for (const field of ["prefix", "suffix"] as const) {
					const fieldValue = presentation[field];
					if (fieldValue === undefined) continue;
					if (!isSafeSegmentText(fieldValue, `${path}.${field}`, diagnostics)) continue;
					config.segmentText[name][field] = fieldValue;
				}
				if (name === "model") {
					normalizeModelTruncation(presentation, config, diagnostics);
				}
			}
		}
	}

	if (value.extensionStatusIcons !== undefined) {
		if (!isRecord(value.extensionStatusIcons)) {
			diagnostics.push(invalidDiagnostic("extensionStatusIcons", "Expected an object"));
		} else {
			for (const [key, icon] of Object.entries(value.extensionStatusIcons)) {
				if (typeof icon !== "string") {
					diagnostics.push(invalidDiagnostic(`extensionStatusIcons.${key}`, "Expected a string"));
					continue;
				}
				const safeIcon = sanitizeTerminalText(icon, 16);
				if (safeIcon !== icon) {
					diagnostics.push(
						invalidDiagnostic(
							`extensionStatusIcons.${key}`,
							"Terminal controls are not allowed and icons are limited to 16 characters",
						),
					);
				}
				Object.defineProperty(config.extensionStatusIcons, key, {
					value: safeIcon,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_STATUS_ICON_KEYS)) {
				const legacyIcon = Object.hasOwn(value.extensionStatusIcons, legacyKey)
					? value.extensionStatusIcons[legacyKey]
					: undefined;
				const canonicalIcon = Object.hasOwn(value.extensionStatusIcons, canonicalKey)
					? value.extensionStatusIcons[canonicalKey]
					: undefined;
				const targetKey = typeof canonicalIcon === "string" ? legacyKey : canonicalKey;
				const inheritedIcon =
					typeof canonicalIcon === "string"
						? sanitizeTerminalText(canonicalIcon, 16)
						: typeof legacyIcon === "string"
							? sanitizeTerminalText(legacyIcon, 16)
							: undefined;
				if (inheritedIcon === undefined) continue;
				Object.defineProperty(config.extensionStatusIcons, targetKey, {
					value: inheritedIcon,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
	}

	return { config, diagnostics };
}

export function loadStatuslineSettings(settingsPath: string): LoadedStatuslineSettings {
	let rawDocument: string;
	try {
		rawDocument = readFileSync(settingsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !pathExists(settingsPath)) {
			return builtInSettings(settingsPath);
		}
		return builtInSettings(settingsPath, [
			diagnostic("error", "io", "", `Unable to read settings: ${formatError(error)}`),
		]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDocument);
	} catch (error) {
		return {
			...builtInSettings(settingsPath, [
				diagnostic("error", "parse", "", `Unable to parse JSON: ${formatError(error)}`),
			]),
			rawDocument,
		};
	}
	const normalized = normalizeStatuslineConfig(parsed);
	return {
		config: normalized.config,
		source: normalized.diagnostics.some((item) => item.severity === "error") ? "built-in" : "user",
		settingsPath,
		rawDocument,
		diagnostics: normalized.diagnostics,
	};
}

export function loadStatuslineSettingsForAgent(agentDir = getAgentDir()): LoadedStatuslineSettings {
	pendingSettingsNotice = undefined;
	const canonicalPath = settingsFilePath(agentDir);
	const legacyPath = join(agentDir, LEGACY_SETTINGS_FILE_NAME);
	const canonical = loadStatuslineSettings(canonicalPath);
	if (!isMissingStatuslineSettings(canonical)) {
		if (!isMissingStatuslineSettings(loadStatuslineSettings(legacyPath))) {
			pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} ignored because ${SETTINGS_FILE_NAME} takes precedence.`;
		}
		return canonical;
	}
	const legacy = loadStatuslineSettings(legacyPath);
	return isMissingStatuslineSettings(legacy)
		? canonical
		: migrateLegacySettings(canonicalPath, legacy);
}

function migrateLegacySettings(
	canonicalPath: string,
	legacy: LoadedStatuslineSettings,
): LoadedStatuslineSettings {
	const racedCanonical = loadStatuslineSettings(canonicalPath);
	if (!isMissingStatuslineSettings(racedCanonical)) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} ignored because ${SETTINGS_FILE_NAME} was created concurrently.`;
		return racedCanonical;
	}
	if (
		legacy.source !== "user" ||
		legacy.rawDocument === undefined ||
		blockingDiagnostics(legacy.diagnostics).length > 0
	) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE_NAME} is invalid and was ignored.`;
		return legacy;
	}
	pendingSettingsNotice = `Using legacy ${LEGACY_SETTINGS_FILE_NAME}; rename it to ${SETTINGS_FILE_NAME}. The extension does not modify either file.`;
	return legacy;
}

function isMissingStatuslineSettings(settings: LoadedStatuslineSettings): boolean {
	return (
		settings.source === "built-in" &&
		settings.rawDocument === undefined &&
		settings.diagnostics.length === 0
	);
}

export function consumeStatuslineSettingsNotice(): string | undefined {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

function normalizePalette(
	value: unknown,
	config: StatuslineConfig,
	diagnostics: StatuslineConfigDiagnostic[],
) {
	if (value === undefined) return;
	if (typeof value === "string") {
		if (!(PALETTE_NAMES as readonly string[]).includes(value)) {
			diagnostics.push(
				invalidDiagnostic(
					"palette",
					`Expected a palette object or one of: ${PALETTE_NAMES.join(", ")}`,
				),
			);
			return;
		}
		config.palettePreset = value as (typeof PALETTE_NAMES)[number];
		return;
	}
	if (!isRecord(value)) {
		diagnostics.push(invalidDiagnostic("palette", "Expected a palette object"));
		return;
	}

	const palette: SegmentPalette = {};
	config.palette = palette;
	for (const [name, colors] of Object.entries(value)) {
		const path = `palette.${name}`;
		if (!isSegmentName(name)) {
			diagnostics.push(unknownDiagnostic(path));
			continue;
		}
		if (!isRecord(colors)) {
			diagnostics.push(invalidDiagnostic(path, "Expected an object"));
			continue;
		}
		const normalizedColors: NonNullable<SegmentPalette[SegmentName]> = {};
		palette[name] = normalizedColors;
		for (const [field, color] of Object.entries(colors)) {
			const colorPath = `${path}.${field}`;
			if (field !== "fg" && field !== "bg") {
				diagnostics.push(unknownDiagnostic(colorPath));
				continue;
			}
			if (typeof color !== "string" || !HEX_COLOR_PATTERN.test(color)) {
				diagnostics.push(invalidDiagnostic(colorPath, "Expected a full #RRGGBB hexadecimal color"));
				continue;
			}
			normalizedColors[field] = color.toLowerCase();
		}
	}
	config.palette = palette;
	config.palettePreset = "custom";
}

function normalizeModelTruncation(
	presentation: Record<string, unknown>,
	config: StatuslineConfig,
	diagnostics: StatuslineConfigDiagnostic[],
) {
	const path = "segmentText.model";
	const length = presentation.truncationLength;
	if (length !== undefined) {
		if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 1000) {
			diagnostics.push(
				invalidDiagnostic(`${path}.truncationLength`, "Expected an integer from 0 through 1000"),
			);
		} else config.segmentText.model.truncationLength = length;
	}

	const symbol = presentation.truncationSymbol;
	if (
		symbol !== undefined &&
		isSafeSegmentText(symbol, `${path}.truncationSymbol`, diagnostics, 16)
	) {
		config.segmentText.model.truncationSymbol = symbol;
	}

	const direction = presentation.truncationDirection;
	if (direction !== undefined) {
		if (
			typeof direction !== "string" ||
			!TRUNCATION_DIRECTIONS.includes(direction as (typeof TRUNCATION_DIRECTIONS)[number])
		) {
			diagnostics.push(
				invalidDiagnostic(
					`${path}.truncationDirection`,
					`Expected one of: ${TRUNCATION_DIRECTIONS.join(", ")}`,
				),
			);
		} else {
			config.segmentText.model.truncationDirection =
				direction as (typeof TRUNCATION_DIRECTIONS)[number];
		}
	}
}

function isSafeSegmentText(
	value: unknown,
	path: string,
	diagnostics: StatuslineConfigDiagnostic[],
	maxCharacters = 64,
): value is string {
	if (typeof value !== "string") {
		diagnostics.push(invalidDiagnostic(path, "Expected a string"));
		return false;
	}
	if (LINE_SEPARATOR_PATTERN.test(value)) {
		diagnostics.push(invalidDiagnostic(path, "Line breaks are not allowed; use line_break"));
		return false;
	}
	if (hasControlCharacter(value)) {
		diagnostics.push(invalidDiagnostic(path, "Control characters are not allowed"));
		return false;
	}
	if (sanitizeTerminalText(value, maxCharacters) !== value) {
		diagnostics.push(invalidDiagnostic(path, `Limited to ${maxCharacters} characters`));
		return false;
	}
	return true;
}

function normalizeEnum<
	K extends "palettePreset" | "density" | "separator",
	T extends StatuslineConfig[K],
>(
	value: Record<string, unknown>,
	field: K,
	accepted: readonly T[],
	config: StatuslineConfig,
	diagnostics: StatuslineConfigDiagnostic[],
) {
	const candidate = value[field];
	if (candidate === undefined) return;
	if (typeof candidate !== "string" || !accepted.includes(candidate as T)) {
		diagnostics.push(
			invalidDiagnostic(field, `Expected one of: ${accepted.map(String).join(", ")}`),
		);
		return;
	}
	config[field] = candidate as StatuslineConfig[K];
}

function cloneSegmentPalette(palette: SegmentPalette): SegmentPalette {
	return Object.fromEntries(
		Object.entries(palette).map(([name, colors]) => [name, { ...colors }]),
	) as SegmentPalette;
}

function cloneConfig(config: StatuslineConfig): StatuslineConfig {
	return {
		...config,
		palette: cloneSegmentPalette(config.palette),
		segments: [...config.segments],
		segmentText: Object.fromEntries(
			SEGMENT_NAMES.map((name) => [name, { ...config.segmentText[name] }]),
		) as StatuslineConfig["segmentText"],
		extensionStatusIcons: { ...config.extensionStatusIcons },
	};
}

function builtInSettings(
	settingsPath: string,
	diagnostics: StatuslineConfigDiagnostic[] = [],
): LoadedStatuslineSettings {
	return {
		config: createDefaultConfig(),
		source: "built-in",
		settingsPath,
		diagnostics,
	};
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigSegmentName(value: string): value is ConfigSegmentName {
	return value === LINE_BREAK_SEGMENT_NAME || isSegmentName(value);
}

function isPaletteName(value: StatuslineConfig["palettePreset"]): value is PaletteName {
	return (PALETTE_NAMES as readonly StatuslineConfig["palettePreset"][]).includes(value);
}

function isSegmentName(value: string): value is SegmentName {
	return (SEGMENT_NAMES as readonly string[]).includes(value);
}

function blockingDiagnostics(
	diagnostics: readonly StatuslineConfigDiagnostic[],
): StatuslineConfigDiagnostic[] {
	return diagnostics.filter((item) => item.code !== "unknown");
}

function unknownDiagnostic(path: string): StatuslineConfigDiagnostic {
	return diagnostic("warning", "unknown", path, `Unknown setting ${JSON.stringify(path)}`);
}

function invalidDiagnostic(
	path: string,
	message: string,
	severity: StatuslineConfigDiagnostic["severity"] = "warning",
): StatuslineConfigDiagnostic {
	return diagnostic(severity, "invalid", path, message);
}

function diagnostic(
	severity: StatuslineConfigDiagnostic["severity"],
	code: StatuslineConfigDiagnostic["code"],
	path: string,
	message: string,
): StatuslineConfigDiagnostic {
	return {
		severity,
		code,
		path: sanitizeTerminalText(path, 160),
		message: sanitizeTerminalText(message, 240),
	};
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : unknownTerminalText(error);
}
