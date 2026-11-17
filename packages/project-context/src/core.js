import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workerData } from "node:worker_threads";
import ignore from "ignore";
import { comparePaths, DirectoryStack, INDEX_READ_BYTES, IndexRuns } from "./index-files.js";
import { INDEX_CHECK_INTERVAL, INDEX_STAGE } from "./index-progress.js";
import {
  ANSI_CSI_PATTERN,
  ANSI_ESCAPE_PATTERN,
  ANSI_OSC_PATTERN,
  ANSI_STRING_PATTERN,
  ASSET_EXTENSION_PATTERN,
  BACKTICK_RUN_PATTERN,
  CONFIG_EXTENSION_PATTERN,
  CONTROL_PATTERN,
  DOCUMENT_EXTENSION_PATTERN,
  DOCUMENT_PATH_PATTERN,
  ENTRYPOINT_NAME_PATTERN,
  PROJECT_NAME_UNSAFE_PATTERN,
  PROJECT_UUID_PATTERN,
  SAFE_ENV_EXAMPLE_PATTERN,
  SECRET_NAME_PATTERN,
  TEST_PATH_PATTERN,
} from "./regex.js";

// The index Worker receives the directory already selected by the caller.
// Standalone extension consumers use the existing runtime discovery.
const CONFIG_DIR_NAME = workerData?.projectContextDir ?? (await import("./pi-compat.js")).CONFIG_DIR_NAME;
export const SCHEMA_VERSION = 1;
export const CONTEXT_DIR = CONFIG_DIR_NAME;
export const MANIFEST_NAME = "project-context.json";
export const PROFILE_NAME = "project-context.md";
export const INDEX_NAME = "project-index.jsonl";
const IGNORE_NAME = ".spignore";
const IGNORE_CACHE_CHECKS = 1024;
const NAVIGATION_MARKER = "<!-- super-pi:project-context-navigation -->";
const NAVIGATION = `## Project Context\n\n- [Project summary](./${CONTEXT_DIR}/${PROFILE_NAME})\n- [File index](./${CONTEXT_DIR}/${INDEX_NAME})\n- [Index exclusions](./${IGNORE_NAME})`;

const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", ".codegraph", CONFIG_DIR_NAME.toLowerCase(), ".task-tmp", ".idea", ".vscode", ".cache", ".next", ".nuxt", ".turbo",
  ".aws", ".azure", ".docker", ".kube", ".ssh", ".terraform", ".secrets", "secrets",
  "node_modules", "vendor", "target", "dist", "build", "coverage", "out", "bin", "obj",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv",
]);
const SOURCE_LANGUAGES = new Map([
  [".js", "JavaScript"], [".jsx", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
  [".ts", "TypeScript"], [".tsx", "TypeScript"], [".mts", "TypeScript"], [".cts", "TypeScript"],
  [".rs", "Rust"], [".go", "Go"], [".py", "Python"], [".cs", "C#"], [".fs", "F#"],
  [".java", "Java"], [".kt", "Kotlin"], [".kts", "Kotlin"], [".c", "C"], [".h", "C/C++"],
  [".cc", "C/C++"], [".cpp", "C/C++"], [".hpp", "C/C++"], [".swift", "Swift"],
  [".rb", "Ruby"], [".php", "PHP"], [".vue", "Vue"], [".svelte", "Svelte"], [".dart", "Dart"],
  [".sh", "Shell"], [".bash", "Shell"], [".ps1", "PowerShell"], [".sql", "SQL"],
]);
const MANIFEST_FILES = new Set([
  "package.json", "deno.json", "deno.jsonc", "bunfig.toml", "cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "global.json", "composer.json",
  "gemfile", "makefile", "cmakelists.txt", "dockerfile", "docker-compose.yml", "docker-compose.yaml",
]);
const MAX_PROFILE_LANGUAGES = 12;
const MAX_PROFILE_MAIN_AREAS = 12;
const MAX_PROFILE_MANIFESTS = 20;
const MAX_PROFILE_ENTRYPOINTS = 20;

function normalizePath(value) {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findMarker(startDir, boundary = null) {
  let current = path.resolve(startDir);
  const stop = boundary ? normalizePath(boundary) : null;
  while (true) {
    const contextDir = path.join(current, CONTEXT_DIR);
    try {
      const stat = fs.lstatSync(contextDir);
      if (stat.isSymbolicLink()) throw new Error(`Refusing linked project context directory: ${contextDir}`);
      if (!stat.isDirectory()) throw new Error(`Project context path is not a directory: ${contextDir}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const marker = path.join(contextDir, MANIFEST_NAME);
    if (fs.existsSync(marker)) return { root: current, marker };
    if (stop && normalizePath(current) === stop) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findGitRoot(cwd) {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return output ? path.resolve(output) : null;
  } catch {
    return null;
  }
}

export function readManifest(markerPath) {
  let raw;
  try {
    const stat = fs.lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("manifest is not a regular file");
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read project manifest: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Project manifest is invalid JSON: ${markerPath}`);
  }
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    typeof value?.id !== "string" || !PROJECT_UUID_PATTERN.test(value.id) ||
    typeof value?.name !== "string" || !value.name.trim() || PROJECT_NAME_UNSAFE_PATTERN.test(value.name) ||
    typeof value?.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error(`Project manifest has an unsupported or invalid shape: ${markerPath}`);
  }
  return value;
}

export function resolveProject(cwd) {
  const current = path.resolve(cwd);
  const gitRoot = findGitRoot(current);
  const found = findMarker(current, gitRoot);
  if (found) {
    const manifest = readManifest(found.marker);
    return { root: found.root, marker: found.marker, manifest, initialized: true, gitRoot };
  }
  return { root: gitRoot ?? current, marker: path.join(gitRoot ?? current, CONTEXT_DIR, MANIFEST_NAME), manifest: null, initialized: false, gitRoot };
}

function ensureSafeDirectory(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!isWithin(resolvedRoot, resolvedDirectory)) throw new Error(`Refusing to access outside project root: ${directory}`);
  let current = resolvedRoot;
  for (const part of path.relative(resolvedRoot, resolvedDirectory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing linked or non-directory path component: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try { fs.mkdirSync(current); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing linked or non-directory path component: ${current}`);
    }
  }
}

function assertSafeTarget(root, target) {
  if (!isWithin(path.resolve(root), path.resolve(target))) throw new Error(`Refusing to write outside project root: ${target}`);
  ensureSafeDirectory(root, path.dirname(target));
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to replace non-regular file: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function openProjectFile(target, stat, flags) {
  if (!stat.isFile()) throw new Error(`Expected a regular project file: ${target}`);
  const fd = fs.openSync(target, flags | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(target);
    if (!opened.isFile() || !current.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
        current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`Project file changed while opening: ${target}`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function durableWriteExclusive(target, content, requireSync = false) {
  const descriptor = fs.openSync(target, "wx");
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    if (requireSync) fs.fsyncSync(descriptor);
    else try { fs.fsyncSync(descriptor); } catch {}
  } finally {
    fs.closeSync(descriptor);
  }
}

function createExclusiveFile(root, target, content) {
  assertSafeTarget(root, target);
  try {
    durableWriteExclusive(target, content);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function withProjectLock(root, operation) {
  const contextDir = path.join(root, CONTEXT_DIR);
  ensureSafeDirectory(root, contextDir);
  const lockDir = path.join(contextDir, ".project-context-lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const token = randomUUID();
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(lockDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe project-context lock: ${lockDir}`);
    let owner = "unknown owner";
    try { owner = fs.readFileSync(ownerPath, "utf8"); } catch {}
    throw new Error(`Another project-context operation is running, or a prior run left a lock. Verify no operation is active before manually removing ${lockDir}. Owner: ${owner}`);
  }
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }));
    return operation(lockDir);
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (owner?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  }
}

function shouldExcludeName(name, isDirectory) {
  if (isDirectory) return EXCLUDED_DIRS.has(name.toLowerCase());
  return SECRET_NAME_PATTERN.test(name) && !SAFE_ENV_EXAMPLE_PATTERN.test(name);
}

function classify(relativePath, extension, baseName) {
  const lower = relativePath.toLowerCase();
  if (TEST_PATH_PATTERN.test(relativePath)) return "test";
  if (SOURCE_LANGUAGES.has(extension)) return "source";
  if (MANIFEST_FILES.has(baseName.toLowerCase())) return "manifest";
  if (DOCUMENT_EXTENSION_PATTERN.test(baseName) || DOCUMENT_PATH_PATTERN.test(lower)) return "documentation";
  if (CONFIG_EXTENSION_PATTERN.test(baseName)) return "configuration";
  if (ASSET_EXTENSION_PATTERN.test(baseName)) return "asset";
  return "other";
}

function loadIgnore(root) {
  const target = path.join(root, IGNORE_NAME);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  const fd = openProjectFile(target, stat, fs.constants.O_RDONLY);
  let rules;
  try { rules = ignore({ ignorecase: process.platform === "win32" }).add(fs.readFileSync(fd, "utf8")); }
  finally { fs.closeSync(fd); }

  // Add the parsed rules to a new matcher periodically to release path caches.
  let matcher = ignore().add(rules);
  let checks = 0;
  return function isIgnored(relative, directory) {
    if (checks === IGNORE_CACHE_CHECKS) {
      matcher = ignore().add(rules);
      checks = 0;
    }
    checks++;
    return matcher.ignores(directory ? `${relative}/` : relative);
  };
}

function scanEntry(scan, prefix, entry) {
  if (scan.entries++ % INDEX_CHECK_INTERVAL === 0) {
    scan.control?.check();
    scan.control?.progress(INDEX_STAGE.scan, scan.stats.fileCount);
  }
  const name = entry.name;
  const directory = entry.isDirectory();
  if (shouldExcludeName(name, directory) || (!directory && !entry.isFile())) return;
  const relative = prefix ? prefix + name : name;
  if (scan.isIgnored?.(relative, directory)) return;
  if (directory) return relative;
  const stat = fs.lstatSync(path.join(scan.root, relative));
  if (!stat.isFile()) return;

  const extension = path.extname(name).toLowerCase();
  const language = SOURCE_LANGUAGES.get(extension);
  const record = { path: relative, size: stat.size, category: classify(relative, extension, name) };
  if (language) record.language = language;
  scan.runs.add(record);
  countRecord(scan.stats, record, name, prefix === "");
}

function scanArea(scan, initial) {
  scan.directories.push(initial);
  for (let relative; (relative = scan.directories.pop()) !== undefined;) {
    scan.control?.check();
    const absolute = path.join(scan.root, relative);
    if (!fs.lstatSync(absolute).isDirectory()) continue;
    const prefix = relative + "/";
    const directory = fs.opendirSync(absolute, { bufferSize: 128 });
    try {
      for (let entry; (entry = directory.readSync()) !== null;) {
        const child = scanEntry(scan, prefix, entry);
        if (child !== undefined) scan.directories.push(child);
      }
    } finally { directory.closeSync(); }
  }
}

function stageIndex(root, scratch, target, control) {
  const stats = createArtifactStats();
  const runs = new IndexRuns(scratch, control);
  const directories = new DirectoryStack(scratch);
  const scan = { root, stats, control, runs, directories, isIgnored: loadIgnore(root), entries: 0 };
  let rootFiles = 0;
  const directory = fs.opendirSync(root, { bufferSize: 128 });
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      const before = stats.fileCount;
      const child = scanEntry(scan, "", entry);
      if (child === undefined) {
        rootFiles += stats.fileCount - before;
      } else {
        scanArea(scan, child);
        const count = stats.fileCount - before;
        // The existing profile groups root files and a literal (root) folder.
        if (child === "(root)") rootFiles += count;
        else countArea(stats, child, count);
      }
    }
  } finally { directory.closeSync(); }
  countArea(stats, "(root)", rootFiles);
  control?.check();
  control?.progress(INDEX_STAGE.merge, stats.fileCount);
  stats.indexHash = runs.finish(target);
  stats.diagnostics = { peakRecords: runs.peak, peakReaders: runs.peakReaders, peakDirectories: directories.peak,
    directorySpills: directories.spills, initialRuns: runs.runs };
  return stats;
}

export function safeDisplayText(value, fallback = "") {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "symbol"
        ? value.description ?? ""
        : `${value}`;
  const clean = text
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_STRING_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, "�")
    .trim();
  return clean || fallback;
}

function markdownCode(value) {
  const clean = safeDisplayText(value, "(unnamed)");
  const longestRun = Math.max(0, ...[...clean.matchAll(BACKTICK_RUN_PATTERN)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${clean}${fence}`;
}

function incrementCount(counts, key) {
  if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts) {
  const entries = [...counts.entries()];
  entries.sort(compareCounts);
  return entries;
}

function compareCounts(left, right) {
  return right[1] - left[1] || comparePaths(left[0], right[0]);
}

function pathDepth(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 47) depth += 1;
  return depth;
}

function compareProfilePaths(left, right) {
  return pathDepth(left) - pathDepth(right) || comparePaths(left, right);
}

function insertBoundedProfilePath(paths, value, limit) {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareProfilePaths(paths[middle], value) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit) return;
  paths.splice(low, 0, value);
  if (paths.length > limit) paths.pop();
}

function detectVerificationTarget(detected, rootPath, lowerBaseName) {
  const lowerPath = rootPath ? lowerBaseName : "";
  if (rootPath === "package.json" || (process.platform === "win32" && lowerPath === "package.json")) {
    if (!detected.npm || rootPath === "package.json" ||
        (detected.npm !== "package.json" && comparePaths(rootPath, detected.npm) < 0)) detected.npm = rootPath;
  } else if (lowerPath === "cargo.toml") detected.cargo = true;
  else if (lowerPath === "go.mod") detected.go = true;
  else if (lowerPath === "pyproject.toml" || lowerPath === "pytest.ini") detected.python = true;
  else if (lowerBaseName.endsWith(".sln") || lowerBaseName.endsWith(".csproj")) detected.dotnet = true;
}

function packageScripts(root, relativePath) {
  const packagePath = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(packagePath);
    const fd = openProjectFile(packagePath, stat, fs.constants.O_RDONLY);
    let value;
    try { value = JSON.parse(fs.readFileSync(fd, "utf8")); }
    finally { fs.closeSync(fd); }
    const preferred = ["test", "lint", "typecheck", "check", "build"];
    const commands = [];
    for (const name of preferred) if (typeof value?.scripts?.[name] === "string") commands.push(`npm run ${name}`);
    return commands;
  } catch {
    return [];
  }
}

function verificationCommands(root, detected) {
  const commands = detected.npm ? packageScripts(root, detected.npm) : [];
  if (detected.cargo) commands.push("cargo test");
  if (detected.go) commands.push("go test ./...");
  if (detected.python) commands.push("pytest");
  if (detected.dotnet) commands.push("dotnet test");
  return commands;
}

function createArtifactStats() {
  return {
    languages: new Map(), categories: new Map(), modules: [], moduleCount: 0,
    manifests: [], manifestCount: 0, entrypoints: [], entrypointCount: 0,
    fileCount: 0, sourceCount: 0, sourceBytes: 0, indexHash: "", diagnostics: undefined,
    detected: { npm: "", cargo: false, go: false, python: false, dotnet: false },
  };
}

function countRecord(stats, record, baseName, atRoot) {
  stats.fileCount++;
  incrementCount(stats.languages, record.language);
  incrementCount(stats.categories, record.category);
  if (record.category === "source" || record.category === "test") {
    stats.sourceCount++;
    stats.sourceBytes += record.size;
  }
  if (record.category === "manifest") {
    stats.manifestCount++;
    insertBoundedProfilePath(stats.manifests, record.path, MAX_PROFILE_MANIFESTS);
  }
  if (ENTRYPOINT_NAME_PATTERN.test(baseName)) {
    stats.entrypointCount++;
    insertBoundedProfilePath(stats.entrypoints, record.path, MAX_PROFILE_ENTRYPOINTS);
  }
  detectVerificationTarget(stats.detected, atRoot ? baseName : "", baseName.toLowerCase());
}

function countArea(stats, area, count) {
  if (!count) return;
  stats.moduleCount++;
  const modules = stats.modules;
  let index = 0;
  for (; index < modules.length; index++) {
    const [name, files] = modules[index];
    if (count > files || (count === files && comparePaths(area, name) < 0)) break;
  }
  if (index === MAX_PROFILE_MAIN_AREAS) return;
  modules.splice(index, 0, [area, count]);
  if (modules.length > MAX_PROFILE_MAIN_AREAS) modules.pop();
}

function appendCountLines(lines, entries, limit, emptyText, omittedLabel, codeNames = false, total = entries.length) {
  if (entries.length === 0) {
    lines.push(emptyText, "");
    return;
  }
  const visible = Math.min(entries.length, limit);
  for (let index = 0; index < visible; index++) {
    const name = codeNames ? markdownCode(entries[index][0]) : safeDisplayText(entries[index][0], "(unnamed)");
    lines.push(`- ${name}: ${entries[index][1]} files`);
  }
  if (total > visible) lines.push(`- ${total - visible} additional ${omittedLabel} omitted`);
  lines.push("");
}

function appendPathLines(lines, paths, total, emptyText, omittedHint) {
  if (total === 0) {
    lines.push(emptyText, "");
    return;
  }
  for (const name of paths) lines.push(`- ${markdownCode(name)}`);
  if (total > paths.length) lines.push(`- ${total - paths.length} additional entries omitted; ${omittedHint}`);
  lines.push("");
}

function buildProfile(manifest, stats, verification) {
  const lines = [
    "# Project Context", "",
    "> Generated by `/project-refresh`. Edit project rules in `AGENTS.md`; refresh this file instead of editing it manually.", "",
    "## Identity", "",
    `- Name: ${safeDisplayText(manifest.name, "(unnamed project)")}`,
    `- Stable ID: \`${manifest.id}\``,
    `- Indexed files: ${stats.fileCount}`,
    `- Source and test files: ${stats.sourceCount}`,
    `- Lightweight index SHA-256: \`${stats.indexHash}\``, "",
  ];
  lines.push("## Languages", "");
  appendCountLines(lines, sortedCounts(stats.languages), MAX_PROFILE_LANGUAGES, "- No recognized source languages", "languages");
  lines.push("## Main Areas", "");
  appendCountLines(lines, stats.modules, MAX_PROFILE_MAIN_AREAS, "- None", "areas", true, stats.moduleCount);
  lines.push("## Manifests", "");
  appendPathLines(lines, stats.manifests, stats.manifestCount, "- None detected", "query `.sp/project-index.jsonl` for category `manifest`.");
  lines.push("## Likely Entrypoints", "");
  appendPathLines(lines, stats.entrypoints, stats.entrypointCount, "- None detected", "query `.sp/project-index.jsonl` by filename.");
  lines.push("## Verification Candidates", "");
  if (verification.length === 0) lines.push("- No standard verification command detected; confirm project-specific checks in `AGENTS.md`.");
  else for (const command of verification) lines.push(`- ${markdownCode(command)}`);
  lines.push("", "## Index Summary", "");
  for (const [name, count] of sortedCounts(stats.categories)) lines.push(`- ${name}: ${count}`);
  return `${lines.join("\n")}\n`;
}

export function projectAgentsTemplate() {
  return `# Project Instructions\n\n## Local Rules\n\n- Add project-specific architecture, coding, verification, and release rules here.\n- Preserve the global rule: do not commit, push, or open a PR without explicit user approval for the current task.\n- Search Hermes memory or prior sessions only when the user explicitly asks.\n\n${NAVIGATION}\n${NAVIGATION_MARKER}\n`;
}

function ensureProjectNavigation(root) {
  const target = path.join(root, "AGENTS.md");
  let stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    if (createExclusiveFile(root, target, projectAgentsTemplate())) return "created";
    stat = fs.lstatSync(target);
  }
  const fd = openProjectFile(target, stat, fs.constants.O_RDONLY);
  let original;
  try { original = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  if (original.includes(NAVIGATION_MARKER)) return "preserved";
  const firstNewline = original.indexOf(10);
  const newline = original[firstNewline - 1] === 13 ? "\r\n" : "\n";
  const separator = original.length === 0 ? "" : original[original.length - 1] === 10 ? newline : newline + newline;
  const append = openProjectFile(target, stat, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    const current = fs.fstatSync(append);
    if (current.size !== original.length || current.mtimeMs !== stat.mtimeMs) {
      throw new Error(`Project rules changed before navigation could be added: ${target}`);
    }
    fs.writeFileSync(append, separator + `${NAVIGATION}\n${NAVIGATION_MARKER}\n`.replaceAll("\n", newline));
    return "navigation added";
  } finally { fs.closeSync(append); }
}

const TRANSACTION_MARKER = ".project-context-transaction.json";
const COMMIT_MARKER = ".project-context-transaction-committed";

function transactionMarkerPath(root) {
  return path.join(root, CONTEXT_DIR, TRANSACTION_MARKER);
}

function unlinkIfPresent(filename) {
  try { fs.unlinkSync(filename); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function recoverProjectTransaction(root) {
  const markerPath = transactionMarkerPath(root);
  const commitPath = path.join(root, CONTEXT_DIR, COMMIT_MARKER);
  const commit = fs.lstatSync(commitPath, { throwIfNoEntry: false });
  if (commit && (!commit.isFile() || commit.size !== 0)) throw new Error(`Unsafe project-context commit marker: ${commitPath}`);
  if (!fs.lstatSync(markerPath, { throwIfNoEntry: false })) {
    if (commit) unlinkIfPresent(commitPath);
    return false;
  }
  assertSafeTarget(root, markerPath);
  const stat = fs.lstatSync(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe project-context transaction marker: ${markerPath}`);
  let transaction;
  try { transaction = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { throw new Error(`Invalid project-context transaction marker: ${markerPath}`); }
  const expectedTargets = [PROFILE_NAME, INDEX_NAME];
  if (!transaction || (transaction.version !== 1 && transaction.version !== 2) || !Array.isArray(transaction.entries) || transaction.entries.length !== 2) {
    throw new Error(`Unsupported project-context transaction marker: ${markerPath}`);
  }
  const entries = transaction.entries.map((entry, index) => {
    if (entry?.target !== expectedTargets[index] || typeof entry?.staged !== "string" || typeof entry?.backup !== "string" || typeof entry?.hadPrevious !== "boolean" ||
        path.basename(entry.staged) !== entry.staged || path.basename(entry.backup) !== entry.backup ||
        !entry.staged.startsWith(`${entry.target}.`) || !entry.staged.endsWith(".tmp") ||
        !entry.backup.startsWith(`${entry.target}.`) || !entry.backup.endsWith(".backup") || entry.staged === entry.backup) {
      throw new Error(`Unsafe project-context transaction marker: ${markerPath}`);
    }
    const contextDir = path.join(root, CONTEXT_DIR);
    const value = {
      target: path.join(contextDir, entry.target),
      staged: path.join(contextDir, entry.staged),
      backup: path.join(contextDir, entry.backup),
      hadPrevious: entry.hadPrevious,
    };
    for (const candidate of [value.target, value.staged, value.backup]) assertSafeTarget(root, candidate);
    return value;
  });
  const committed = transaction.version === 2 && commit !== undefined;
  if (committed) for (const entry of entries) {
    if (!fs.lstatSync(entry.target, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing committed project artifact: ${entry.target}`);
    }
  }
  for (const entry of entries) {
    if (committed) {
      unlinkIfPresent(entry.backup);
    } else if (fs.existsSync(entry.backup)) {
      if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target);
      fs.renameSync(entry.backup, entry.target);
    } else if (!entry.hadPrevious && fs.existsSync(entry.target)) {
      fs.unlinkSync(entry.target);
    }
    unlinkIfPresent(entry.staged);
  }
  fs.unlinkSync(markerPath);
  if (commit) unlinkIfPresent(commitPath);
  return true;
}

function readChunk(fd, buffer, requested) {
  let total = 0;
  while (total < requested) {
    const bytes = fs.readSync(fd, buffer, total, requested - total, null);
    if (bytes === 0) break;
    total += bytes;
  }
  return total;
}

function sameFileContents(left, leftStat, right, control) {
  const rightStat = fs.lstatSync(right);
  if (leftStat.size !== rightStat.size) return false;
  const leftFd = openProjectFile(left, leftStat, fs.constants.O_RDONLY);
  try {
    const rightFd = openProjectFile(right, rightStat, fs.constants.O_RDONLY);
    try {
      const bytes = Math.min(INDEX_READ_BYTES, leftStat.size);
      const leftBuffer = Buffer.allocUnsafe(bytes);
      const rightBuffer = Buffer.allocUnsafe(bytes);
      for (let remaining = leftStat.size; remaining > 0;) {
        control?.check();
        const length = Math.min(remaining, bytes);
        if (readChunk(leftFd, leftBuffer, length) !== length || readChunk(rightFd, rightBuffer, length) !== length ||
            leftBuffer.compare(rightBuffer, 0, length, 0, length) !== 0) return false;
        remaining -= length;
      }
      return true;
    } finally { fs.closeSync(rightFd); }
  } finally { fs.closeSync(leftFd); }
}

function publishIndex(root, scratch, control, operations) {
  const context = path.join(root, CONTEXT_DIR);
  const snapshots = [];
  for (const name of [PROFILE_NAME, INDEX_NAME]) {
    const target = path.join(context, name);
    const source = path.join(scratch, name);
    assertSafeTarget(root, target);
    const previous = fs.lstatSync(target, { throwIfNoEntry: false });
    snapshots.push({ target, source, hadPrevious: previous !== undefined, changed: !previous || !sameFileContents(target, previous, source, control) });
  }
  const [profile, index] = snapshots;
  const result = { profileChanged: profile.changed, indexChanged: index.changed, cleanupPending: false };
  control?.check();
  if (!profile.changed && !index.changed) return result;

  const token = `${process.pid}.${randomUUID()}`;
  const staged = snapshots.map((entry) => `${entry.target}.${token}.tmp`);
  const backups = snapshots.map((entry) => `${entry.target}.${token}.backup`);
  for (const candidate of [...staged, ...backups]) assertSafeTarget(root, candidate);
  const markerPath = transactionMarkerPath(root);
  const commitPath = path.join(context, COMMIT_MARKER);
  assertSafeTarget(root, markerPath);
  assertSafeTarget(root, commitPath);
  const marker = {
    version: 2,
    entries: snapshots.map((entry, index) => ({
      target: path.basename(entry.target),
      staged: path.basename(staged[index]),
      backup: path.basename(backups[index]),
      hadPrevious: entry.hadPrevious,
    })),
  };
  const stagedMarker = path.join(scratch, TRANSACTION_MARKER);
  durableWriteExclusive(stagedMarker, `${JSON.stringify(marker)}\n`, true);
  control?.check();
  fs.renameSync(stagedMarker, markerPath);
  let committed;
  try {
    for (let i = 0; i < snapshots.length; i++) operations.renameSync(snapshots[i].source, staged[i]);
    for (let i = 0; i < snapshots.length; i++) {
      if (snapshots[i].hadPrevious) operations.renameSync(snapshots[i].target, backups[i]);
    }
    for (let i = 0; i < snapshots.length; i++) operations.renameSync(staged[i], snapshots[i].target);
    // This exclusive create is the commit boundary. Recovery can finish cleanup
    // after it without mixing old and new artifacts when backups are removed.
    committed = fs.openSync(commitPath, "wx", 0o600);
  } catch (error) {
    try {
      recoverProjectTransaction(root);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Project context refresh failed; recovery marker remains at ${markerPath}.`);
    }
    throw error;
  }
  try {
    fs.closeSync(committed);
    recoverProjectTransaction(root);
  }
  catch { result.cleanupPending = true; }
  return result;
}

function refreshResolved(resolved, scratch, options) {
  const { root, manifest } = resolved;
  const { control, operations = fs } = options;
  recoverProjectTransaction(root);
  control?.check();
  const stats = stageIndex(root, scratch, path.join(scratch, INDEX_NAME), control);
  const profile = buildProfile(manifest, stats, verificationCommands(root, stats.detected));
  durableWriteExclusive(path.join(scratch, PROFILE_NAME), profile, true);
  control?.progress(INDEX_STAGE.publish, stats.fileCount);
  const publication = publishIndex(root, scratch, control, operations);
  return { root, ...publication, fileCount: stats.fileCount, sourceCount: stats.sourceCount,
    sourceBytes: stats.sourceBytes, diagnostics: stats.diagnostics };
}

export function initializeProject(cwd, now = new Date()) {
  const initial = resolveProject(cwd);
  const root = initial.root;
  return withProjectLock(root, () => {
    const marker = path.join(root, CONTEXT_DIR, MANIFEST_NAME);
    const wasInitialized = fs.existsSync(marker);
    if (!wasInitialized) {
      const proposed = {
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        name: safeDisplayText(path.basename(root), "unnamed-project").replaceAll("`", "'"),
        createdAt: now.toISOString(),
      };
      createExclusiveFile(root, marker, `${JSON.stringify(proposed, null, 2)}\n`);
    }
    const manifest = readManifest(marker);
    const agents = ensureProjectNavigation(root);
    return { root, marker, manifest, initialized: true, gitRoot: initial.gitRoot, agents, alreadyInitialized: wasInitialized };
  });
}

export function refreshProject(cwd, resolved = resolveProject(cwd), options = {}) {
  if (!resolved.initialized) throw new Error("Project context is not initialized. Run /project-init first.");
  return withProjectLock(resolved.root, scratch => refreshResolved({ ...resolved, manifest: readManifest(resolved.marker) }, scratch, options));
}

function findSharedGitRoot(cwd) {
  try {
    const commonDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (!commonDir) return null;
    const resolved = path.resolve(commonDir);
    return path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
  } catch {
    return null;
  }
}

function configuredProjectsDir(agentDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, "config", "hermes-memory-config.json"), "utf8"));
    const candidate = typeof config?.projectsMemoryDir === "string" ? config.projectsMemoryDir.trim() : "";
    if (candidate && !path.isAbsolute(candidate) && !candidate.includes("/") && !candidate.includes("\\") && candidate !== "." && candidate !== "..") return candidate;
  } catch {}
  return "projects-memory";
}

export function detectHermes(root, cwd = root, agentDir = process.env.SP_CODING_AGENT_DIR ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent")) {
  const resolvedCwd = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (normalizePath(resolvedCwd) === normalizePath(home) || path.dirname(resolvedCwd) === resolvedCwd) {
    return { name: null, memoryDir: null, exists: false, rootAligned: false };
  }
  const repoRoot = findSharedGitRoot(resolvedCwd);
  const cwdName = path.basename(resolvedCwd);
  const repoName = repoRoot ? path.basename(repoRoot) : cwdName;
  const projectsRoot = path.join(agentDir, configuredProjectsDir(agentDir));
  let name = repoName;
  if (repoRoot && normalizePath(repoRoot) !== normalizePath(resolvedCwd)) {
    const repoDir = path.join(projectsRoot, repoName);
    const legacyDir = path.join(projectsRoot, cwdName);
    if (!fs.existsSync(repoDir) && fs.existsSync(legacyDir)) name = cwdName;
  }
  const memoryDir = path.join(projectsRoot, name);
  return {
    name,
    memoryDir,
    exists: fs.existsSync(memoryDir),
    rootAligned: Boolean(repoRoot) || normalizePath(root) === normalizePath(resolvedCwd),
  };
}

export function ensureHermesProjectMemory(root, cwd = root, agentDir = process.env.SP_CODING_AGENT_DIR ?? path.join(os.homedir(), CONFIG_DIR_NAME, "agent")) {
  const hermes = detectHermes(root, cwd, agentDir);
  if (!hermes.name || !hermes.memoryDir) throw new Error("Hermes project scope is unavailable for this directory.");
  ensureSafeDirectory(agentDir, hermes.memoryDir);
  const memoryFile = path.join(hermes.memoryDir, "MEMORY.md");
  const created = createExclusiveFile(agentDir, memoryFile, "");
  return { ...hermes, exists: true, memoryFile, created };
}

export function getIndexState(root) {
  const contextDir = path.join(root, CONTEXT_DIR);
  const pending = fs.lstatSync(transactionMarkerPath(root), { throwIfNoEntry: false });
  if (pending) return "incomplete (publication recovery pending)";
  const profile = fs.lstatSync(path.join(contextDir, PROFILE_NAME), { throwIfNoEntry: false });
  const index = fs.lstatSync(path.join(contextDir, INDEX_NAME), { throwIfNoEntry: false });
  if (profile?.isFile() && index?.isFile()) return "published";
  return profile || index ? "incomplete" : "missing";
}

export function getStatus(cwd, agentDir) {
  const resolved = resolveProject(cwd);
  const hermes = detectHermes(resolved.root, cwd, agentDir);
  return { ...resolved, hermes, indexState: resolved.initialized ? getIndexState(resolved.root) : "missing" };
}
