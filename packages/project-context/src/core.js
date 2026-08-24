import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "./pi-compat.js";
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

export const SCHEMA_VERSION = 1;
export const CONTEXT_DIR = CONFIG_DIR_NAME;
export const MANIFEST_NAME = "project-context.json";
export const PROFILE_NAME = "project-context.md";
export const INDEX_NAME = "project-index.jsonl";

const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", ".codegraph", CONFIG_DIR_NAME.toLowerCase(), ".idea", ".vscode", ".cache", ".next", ".nuxt", ".turbo",
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
const MAX_FILES = 50_000;
const MAX_PROFILE_LANGUAGES = 12;
const MAX_PROFILE_MAIN_AREAS = 12;
const MAX_PROFILE_MANIFESTS = 20;
const MAX_PROFILE_ENTRYPOINTS = 20;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

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

function durableWriteExclusive(target, content) {
  const descriptor = fs.openSync(target, "wx");
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    try { fs.fsyncSync(descriptor); } catch {}
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

export function atomicWriteIfChanged(root, target, content) {
  assertSafeTarget(root, target);
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.project-context-backup`);
  assertSafeTarget(root, backup);
  if (fs.existsSync(backup)) {
    if (fs.existsSync(target)) fs.unlinkSync(backup);
    else fs.renameSync(backup, target);
  }
  try {
    if (fs.readFileSync(target, "utf8") === content) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    durableWriteExclusive(temporary, content);
    if (process.platform === "win32" && fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    }
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
  }
  return true;
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
    return operation();
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

export function scanProject(root) {
  const records = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = fs.readdirSync(directory, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    const childDirs = [];
    for (const entry of entries) {
      if (shouldExcludeName(entry.name, entry.isDirectory())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        childDirs.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toPosix(path.relative(root, absolute));
      const stat = fs.statSync(absolute);
      const extension = path.extname(entry.name).toLowerCase();
      const language = SOURCE_LANGUAGES.get(extension) ?? null;
      records.push({ path: relative, size: stat.size, category: classify(relative, extension, entry.name), ...(language ? { language } : {}) });
      if (records.length > MAX_FILES) throw new Error(`Project exceeds the lightweight index safety limit (${MAX_FILES} files). Add exclusions or use a dedicated indexer.`);
    }
    for (let index = childDirs.length - 1; index >= 0; index--) stack.push(childDirs[index]);
  }
  records.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return records;
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
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"));
  return entries;
}

function pathDepth(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 47) depth += 1;
  return depth;
}

function compareProfilePaths(left, right) {
  return pathDepth(left) - pathDepth(right) || left.localeCompare(right, "en");
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

function recordBaseName(recordPath) {
  const slash = recordPath.lastIndexOf("/");
  return slash < 0 ? recordPath : recordPath.slice(slash + 1);
}

function detectVerificationTarget(detected, lowerPath, lowerBaseName) {
  if (lowerPath === "cargo.toml") detected.cargo = true;
  else if (lowerPath === "go.mod") detected.go = true;
  else if (lowerPath === "pyproject.toml" || lowerPath === "pytest.ini") detected.python = true;
  else if (lowerBaseName.endsWith(".sln") || lowerBaseName.endsWith(".csproj")) detected.dotnet = true;
}

function packageScripts(root) {
  const packagePath = path.join(root, "package.json");
  try {
    const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const preferred = ["test", "lint", "typecheck", "check", "build"];
    const commands = [];
    for (const name of preferred) if (typeof value?.scripts?.[name] === "string") commands.push(`npm run ${name}`);
    return commands;
  } catch {
    return [];
  }
}

function verificationCommands(root, detected) {
  const commands = packageScripts(root);
  if (detected.cargo) commands.push("cargo test");
  if (detected.go) commands.push("go test ./...");
  if (detected.python) commands.push("pytest");
  if (detected.dotnet) commands.push("dotnet test");
  return commands;
}

function collectArtifactStats(records) {
  const languageCounts = new Map();
  const categoryCounts = new Map();
  const moduleCounts = new Map();
  const manifests = [];
  const entrypoints = [];
  const detected = { cargo: false, go: false, python: false, dotnet: false };
  const indexLines = new Array(records.length);
  const indexHash = createHash("sha256");
  let manifestCount = 0;
  let entrypointCount = 0;
  let sourceCount = 0;
  let sourceBytes = 0;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    incrementCount(languageCounts, record.language);
    incrementCount(categoryCounts, record.category);
    const slash = record.path.indexOf("/");
    incrementCount(moduleCounts, slash < 0 ? "(root)" : record.path.slice(0, slash));
    if (record.category === "source" || record.category === "test") {
      sourceCount += 1;
      sourceBytes += record.size;
    }

    const baseName = recordBaseName(record.path);
    const lowerBaseName = baseName.toLowerCase();
    if (record.category === "manifest") {
      manifestCount += 1;
      insertBoundedProfilePath(manifests, record.path, MAX_PROFILE_MANIFESTS);
    }
    if (ENTRYPOINT_NAME_PATTERN.test(baseName)) {
      entrypointCount += 1;
      insertBoundedProfilePath(entrypoints, record.path, MAX_PROFILE_ENTRYPOINTS);
    }
    detectVerificationTarget(detected, slash < 0 ? lowerBaseName : "", lowerBaseName);

    const json = JSON.stringify(record);
    indexLines[index] = json;
    if (index > 0) indexHash.update("\n");
    indexHash.update(json);
  }

  return {
    languages: sortedCounts(languageCounts),
    categories: sortedCounts(categoryCounts),
    modules: sortedCounts(moduleCounts),
    manifests,
    manifestCount,
    entrypoints,
    entrypointCount,
    detected,
    indexHash: indexHash.digest("hex"),
    index: indexLines.join("\n") + (records.length ? "\n" : ""),
    sourceCount,
    sourceBytes,
  };
}

function appendCountLines(lines, entries, limit, emptyText, omittedLabel, codeNames = false) {
  if (entries.length === 0) {
    lines.push(emptyText, "");
    return;
  }
  const visible = Math.min(entries.length, limit);
  for (let index = 0; index < visible; index++) {
    const name = codeNames ? markdownCode(entries[index][0]) : safeDisplayText(entries[index][0], "(unnamed)");
    lines.push(`- ${name}: ${entries[index][1]} files`);
  }
  if (entries.length > visible) lines.push(`- ${entries.length - visible} additional ${omittedLabel} omitted`);
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

function buildProfile(manifest, records, stats, verification, codeGraphRecommended) {
  const lines = [
    "# Project Context", "",
    "> Generated by `/project-refresh`. Edit project rules in `AGENTS.md`; refresh this file instead of editing it manually.", "",
    "## Identity", "",
    `- Name: ${safeDisplayText(manifest.name, "(unnamed project)")}`,
    `- Stable ID: \`${manifest.id}\``,
    `- Indexed files: ${records.length}`,
    `- Source and test files: ${stats.sourceCount}`,
    `- Lightweight index SHA-256: \`${stats.indexHash}\``, "",
  ];
  lines.push("## Languages", "");
  appendCountLines(lines, stats.languages, MAX_PROFILE_LANGUAGES, "- No recognized source languages", "languages");
  lines.push("## Main Areas", "");
  appendCountLines(lines, stats.modules, MAX_PROFILE_MAIN_AREAS, "- None", "areas", true);
  lines.push("## Manifests", "");
  appendPathLines(lines, stats.manifests, stats.manifestCount, "- None detected", "query `.super-pi/project-index.jsonl` for category `manifest`.");
  lines.push("## Likely Entrypoints", "");
  appendPathLines(lines, stats.entrypoints, stats.entrypointCount, "- None detected", "query `.super-pi/project-index.jsonl` by filename.");
  lines.push("## Verification Candidates", "");
  if (verification.length === 0) lines.push("- No standard verification command detected; confirm project-specific checks in `AGENTS.md`.");
  else for (const command of verification) lines.push(`- ${markdownCode(command)}`);
  lines.push("", "## Index Summary", "");
  for (const [name, count] of stats.categories) lines.push(`- ${name}: ${count}`);
  lines.push("", "## Deep Index Recommendation", "", codeGraphRecommended
    ? "- CodeGraph may be useful: this project crossed the lightweight source-size threshold. Install or initialize it only after explicit approval."
    : "- The lightweight index is sufficient at the current size; CodeGraph is not recommended by default.", "");
  return `${lines.join("\n")}\n`;
}

export function buildArtifacts(root, manifest, records) {
  const stats = collectArtifactStats(records);
  const verification = verificationCommands(root, stats.detected);
  const codeGraphRecommended = stats.sourceCount >= 500 || stats.sourceBytes >= 20 * 1024 * 1024;
  return {
    profile: buildProfile(manifest, records, stats, verification, codeGraphRecommended),
    index: stats.index,
    sourceCount: stats.sourceCount,
    sourceBytes: stats.sourceBytes,
    codeGraphRecommended,
  };
}

export function projectAgentsTemplate() {
  return `# Project Instructions\n\n## Context\n\n- Read \`${CONFIG_DIR_NAME}/project-context.md\` for the generated repository profile.\n- Query \`${CONFIG_DIR_NAME}/project-index.jsonl\` for fast path/category lookup before broad scans.\n- Search Hermes memory or prior sessions only when the user explicitly asks to search, recall, remember, or revisit earlier information.\n- Refresh generated context with \`/project-refresh\` after structural changes.\n\n## Local Rules\n\n- Add project-specific architecture, coding, verification, and release rules here.\n- Preserve the global rule: do not commit, push, or open a PR without explicit user approval for the current task.\n`;
}

const TRANSACTION_MARKER = ".project-context-transaction.json";

function transactionMarkerPath(root) {
  return path.join(root, CONTEXT_DIR, TRANSACTION_MARKER);
}

export function recoverProjectTransaction(root) {
  const markerPath = transactionMarkerPath(root);
  if (!fs.existsSync(markerPath)) return false;
  assertSafeTarget(root, markerPath);
  const stat = fs.lstatSync(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe project-context transaction marker: ${markerPath}`);
  let transaction;
  try { transaction = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { throw new Error(`Invalid project-context transaction marker: ${markerPath}`); }
  const expectedTargets = [PROFILE_NAME, INDEX_NAME];
  if (transaction?.version !== 1 || !Array.isArray(transaction.entries) || transaction.entries.length !== 2) {
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
  for (const entry of entries) {
    if (fs.existsSync(entry.backup)) {
      if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target);
      fs.renameSync(entry.backup, entry.target);
    } else if (!entry.hadPrevious && fs.existsSync(entry.target)) {
      fs.unlinkSync(entry.target);
    }
    try { fs.unlinkSync(entry.staged); } catch {}
  }
  fs.unlinkSync(markerPath);
  return true;
}

export function atomicWritePairIfChanged(root, entries, operations = fs) {
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error("A project context refresh must contain exactly two artifacts.");
  recoverProjectTransaction(root);
  const snapshots = entries.map(({ target, content }) => {
    assertSafeTarget(root, target);
    let previous = null;
    try { previous = fs.readFileSync(target, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { target, content, previous, changed: previous !== content };
  });
  if (!snapshots.some((entry) => entry.changed)) return snapshots.map(() => false);

  const token = `${process.pid}.${randomUUID()}`;
  const staged = snapshots.map((entry) => `${entry.target}.${token}.tmp`);
  const backups = snapshots.map((entry) => `${entry.target}.${token}.backup`);
  for (const candidate of [...staged, ...backups]) assertSafeTarget(root, candidate);
  const markerPath = transactionMarkerPath(root);
  assertSafeTarget(root, markerPath);
  const marker = {
    version: 1,
    entries: snapshots.map((entry, index) => ({
      target: path.basename(entry.target),
      staged: path.basename(staged[index]),
      backup: path.basename(backups[index]),
      hadPrevious: entry.previous !== null,
    })),
  };
  durableWriteExclusive(markerPath, `${JSON.stringify(marker)}\n`);
  let completed = false;
  try {
    snapshots.forEach((entry, index) => durableWriteExclusive(staged[index], entry.content));
    snapshots.forEach((entry, index) => {
      if (entry.previous !== null) operations.renameSync(entry.target, backups[index]);
    });
    snapshots.forEach((entry, index) => operations.renameSync(staged[index], entry.target));
    completed = true;
    return snapshots.map((entry) => entry.changed);
  } catch (error) {
    try {
      recoverProjectTransaction(root);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Project context refresh failed; recovery marker remains at ${markerPath}.`);
    }
    throw error;
  } finally {
    if (completed) {
      for (const candidate of [...staged, ...backups]) {
        try { fs.unlinkSync(candidate); } catch {}
      }
      try { fs.unlinkSync(markerPath); } catch {}
    }
  }
}

function refreshResolved(resolved) {
  const records = scanProject(resolved.root);
  const artifacts = buildArtifacts(resolved.root, resolved.manifest, records);
  const contextDir = path.join(resolved.root, CONTEXT_DIR);
  const [profileChanged, indexChanged] = atomicWritePairIfChanged(resolved.root, [
    { target: path.join(contextDir, PROFILE_NAME), content: artifacts.profile },
    { target: path.join(contextDir, INDEX_NAME), content: artifacts.index },
  ]);
  return { ...resolved, ...artifacts, records, profileChanged, indexChanged };
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
    const agentsPath = path.join(root, "AGENTS.md");
    const agentsCreated = fs.existsSync(agentsPath) ? false : createExclusiveFile(root, agentsPath, projectAgentsTemplate());
    const resolved = { root, marker, manifest, initialized: true, gitRoot: initial.gitRoot };
    return { ...refreshResolved(resolved), agentsCreated, alreadyInitialized: wasInitialized };
  });
}

export function refreshProject(cwd) {
  const resolved = resolveProject(cwd);
  if (!resolved.initialized) throw new Error("Project context is not initialized. Run /project-init first.");
  return withProjectLock(resolved.root, () => refreshResolved(resolveProject(cwd)));
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
    const config = JSON.parse(fs.readFileSync(path.join(agentDir, "hermes-memory-config.json"), "utf8"));
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

export function codeGraphAvailability() {
  const local = process.env.LOCALAPPDATA;
  const executable = local ? path.join(local, "codegraph", "current", "node.exe") : null;
  const cli = local ? path.join(local, "codegraph", "current", "lib", "dist", "bin", "codegraph.js") : null;
  return { available: Boolean(executable && cli && fs.existsSync(executable) && fs.existsSync(cli)), executable, cli };
}

export function getStatus(cwd, agentDir) {
  const resolved = resolveProject(cwd);
  const hermes = detectHermes(resolved.root, cwd, agentDir);
  const codeGraph = codeGraphAvailability();
  let indexedFiles = null;
  let indexFresh = false;
  let codeGraphRecommended = false;
  if (resolved.initialized) {
    const profile = path.join(resolved.root, CONTEXT_DIR, PROFILE_NAME);
    const index = path.join(resolved.root, CONTEXT_DIR, INDEX_NAME);
    if (fs.existsSync(profile) && fs.existsSync(index)) {
      const savedProfile = fs.readFileSync(profile, "utf8");
      const savedIndex = fs.readFileSync(index, "utf8");
      indexedFiles = savedIndex.split("\n").filter(Boolean).length;
      const currentArtifacts = buildArtifacts(resolved.root, resolved.manifest, scanProject(resolved.root));
      indexFresh = savedIndex === currentArtifacts.index && savedProfile === currentArtifacts.profile;
      codeGraphRecommended = currentArtifacts.codeGraphRecommended;
    }
  }
  return { ...resolved, hermes, codeGraph, indexedFiles, indexFresh, codeGraphRecommended };
}
