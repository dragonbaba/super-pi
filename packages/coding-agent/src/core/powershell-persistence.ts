import { statSync } from "node:fs";
import {
	getPowerShellCandidateConfig,
	POWERSHELL_ARGS,
	type PowerShellConfig,
} from "../utils/shell.ts";
import type { PowerShellToolState } from "./tools/powershell.ts";
import type { PowerShellStatusSettings, SettingsManager } from "./settings-manager.ts";

const POWERSHELL_PATH_TRUST_VERSION = 1 as const;

export interface PowerShellPersistenceDependencies {
	pathExists?: (path: string) => boolean;
	resolveCandidate?: (powershellPath?: string) => PowerShellConfig;
}

function defaultPathExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function pathsEqual(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function statusFromConfig(
	settingsManager: SettingsManager,
	config: PowerShellConfig,
	available: boolean,
	verified: boolean,
): PowerShellStatusSettings {
	return {
		trustVersion: POWERSHELL_PATH_TRUST_VERSION,
		path: config.shell,
		available,
		verified,
		configuredPath: settingsManager.getPowerShellPath(),
		source: config.source,
		version: config.version,
		edition: config.edition,
	};
}

/**
 * Load and, only when necessary, validate the persisted PowerShell status.
 * This never launches PowerShell. A verified existing path is reused, while a
 * missing, new, or configuration-changed path is resolved and saved as pending.
 * The first real tool execution confirms usability and persists the outcome.
 */
export async function initializePowerShellPersistence(
	settingsManager: SettingsManager,
	options: { forceEnable?: boolean; dependencies?: PowerShellPersistenceDependencies } = {},
): Promise<boolean> {
	if (process.platform !== "win32") return false;
	const pathExists = options.dependencies?.pathExists ?? defaultPathExists;
	const resolveCandidate = options.dependencies?.resolveCandidate ?? getPowerShellCandidateConfig;
	const configuredPath = settingsManager.getPowerShellPath();
	const current = settingsManager.getPowerShellStatus();
	const configurationChanged = current !== undefined && !pathsEqual(current.configuredPath, configuredPath);
	const currentPathTrusted = current?.trustVersion === POWERSHELL_PATH_TRUST_VERSION;

	if (
		options.forceEnable &&
		currentPathTrusted &&
		!configurationChanged &&
		current?.path &&
		pathExists(current.path)
	) {
		await settingsManager.setPowerShellStatusDurably({
			...current,
			available: true,
			verified: false,
			configuredPath,
		});
		return true;
	}

	// An unavailable state is sticky. Changing the configured path alone must
	// not silently reactivate the tool; only an explicit enable starts a new
	// pending attempt.
	if (current && !current.available && !options.forceEnable) return false;
	if (currentPathTrusted && current && !configurationChanged) {
		if (current.path && pathExists(current.path)) return true;
	}

	let config: PowerShellConfig | undefined;
	try {
		config = resolveCandidate(configuredPath);
	} catch {
		await settingsManager.setPowerShellStatusDurably({
			trustVersion: POWERSHELL_PATH_TRUST_VERSION,
			path: config?.shell ?? configuredPath,
			available: false,
			verified: true,
			configuredPath,
			source: config?.source,
			version: config?.version,
			edition: config?.edition,
		});
		return false;
	}
	await settingsManager.setPowerShellStatusDurably(statusFromConfig(settingsManager, config, true, false));
	return true;
}

export function hydratePowerShellToolState(settingsManager: SettingsManager, state: PowerShellToolState): void {
	const configuredPath = settingsManager.getPowerShellPath();
	state.configure(configuredPath);
	const status = settingsManager.getPowerShellStatus();
	if (!status) return;
	if (!status.available) {
		state.disable("PowerShell is marked unavailable in global configuration. Explicitly enable the tool to try again.");
		return;
	}
	if (status.trustVersion !== POWERSHELL_PATH_TRUST_VERSION) return;
	if (!status.path) return;
	state.config = {
		shell: status.path,
		args: POWERSHELL_ARGS,
		source: status.source ?? "configured",
		version: status.version,
		edition: status.edition,
	};
	state.confirmed = status.verified;
}

export async function persistPowerShellConfirmed(settingsManager: SettingsManager, config: PowerShellConfig): Promise<void> {
	await settingsManager.setPowerShellStatusDurably(statusFromConfig(settingsManager, config, true, true));
}

export async function persistPowerShellUnavailable(
	settingsManager: SettingsManager,
	config?: PowerShellConfig,
): Promise<void> {
	const current = settingsManager.getPowerShellStatus();
	const currentPathTrusted = current?.trustVersion === POWERSHELL_PATH_TRUST_VERSION;
	await settingsManager.setPowerShellStatusDurably({
		trustVersion: config || currentPathTrusted ? POWERSHELL_PATH_TRUST_VERSION : undefined,
		path: config?.shell ?? (currentPathTrusted ? current.path : settingsManager.getPowerShellPath()),
		available: false,
		verified: true,
		configuredPath: settingsManager.getPowerShellPath(),
		source: config?.source ?? (currentPathTrusted ? current.source : undefined),
		version: config?.version,
		edition: config?.edition,
	});
}

export function persistPowerShellPending(settingsManager: SettingsManager): void {
	const current = settingsManager.getPowerShellStatus();
	settingsManager.setPowerShellStatus({
		...current,
		path: current?.path ?? settingsManager.getPowerShellPath(),
		available: true,
		verified: false,
		configuredPath: settingsManager.getPowerShellPath(),
	});
}
