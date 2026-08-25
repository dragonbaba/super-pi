import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";
import { FORWARD_SLASH_PATTERN, LEGACY_WSL_BASH_PATH_PATTERN } from "./shell-regex.ts";

export interface ShellConfig {
	shell: string;
	args: readonly string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(FORWARD_SLASH_PATTERN, "\\").toLowerCase();
	return LEGACY_WSL_BASH_PATH_PATTERN.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function getFirstOutputLine(output: string): string | undefined {
	const trimmed = output.trim();
	if (!trimmed) return undefined;
	const carriageReturn = trimmed.indexOf("\r");
	const lineFeed = trimmed.indexOf("\n");
	if (carriageReturn < 0) return lineFeed < 0 ? trimmed : trimmed.slice(0, lineFeed);
	if (lineFeed < 0) return trimmed.slice(0, carriageReturn);
	return trimmed.slice(0, Math.min(carriageReturn, lineFeed));
}

function getPathEnvironmentValue(): string {
	const environmentKeys = Object.keys(process.env);
	for (let index = 0; index < environmentKeys.length; index++) {
		const key = environmentKeys[index]!;
		if (key.toLowerCase() === "path") return process.env[key] ?? "";
	}
	return "";
}

function isInsideCurrentWorkingDirectory(path: string): boolean {
	const normalizedPath = resolve(path).toLowerCase();
	const normalizedCwd = resolve(process.cwd()).toLowerCase();
	return normalizedPath === normalizedCwd || normalizedPath.startsWith(`${normalizedCwd}${sep}`);
}

function findExecutableOnWindowsPath(executable: string): string | null {
	const pathValue = getPathEnvironmentValue();
	let entryStart = 0;
	while (entryStart <= pathValue.length) {
		const separator = pathValue.indexOf(delimiter, entryStart);
		const entryEnd = separator < 0 ? pathValue.length : separator;
		let entry = pathValue.slice(entryStart, entryEnd).trim();
		if (entry.length >= 2 && entry.charCodeAt(0) === 0x22 && entry.charCodeAt(entry.length - 1) === 0x22) {
			entry = entry.slice(1, -1).trim();
		}
		if (entry && isAbsolute(entry)) {
			const candidate = resolve(join(entry, executable));
			// Windows executable discovery normally includes cwd. Never let an
			// untrusted project become a globally persisted shell installation.
			if (!isInsideCurrentWorkingDirectory(candidate) && isRegularFile(candidate)) return candidate;
		}
		if (separator < 0) break;
		entryStart = separator + delimiter.length;
	}
	return null;
}

function trustedSystemCandidate(path: string | undefined): string | undefined {
	if (!path || !isAbsolute(path)) return undefined;
	const candidate = resolve(path);
	return isInsideCurrentWorkingDirectory(candidate) ? undefined : candidate;
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		return findExecutableOnWindowsPath(executable);
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = getFirstOutputLine(result.stdout);
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		let searchedPaths = "";
		for (let index = 0; index < paths.length; index++) searchedPaths += `\n  ${paths[index]!}`;
		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:${searchedPaths}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

export interface PowerShellConfig extends ShellConfig {
	source: "configured" | "path-pwsh" | "standard-pwsh" | "path-windows-powershell" | "system-windows-powershell";
	version?: string;
	edition?: string;
}

const POWERSHELL_SOURCE_LABELS: Record<PowerShellConfig["source"], string> = {
	configured: "configured path",
	"path-pwsh": "PowerShell 7 on PATH",
	"standard-pwsh": "standard PowerShell 7 install",
	"path-windows-powershell": "Windows PowerShell on PATH",
	"system-windows-powershell": "system Windows PowerShell",
};

export function formatPowerShellConfig(config: PowerShellConfig): string {
	let identity = "PowerShell";
	if (config.version) identity += ` ${config.version}`;
	if (config.edition) identity += ` ${config.edition}`;
	return `${identity} (${config.shell}; ${POWERSHELL_SOURCE_LABELS[config.source]})`;
}

export function isLegacyWindowsPowerShell(config: PowerShellConfig): boolean {
	return config.edition === "Desktop" || config.source.includes("windows-powershell");
}

function probePowerShell(shell: string): (Pick<PowerShellConfig, "version" | "edition"> & { available: true }) | { available: false } {
	try {
		const result = spawnSync(
			shell,
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$v=$PSVersionTable.PSVersion.ToString();$e=$PSVersionTable.PSEdition;Write-Output ($v+'|'+$e)",
			],
			{ encoding: "utf-8", timeout: 5000, windowsHide: true },
		);
		if (result.status === 0 && result.stdout) {
			const identity = result.stdout.trim();
			const separator = identity.indexOf("|");
			if (separator > 0 && separator < identity.length - 1) {
				return {
					available: true,
					version: identity.slice(0, separator),
					edition: identity.slice(separator + 1),
				};
			}
		}
	} catch {
		// The caller either tries the next discovered candidate or reports the configured path.
	}
	return { available: false };
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function usablePowerShellConfig(shell: string | null | undefined, source: PowerShellConfig["source"]): PowerShellConfig | undefined {
	if (!shell || !isRegularFile(shell)) return undefined;
	const probe = probePowerShell(shell);
	if (!probe.available) return undefined;
	return { shell, args: POWERSHELL_ARGS, source, version: probe.version, edition: probe.edition };
}

function* powerShellCandidates(): Generator<readonly [string | null | undefined, PowerShellConfig["source"]]> {
	const programFiles = process.env.ProgramFiles;
	const systemRoot = process.env.SystemRoot;
	yield [
		trustedSystemCandidate(programFiles ? `${programFiles}\\PowerShell\\7\\pwsh.exe` : undefined),
		"standard-pwsh",
	];
	yield [findExecutableOnPath("pwsh.exe"), "path-pwsh"];
	yield [
		trustedSystemCandidate(
			systemRoot ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : undefined,
		),
		"system-windows-powershell",
	];
	yield [findExecutableOnPath("powershell.exe"), "path-windows-powershell"];
}

/** Resolve the preferred executable without starting it. The first real command confirms it. */
export function getPowerShellCandidateConfig(customPowerShellPath?: string): PowerShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}
	if (customPowerShellPath && !isRegularFile(customPowerShellPath)) {
		throw new Error(`Configured PowerShell path not found: ${customPowerShellPath}`);
	}
	if (customPowerShellPath) {
		return { shell: customPowerShellPath, args: POWERSHELL_ARGS, source: "configured" };
	}
	for (const [shell, source] of powerShellCandidates()) {
		if (shell && isRegularFile(shell)) return { shell, args: POWERSHELL_ARGS, source };
	}
	throw new Error("No PowerShell executable found. Install PowerShell 7 or configure powershellPath.");
}

/** Resolve PowerShell on Windows, preferring PowerShell 7 and honoring an explicit trusted path. */
export function getPowerShellConfig(customPowerShellPath?: string): PowerShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	if (customPowerShellPath) {
		if (!isRegularFile(customPowerShellPath)) {
			throw new Error(`Configured PowerShell path not found: ${customPowerShellPath}`);
		}
		const configured = usablePowerShellConfig(customPowerShellPath, "configured");
		if (!configured) throw new Error(`Configured PowerShell executable could not be started: ${customPowerShellPath}`);
		return configured;
	}

	for (const [shell, source] of powerShellCandidates()) {
		const config = usablePowerShellConfig(shell, source);
		if (config) return config;
	}
	throw new Error("No usable PowerShell executable found. Install PowerShell 7 or configure powershellPath.");
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	let pathKey = "PATH";
	const environmentKeys = Object.keys(process.env);
	for (let index = 0; index < environmentKeys.length; index++) {
		const key = environmentKeys[index]!;
		if (key.toLowerCase() !== "path") continue;
		pathKey = key;
		break;
	}
	const currentPath = process.env[pathKey] ?? "";
	let hasBinDir = false;
	let entryStart = 0;
	while (entryStart <= currentPath.length) {
		const separator = currentPath.indexOf(delimiter, entryStart);
		const entryEnd = separator < 0 ? currentPath.length : separator;
		if (currentPath.slice(entryStart, entryEnd) === binDir) {
			hasBinDir = true;
			break;
		}
		if (separator < 0) break;
		entryStart = separator + delimiter.length;
	}
	const updatedPath = hasBinDir ? currentPath : currentPath ? `${binDir}${delimiter}${currentPath}` : binDir;

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	let result = "";
	let cleanStart = 0;
	for (let index = 0; index < str.length; ) {
		const code = str.codePointAt(index)!;
		const codeUnitLength = code > 0xffff ? 2 : 1;
		const allowedControl = code === 0x09 || code === 0x0a || code === 0x0d;
		const disallowed =
			(!allowedControl && code <= 0x1f) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			(code >= 0xfff9 && code <= 0xfffb);
		if (disallowed) {
			if (cleanStart < index) result += str.slice(cleanStart, index);
			cleanStart = index + codeUnitLength;
		}
		index += codeUnitLength;
	}
	if (cleanStart === 0) return str;
	return cleanStart < str.length ? result + str.slice(cleanStart) : result;
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
