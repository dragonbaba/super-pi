import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CREDENTIAL_FILE_EXTENSION_PATTERN,
	ENV_DUMP_COMMAND_PATTERN,
	ENV_FILE_REFERENCE_PATTERN,
	ENV_NAME_PATTERN,
	GLOB_META_PATTERN,
	OUTSIDE_WRITE_COMMAND_PATTERN,
	SHELL_EXECUTABLE_SUFFIX_PATTERN,
	TRAILING_SLASH_PATTERN,
} from "./regex.ts";

const SAFE_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults"]);
const BASE_ENV_ALLOWLIST = new Set([
	"COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS",
	"PATH", "PATHEXT", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMDRIVE", "SYSTEMROOT",
	"TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
]);
const MAX_AUTH_ENV_VARS = 16;
const MAX_BASH_TOKENS = 1024;
const MAX_TRAVERSAL_DIRECTORIES = 4096;
const MAX_TRAVERSAL_ENTRIES = 50_000;
const MAX_TRAVERSAL_DEPTH = 64;
const CREDENTIAL_REFERENCES = [
	"auth.json", "/.ssh/", "~/.ssh", "/.aws/", "~/.aws", "/.azure/", "~/.azure", "/.kube/", "~/.kube",
	"gh auth token", "security find-generic-password", "getenvironmentvariables", "get-childitem env:", "/proc/self/environ",
] as const;
const DETACHED_COMMANDS = new Set(["disown", "new-service", "nohup", "setsid", "schtasks", "start-process"]);
const HOME_CREDENTIAL_SUFFIXES = ["/.ssh", "/.aws", "/.azure", "/.kube", "/.config/gcloud", "/.docker/config.json"] as const;
const APPDATA_CREDENTIAL_SUFFIXES = ["/gh/hosts.yml", "/github cli/hosts.yml", "/microsoft/credentials"] as const;
const LOCAL_APPDATA_CREDENTIAL_SUFFIXES = ["/microsoft/credentials", "/google/chrome/user data"] as const;
const PROTECTED_DIRECTORY_MARKERS = ["/.ssh", "/.aws", "/.azure", "/.kube", "/.config/gcloud"] as const;

function shellCommandName(token: string): string {
	const normalized = token.replaceAll("\\", "/");
	const slash = normalized.lastIndexOf("/");
	const basename = slash < 0 ? normalized : normalized.slice(slash + 1);
	return basename.replace(SHELL_EXECUTABLE_SUFFIX_PATTERN, "");
}

function appendShellToken(tokens: string[], token: string): boolean {
	if (!token) return true;
	if (tokens.length >= MAX_BASH_TOKENS) return false;
	tokens.push(token.toLowerCase());
	return true;
}

function isShellWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\r" || character === "\n";
}

/** Extract bounded command words while distinguishing quoted text from shell control operators. */
function detachedProcessReason(command: string): string | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (escaped) { token += character; escaped = false; continue; }
		if (character === "\\" && quote !== "'") { escaped = true; continue; }
		if (character === "'" || character === "\"") {
			if (!quote) quote = character;
			else if (quote === character) quote = "";
			continue;
		}
		if (isShellWhitespace(character)) {
			if (!appendShellToken(tokens, token)) return "command is too complex";
			token = "";
			continue;
		}
		if (!quote && character === "&") {
			if (command[index + 1] !== "&") return "background processes are disabled";
			if (!appendShellToken(tokens, token)) return "command is too complex";
			token = "";
			index += 1;
			continue;
		}
		if (!quote && ";|()".includes(character)) {
			if (!appendShellToken(tokens, token)) return "command is too complex";
			token = "";
			continue;
		}
		token += character;
	}
	if (escaped || quote) return "command is malformed";
	if (!appendShellToken(tokens, token)) return "command is too complex";

	for (let index = 0; index < tokens.length; index += 1) {
		const current = shellCommandName(tokens[index]!);
		const next = tokens[index + 1];
		if (DETACHED_COMMANDS.has(current)) return "detached processes are disabled";
		if (current === "start" && next === "/b") return "detached processes are disabled";
		if (current === "sc" && next === "create") return "persistent services are disabled";
		if (current === "systemctl" && next === "enable") return "persistent services are disabled";
	}
	return undefined;
}

export interface CanonicalPath {
	path: string;
	exists: boolean;
}

export function assertProjectAgentAccess(
	scope: "user" | "project" | "both",
	trusted: boolean,
	hasUI: boolean,
	confirmProjectAgents: boolean,
): void {
	if (scope === "user") return;
	if (!trusted) throw new Error("Project-local agents require a trusted project");
	if (confirmProjectAgents && !hasUI) {
		throw new Error("Project-local agents are denied without UI confirmation; trusted automation must explicitly disable confirmation");
	}
}

function comparable(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(comparable(root), comparable(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve symlinks for an existing path, or for the nearest existing parent of a new path. */
export function canonicalizePath(candidate: string, base: string, mustExist = false): CanonicalPath {
	if (candidate.includes("\0")) throw new Error("Path contains a NUL byte");
	const absolute = path.resolve(base, candidate);
	let cursor = absolute;
	const missing: string[] = [];
	while (true) {
		let real: string;
		try {
			real = fs.realpathSync.native(cursor);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			missing.push(path.basename(cursor));
			cursor = parent;
			continue;
		}
		if (missing.length === 0) return { path: real, exists: true };
		if (mustExist) throw new Error(`Path does not exist: ${absolute}`);
		return { path: path.join(real, ...missing.reverse()), exists: false };
	}
}

export function canonicalWorkspace(cwd: string): string {
	const resolved = canonicalizePath(cwd, process.cwd(), true).path;
	if (!fs.statSync(resolved).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
	return resolved;
}

export function resolveWorkspacePath(candidate: string, workspace: string, mustExist = false): string {
	const canonicalRoot = canonicalWorkspace(workspace);
	const canonical = canonicalizePath(candidate, canonicalRoot, mustExist).path;
	if (!isPathInside(canonical, canonicalRoot)) throw new Error(`Path escapes the trusted workspace: ${candidate}`);
	return canonical;
}

/** Build a deliberately small environment. requiredAuthEnv must come from Pi's provider auth resolver. */
export function buildChildEnvironment(
	source: NodeJS.ProcessEnv,
	requiredAuthEnv: Readonly<Record<string, string | undefined>> = {},
	extra: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	for (const name of BASE_ENV_ALLOWLIST) {
		const value = source[name];
		if (value !== undefined) child[name] = value;
	}
	// Pi may use a non-default agent directory for auth.json. Passing only its location avoids copying credentials.
	if (source.SP_CODING_AGENT_DIR) {
		child.SP_CODING_AGENT_DIR = canonicalizePath(source.SP_CODING_AGENT_DIR, process.cwd()).path;
	}
	const authEntries = Object.entries(requiredAuthEnv);
	if (authEntries.length > MAX_AUTH_ENV_VARS) throw new Error("Provider auth environment is unexpectedly large");
	for (const [name, value] of authEntries) {
		const upper = name.toUpperCase();
		if (!ENV_NAME_PATTERN.test(upper) || value === undefined || value.length > 16 * 1024) continue;
		child[upper] = value;
	}
	for (const [name, value] of Object.entries(extra)) {
		if (value !== undefined) child[name] = value;
	}
	return child;
}

function isEnvironmentFile(candidate: string): boolean {
	const name = path.basename(candidate).toLowerCase();
	if (SAFE_ENV_FILES.has(name)) return false;
	return name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name === ".envrc";
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(TRAILING_SLASH_PATTERN, "").toLowerCase();
}

function canonicalNormalizedPath(value: string, cwd: string): string {
	if (!value) return "";
	try { return normalizedPath(canonicalizePath(value, cwd).path); }
	catch { return normalizedPath(path.resolve(cwd, value)); }
}

function isAtOrBelow(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

function matchesCredentialSuffix(candidate: string, root: string, suffixes: readonly string[]): boolean {
	if (!root) return false;
	for (const suffix of suffixes) {
		if (isAtOrBelow(candidate, `${root}${suffix}`)) return true;
	}
	return false;
}

function hasProtectedDirectoryMarker(candidate: string): boolean {
	for (const marker of PROTECTED_DIRECTORY_MARKERS) {
		if (candidate.endsWith(marker) || candidate.includes(`${marker}/`)) return true;
	}
	return false;
}

function containsCredentialReference(command: string): boolean {
	for (const reference of CREDENTIAL_REFERENCES) {
		if (command.includes(reference)) return true;
	}
	return false;
}

export function sensitivePathReason(candidate: string, cwd: string): string | undefined {
	if (!candidate.trim()) return undefined;
	let normalized: string;
	try {
		normalized = canonicalizePath(candidate, cwd).path.replaceAll("\\", "/").toLowerCase();
	} catch {
		return "path cannot be safely resolved";
	}
	const home = canonicalNormalizedPath(os.homedir(), cwd);
	const configuredAgentDir = canonicalNormalizedPath(process.env.SP_CODING_AGENT_DIR || path.join(home, ".super-pi", "agent"), cwd);
	if (isEnvironmentFile(candidate)) return "environment files are hidden from subagents";
	if (normalized === `${configuredAgentDir}/auth.json` || normalized.endsWith("/.super-pi/agent/auth.json")) {
		return "Pi authentication storage is hidden from subagents";
	}
	if (CREDENTIAL_FILE_EXTENSION_PATTERN.test(normalized)) return "private key material is hidden from subagents";
	const appData = canonicalNormalizedPath(process.env.APPDATA || "", cwd);
	const localAppData = canonicalNormalizedPath(process.env.LOCALAPPDATA || "", cwd);
	const protectedPath = matchesCredentialSuffix(normalized, home, HOME_CREDENTIAL_SUFFIXES)
		|| matchesCredentialSuffix(normalized, appData, APPDATA_CREDENTIAL_SUFFIXES)
		|| matchesCredentialSuffix(normalized, localAppData, LOCAL_APPDATA_CREDENTIAL_SUFFIXES)
		|| hasProtectedDirectoryMarker(normalized);
	return protectedPath ? "credential-bearing user directories are hidden from subagents" : undefined;
}

/** Validate a recursive discovery tree under strict synchronous-work bounds. */
export function recursiveTraversalRiskReason(candidate: string, workspace: string): string | undefined {
	let canonicalRoot: string;
	try { canonicalRoot = canonicalWorkspace(workspace); }
	catch { return "assigned workspace cannot be safely resolved"; }
	const normalizedCandidate = candidate.replaceAll("\\", "/");
	const segments = normalizedCandidate.split("/");
	let firstMagic = -1;
	for (let index = 0; index < segments.length; index += 1) {
		if (GLOB_META_PATTERN.test(segments[index]!)) { firstMagic = index; break; }
	}
	let traversalCandidate = candidate;
	if (firstMagic >= 0) {
		const prefix = segments.slice(0, firstMagic).join("/");
		traversalCandidate = prefix || ".";
	}

	let root: string;
	try { root = resolveWorkspacePath(traversalCandidate, canonicalRoot, false); }
	catch { return "path escapes the assigned workspace (including via glob or symlink)"; }
	if (!fs.existsSync(root)) return undefined;

	const pendingPaths = [root];
	const pendingDepths = [0];
	const visitedDirectories = new Set<string>();
	let directoryCount = 0;
	let entryCount = 0;
	while (pendingPaths.length > 0) {
		const currentPath = pendingPaths.pop()!;
		const currentDepth = pendingDepths.pop()!;
		if (currentDepth > MAX_TRAVERSAL_DEPTH) return "recursive traversal is too deep";
		const sensitive = sensitivePathReason(currentPath, canonicalRoot);
		if (sensitive) return sensitive;
		let real: string;
		let stat: fs.Stats;
		try {
			real = canonicalizePath(currentPath, canonicalRoot, true).path;
			if (!isPathInside(real, canonicalRoot)) return "recursive traversal reaches a symlink outside the assigned workspace";
			const realSensitive = sensitivePathReason(real, canonicalRoot);
			if (realSensitive) return realSensitive;
			stat = fs.statSync(real);
		} catch {
			return "recursive traversal cannot be safely resolved";
		}
		if (!stat.isDirectory() || visitedDirectories.has(real)) continue;
		if (++directoryCount > MAX_TRAVERSAL_DIRECTORIES) return "recursive traversal is too large";
		visitedDirectories.add(real);
		let directory: fs.Dir;
		try { directory = fs.opendirSync(real); }
		catch { return "recursive traversal cannot be safely inspected"; }
		try {
			while (true) {
				let entry: fs.Dirent | null;
				try { entry = directory.readSync(); }
				catch { return "recursive traversal cannot be safely inspected"; }
				if (!entry) break;
				if (++entryCount > MAX_TRAVERSAL_ENTRIES) return "recursive traversal is too large";
				pendingPaths.push(path.join(real, entry.name));
				pendingDepths.push(currentDepth + 1);
			}
		} finally {
			try { directory.closeSync(); } catch { }
		}
	}
	return undefined;
}

export function outsideWorkspace(candidate: string, cwd: string): boolean {
	try {
		return !isPathInside(canonicalizePath(candidate, cwd).path, canonicalWorkspace(cwd));
	} catch {
		return true;
	}
}

/** Conservative filter only; Bash is disabled for project agents and must be explicitly enabled for user agents. */
export function bashRiskReason(command: string): string | undefined {
	if (command.length > 64 * 1024 || command.includes("\0")) return "command is too large or malformed";
	const normalized = command.replaceAll("\\", "/").toLowerCase();
	if (containsCredentialReference(normalized)) return "command attempts to access credentials or enumerate secrets";
	if (ENV_DUMP_COMMAND_PATTERN.test(command)) return "environment enumeration is disabled";
	const environmentReferences = normalized.match(ENV_FILE_REFERENCE_PATTERN);
	if (environmentReferences) {
		for (const name of environmentReferences) {
			if (!SAFE_ENV_FILES.has(path.basename(name))) return "environment files are hidden from subagents";
		}
	}
	const processRisk = detachedProcessReason(command);
	if (processRisk) return processRisk;
	// Block obvious absolute/parent-path redirections and destructive path arguments. This is not claimed as a shell sandbox.
	if (OUTSIDE_WRITE_COMMAND_PATTERN.test(command)) {
		return "command may write outside the assigned workspace";
	}
	return undefined;
}
