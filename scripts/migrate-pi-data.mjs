#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	lstat,
	open,
	readFile,
	readdir,
	rename,
	rm,
	rmdir,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_FILE_NAME = ".pi-data-migration-v1.json";
const TOOL_STORE_RELATIVE = join("state", "tool-repairs", "tool-repairs-v1.json");
const MEMORY_DATABASE_RELATIVE = join("@super-pi", "memory", "sessions.db");
const MAX_TOOL_BUCKETS = 4_096;
const MAX_TOOL_HASHES = 16_384;
const MAX_TOOL_RETENTION_DAYS = 90;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const argumentsList = process.argv.slice(2);
const modeArguments = argumentsList.filter((argument) => argument === "--apply" || argument === "--check");
const unknownArguments = argumentsList.filter((argument) => argument !== "--apply" && argument !== "--check");
if (unknownArguments.length > 0 || modeArguments.length > 1) {
	throw new Error("Usage: node scripts/migrate-pi-data.mjs [--apply|--check]");
}
const mode = modeArguments[0] ?? "--dry-run";

const sourceAgentDirectory = resolve(homedir(), ".pi", "agent");
const targetAgentDirectory = resolve(homedir(), ".sp", "agent");
const receiptPath = join(targetAgentDirectory, RECEIPT_FILE_NAME);
const sourceMemoryDatabasePath = join(sourceAgentDirectory, "pi-hermes-memory", "sessions.db");
const targetMemoryDatabasePath = join(targetAgentDirectory, MEMORY_DATABASE_RELATIVE);

const mappings = [
	{
		label: "sessions",
		source: join(sourceAgentDirectory, "sessions"),
		target: join(targetAgentDirectory, "sessions"),
		exclude: () => false,
	},
	{
		label: "projects-memory",
		source: join(sourceAgentDirectory, "projects-memory"),
		target: join(targetAgentDirectory, "projects-memory"),
		exclude: (relativePath) => isLockArtifact(relativePath),
	},
	{
		label: "extension-memory",
		source: join(sourceAgentDirectory, "pi-hermes-memory"),
		target: join(targetAgentDirectory, "@super-pi", "memory"),
		exclude: (relativePath, isDirectory) =>
			(isDirectory && firstPathSegment(relativePath) === ".consolidation-locks")
			|| isLockArtifact(relativePath)
			|| relativePath === ".skills-migrated-to-extension-storage"
			|| /(^|[\\/])sessions\.db-(?:wal|shm)$/.test(relativePath),
	},
];

function firstPathSegment(path) {
	return path.split(/[\\/]/, 1)[0];
}

function isLockArtifact(path) {
	return /(^|[\\/])\.pi-hermes-locks\.sqlite(?:-(?:wal|shm))?$/.test(path);
}

function portablePath(path) {
	return path.split(sep).join("/");
}

function pathInside(root, candidate) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertDirectory(path, label) {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a regular directory: ${path}`);
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
	try {
		return await readJson(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function fileHash(path) {
	const handle = await open(path, "r");
	const hash = createHash("sha256");
	try {
		for await (const chunk of handle.readableWebStream()) hash.update(chunk);
		return hash.digest("hex");
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function inspectRegularFile(path) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
	return { size: info.size, mtimeMs: info.mtimeMs, sha256: await fileHash(path) };
}

async function inspectIfPresent(path) {
	try {
		return await inspectRegularFile(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function collectMappingFiles(mapping) {
	await assertDirectory(mapping.source, `${mapping.label} source`);
	const files = [];
	const excluded = [];
	async function visit(directory, relativeDirectory = "") {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relativePath = join(relativeDirectory, entry.name);
			const sourcePath = join(mapping.source, relativePath);
			const targetPath = join(mapping.target, relativePath);
			const info = await lstat(sourcePath);
			if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in migration source: ${sourcePath}`);
			if (mapping.exclude(relativePath, info.isDirectory())) {
				excluded.push({ label: mapping.label, relativePath: portablePath(relativePath), type: info.isDirectory() ? "directory" : "file" });
				continue;
			}
			if (info.isDirectory()) {
				await visit(sourcePath, relativePath);
				continue;
			}
			if (!info.isFile()) throw new Error(`Refusing non-regular migration source entry: ${sourcePath}`);
			if (!pathInside(mapping.source, sourcePath) || !pathInside(mapping.target, targetPath)) {
				throw new Error(`Migration path escaped its mapping root: ${relativePath}`);
			}
			files.push({ mapping: mapping.label, relativePath: portablePath(relativePath), sourcePath, targetPath });
		}
	}
	await visit(mapping.source);
	return { files, excluded };
}

async function buildPlan() {
	await assertDirectory(sourceAgentDirectory, "Pi agent source");
	await assertDirectory(targetAgentDirectory, "Super Pi agent target");
	const mappingResults = await Promise.all(mappings.map(collectMappingFiles));
	const files = mappingResults.flatMap((result) => result.files);
	const excluded = mappingResults.flatMap((result) => result.excluded);
	for (const file of files) {
		file.source = await inspectRegularFile(file.sourcePath);
		file.target = await inspectIfPresent(file.targetPath);
		file.action = !file.target ? "copy" : file.target.sha256 === file.source.sha256 ? "unchanged" : "conflict";
	}
	return { files, excluded };
}

function bucketKey(bucket) {
	return [bucket.day, bucket.model, bucket.tool, bucket.category, bucket.outcome, bucket.version].join("\u0000");
}

function validateToolStore(value, label) {
	if (!value || typeof value !== "object" || value.schemaVersion !== 1 || typeof value.analyticsVersion !== "string"
		|| !Array.isArray(value.buckets) || value.buckets.length > MAX_TOOL_BUCKETS
		|| !Array.isArray(value.seenEventHashes) || value.seenEventHashes.length > MAX_TOOL_HASHES) {
		throw new Error(`Invalid ${label} tool-repair aggregate.`);
	}
	for (const bucket of value.buckets) {
		if (!bucket || typeof bucket !== "object" || !Number.isSafeInteger(bucket.count) || bucket.count < 1
			|| [bucket.day, bucket.model, bucket.tool, bucket.category, bucket.outcome, bucket.version].some((item) => typeof item !== "string")) {
			throw new Error(`Invalid bucket in ${label} tool-repair aggregate.`);
		}
	}
	if (value.seenEventHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{24}$/.test(hash))) {
		throw new Error(`Invalid event hash in ${label} tool-repair aggregate.`);
	}
	return value;
}

function mergeToolStores(source, target, now = new Date()) {
	validateToolStore(source, "Pi");
	validateToolStore(target, "Super Pi");
	if (source.analyticsVersion !== target.analyticsVersion) {
		throw new Error("Tool-repair analytics versions differ; refusing an ambiguous aggregate merge.");
	}
	const sourceHashes = new Set(source.seenEventHashes);
	const targetHashes = new Set(target.seenEventHashes);
	const overlap = target.seenEventHashes.filter((hash) => sourceHashes.has(hash)).length;
	const targetSubset = overlap === targetHashes.size;
	const sourceSubset = source.seenEventHashes.every((hash) => targetHashes.has(hash));
	if (overlap > 0 && !targetSubset && !sourceSubset) {
		throw new Error("Tool-repair event histories partially overlap; aggregate buckets cannot be merged without double counting.");
	}

	const base = sourceSubset ? target : source;
	const addition = sourceSubset ? undefined : targetSubset ? undefined : target;
	const buckets = new Map(base.buckets.map((bucket) => [bucketKey(bucket), { ...bucket }]));
	if (addition) {
		for (const bucket of addition.buckets) {
			const key = bucketKey(bucket);
			const current = buckets.get(key);
			if (current) current.count = Math.min(Number.MAX_SAFE_INTEGER, current.count + bucket.count);
			else buckets.set(key, { ...bucket });
		}
	}
	const orderedDays = [...new Set([...buckets.values()].map((bucket) => bucket.day))]
		.sort((left, right) => right.localeCompare(left));
	const keptDays = new Set(orderedDays.slice(0, MAX_TOOL_RETENTION_DAYS));
	const boundedBuckets = [...buckets.values()]
		.filter((bucket) => keptDays.has(bucket.day))
		.sort((left, right) => right.day.localeCompare(left.day)
			|| left.model.localeCompare(right.model)
			|| left.tool.localeCompare(right.tool)
			|| left.category.localeCompare(right.category)
			|| left.outcome.localeCompare(right.outcome)
			|| left.version.localeCompare(right.version))
		.slice(0, MAX_TOOL_BUCKETS);
	const orderedHashes = sourceSubset
		? [...target.seenEventHashes]
		: targetSubset
			? [...source.seenEventHashes]
			: [...source.seenEventHashes, ...target.seenEventHashes];
	return {
		store: {
			schemaVersion: 1,
			analyticsVersion: source.analyticsVersion,
			updatedAt: now.toISOString(),
			retentionDays: MAX_TOOL_RETENTION_DAYS,
			maxBuckets: MAX_TOOL_BUCKETS,
			buckets: boundedBuckets,
			seenEventHashes: [...new Set(orderedHashes)].slice(-MAX_TOOL_HASHES),
		},
		relation: { sourceHashes: sourceHashes.size, targetHashes: targetHashes.size, overlap, targetSubset, sourceSubset },
	};
}

function bunExecutable() {
	if (process.env.SP_BUN_EXECUTABLE) return resolve(process.env.SP_BUN_EXECUTABLE);
	const candidate = process.platform === "win32"
		? join(homedir(), ".bun", "bin", "bun.exe")
		: join(homedir(), ".bun", "bin", "bun");
	return candidate;
}

function runMemoryHelper(helperMode, memoryDirectory, sessionsDirectory) {
	const args = [join(scriptDirectory, "migrate-pi-memory-db.mjs"), helperMode, memoryDirectory];
	if (sessionsDirectory) args.push(sessionsDirectory);
	const result = spawnSync(bunExecutable(), args, { encoding: "utf8", windowsHide: true, timeout: 300_000 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Memory database helper failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
	const output = result.stdout.trim().split(/\r?\n/).at(-1);
	return JSON.parse(output);
}

function assertDatabaseHealth(result, label) {
	if (!result || !Array.isArray(result.quickCheck) || result.quickCheck.length !== 1
		|| result.quickCheck[0].toLowerCase() !== "ok" || result.foreignKeyViolations !== 0) {
		throw new Error(`${label} memory database failed SQLite verification.`);
	}
}

async function sourceDatabasePreflight() {
	const sourceMemoryDirectory = join(sourceAgentDirectory, "pi-hermes-memory");
	const sourceDatabasePath = join(sourceMemoryDirectory, "sessions.db");
	const wal = await inspectIfPresent(join(sourceMemoryDirectory, "sessions.db-wal"));
	if (wal && wal.size > 0) {
		throw new Error("Source sessions.db-wal contains uncheckpointed frames; close Pi before migration.");
	}
	const temporaryDirectory = join(tmpdir(), `super-pi-source-db-check-${process.pid}-${randomUUID()}`);
	if (!pathInside(tmpdir(), temporaryDirectory)) throw new Error("Temporary SQLite check directory escaped the OS temporary root.");
	await mkdir(temporaryDirectory);
	try {
		const sourceBefore = await inspectRegularFile(sourceDatabasePath);
		await copyFile(sourceDatabasePath, join(temporaryDirectory, "sessions.db"), fsConstants.COPYFILE_EXCL);
		const sourceAfter = await inspectRegularFile(sourceDatabasePath);
		if (sourceAfter.sha256 !== sourceBefore.sha256 || sourceAfter.size !== sourceBefore.size) {
			throw new Error("Pi source sessions.db changed while creating the verification snapshot.");
		}
		const result = runMemoryHelper("--check", temporaryDirectory);
		assertDatabaseHealth(result, "Pi source snapshot");
		return result;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function ensureParentDirectory(path, createdDirectories) {
	const parent = dirname(path);
	const pending = [];
	let cursor = parent;
	while (pathInside(targetAgentDirectory, cursor) && cursor !== targetAgentDirectory) {
		try {
			const info = await lstat(cursor);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Target parent is not a regular directory: ${cursor}`);
			break;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			pending.push(cursor);
			cursor = dirname(cursor);
		}
	}
	for (const directory of pending.reverse()) {
		await mkdir(directory);
		createdDirectories.push(directory);
	}
}

async function copyExclusive(file, createdFiles, createdDirectories) {
	await ensureParentDirectory(file.targetPath, createdDirectories);
	if (file.sourcePath === sourceMemoryDatabasePath) await assertSourceWalEmpty();
	await copyFile(file.sourcePath, file.targetPath, fsConstants.COPYFILE_EXCL);
	createdFiles.push(file.targetPath);
	await utimes(file.targetPath, file.source.mtimeMs / 1_000, file.source.mtimeMs / 1_000);
	const [sourceAfter, targetAfter] = await Promise.all([
		inspectRegularFile(file.sourcePath),
		inspectRegularFile(file.targetPath),
	]);
	if (sourceAfter.sha256 !== file.source.sha256 || sourceAfter.size !== file.source.size
		|| targetAfter.sha256 !== file.source.sha256 || targetAfter.size !== file.source.size) {
		throw new Error(`Copy verification failed: ${file.mapping}/${file.relativePath}`);
	}
	if (file.sourcePath === sourceMemoryDatabasePath) await assertSourceWalEmpty();
}

async function assertSourceWalEmpty() {
	const wal = await inspectIfPresent(`${sourceMemoryDatabasePath}-wal`);
	if (wal && wal.size > 0) {
		throw new Error("Source sessions.db-wal contains uncheckpointed frames; close Pi before migration.");
	}
}

async function writeAtomicJson(path, value, createdDirectories) {
	await ensureParentDirectory(path, createdDirectories);
	const temporary = join(dirname(path), `.${portablePath(path).split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function removeCreatedResources(createdFiles, createdDirectories) {
	for (const path of [...createdFiles].reverse()) await rm(path, { force: true }).catch(() => undefined);
	for (const path of [...createdDirectories].reverse()) await rmdir(path).catch(() => undefined);
}

function summarizePlan(plan) {
	const byMapping = {};
	for (const file of plan.files) {
		const summary = byMapping[file.mapping] ??= { files: 0, bytes: 0, copy: 0, unchanged: 0, conflicts: 0 };
		summary.files++;
		summary.bytes += file.source.size;
		summary[file.action === "conflict" ? "conflicts" : file.action]++;
	}
	return byMapping;
}

async function prepareToolMerge() {
	const sourcePath = join(sourceAgentDirectory, TOOL_STORE_RELATIVE);
	const targetPath = join(targetAgentDirectory, TOOL_STORE_RELATIVE);
	const [source, target, sourceFile, targetFile] = await Promise.all([
		readJson(sourcePath),
		readJson(targetPath),
		inspectRegularFile(sourcePath),
		inspectRegularFile(targetPath),
	]);
	const merged = mergeToolStores(source, target);
	return { sourcePath, targetPath, sourceFile, targetFile, ...merged };
}

async function verifyReceipt() {
	const receipt = await readJsonIfPresent(receiptPath);
	if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
		throw new Error(`Missing or unsupported migration receipt: ${receiptPath}`);
	}
	let verifiedFiles = 0;
	for (const entry of receipt.files) {
		const sourcePath = join(sourceAgentDirectory, ...entry.sourceRelative.split("/"));
		const targetPath = join(targetAgentDirectory, ...entry.targetRelative.split("/"));
		const source = await inspectRegularFile(sourcePath);
		if (source.sha256 !== entry.sourceSha256 || source.size !== entry.size) {
			throw new Error(`Pi source changed after migration: ${entry.sourceRelative}`);
		}
		if (entry.targetRelative !== portablePath(MEMORY_DATABASE_RELATIVE)) {
			const target = await inspectRegularFile(targetPath);
			if (target.sha256 !== entry.sourceSha256 || target.size !== entry.size) {
				throw new Error(`Migrated target differs: ${entry.targetRelative}`);
			}
		}
		verifiedFiles++;
	}
	const targetDatabase = runMemoryHelper("--check", join(targetAgentDirectory, "@super-pi", "memory"));
	assertDatabaseHealth(targetDatabase, "Super Pi target");
	for (const key of ["sessions", "messages", "memories", "sessionFiles"]) {
		if (targetDatabase[key] < receipt.database.target[key]) {
			throw new Error(`Target database ${key} count regressed below the migration receipt.`);
		}
	}
	const toolStore = await inspectRegularFile(join(targetAgentDirectory, TOOL_STORE_RELATIVE));
	if (toolStore.sha256 !== receipt.toolRepair.targetSha256) {
		throw new Error("Tool-repair aggregate changed after migration; re-run final verification before replacement.");
	}
	console.log(`Verified ${verifiedFiles} copied historical file(s).`);
	console.log(`SQLite: ${targetDatabase.sessions} sessions, ${targetDatabase.messages} messages, ${targetDatabase.memories} memories, ${targetDatabase.sessionFiles} indexed files.`);
	console.log(`Global Pi source remains unchanged: ${sourceAgentDirectory}`);
}

if (mode === "--check") {
	await verifyReceipt();
	process.exit(0);
}

const [plan, sourceDatabase, toolMerge] = await Promise.all([
	buildPlan(),
	sourceDatabasePreflight(),
	prepareToolMerge(),
]);
const databasePlanEntry = plan.files.find((file) =>
	file.mapping === "extension-memory" && file.relativePath === "sessions.db");
if (!databasePlanEntry) throw new Error("Pi memory database was not included in the migration plan.");

const conflicts = plan.files.filter((file) => file.action === "conflict");
const receiptExists = await readJsonIfPresent(receiptPath);
if (receiptExists) throw new Error(`A migration receipt already exists; use --check: ${receiptPath}`);
if (conflicts.length > 0) {
	for (const file of conflicts) console.error(`conflict ${file.mapping}/${file.relativePath}`);
	throw new Error(`${conflicts.length} target file(s) differ; refusing to overwrite historical data.`);
}
if (databasePlanEntry.action !== "copy") {
	throw new Error("Target sessions.db already exists without a migration receipt; refusing to mutate it.");
}

console.log(JSON.stringify({ mode: mode.slice(2), mappings: summarizePlan(plan), excludedRuntimeArtifacts: plan.excluded.length, database: sourceDatabase, toolRepair: toolMerge.relation }, null, 2));
if (mode === "--dry-run") {
	console.log("Dry-run only. Re-run with --apply to copy and index; the Pi source will remain read-only.");
	process.exit(0);
}

const createdFiles = [];
const createdDirectories = [];
const toolBackupPath = join(targetAgentDirectory, "backups", "pi-data-migration-v1", "tool-repairs-v1.before.json");
let toolStoreReplaced = false;
try {
	for (const file of plan.files) {
		if (file.action === "copy") await copyExclusive(file, createdFiles, createdDirectories);
	}

	const [currentToolSource, currentToolTarget] = await Promise.all([
		inspectRegularFile(toolMerge.sourcePath),
		inspectRegularFile(toolMerge.targetPath),
	]);
	if (currentToolSource.sha256 !== toolMerge.sourceFile.sha256
		|| currentToolTarget.sha256 !== toolMerge.targetFile.sha256) {
		throw new Error("Tool-repair aggregate changed after planning; refusing a stale merge.");
	}
	await ensureParentDirectory(toolBackupPath, createdDirectories);
	await copyFile(toolMerge.targetPath, toolBackupPath, fsConstants.COPYFILE_EXCL);
	createdFiles.push(toolBackupPath);
	const backup = await inspectRegularFile(toolBackupPath);
	if (backup.sha256 !== toolMerge.targetFile.sha256) throw new Error("Tool-repair backup verification failed.");
	await writeAtomicJson(toolMerge.targetPath, toolMerge.store, createdDirectories);
	toolStoreReplaced = true;

	const indexOutput = runMemoryHelper(
		"--index",
		join(targetAgentDirectory, "@super-pi", "memory"),
		join(targetAgentDirectory, "sessions"),
	);
	assertDatabaseHealth(indexOutput.verification, "Indexed Super Pi target");
	if (indexOutput.verification.memories < sourceDatabase.memories
		|| indexOutput.verification.messages < sourceDatabase.messages
		|| indexOutput.verification.sessions < sourceDatabase.sessions
		|| indexOutput.verification.sessionFiles < indexOutput.discoveredSessionFiles) {
		throw new Error("Indexed memory database did not preserve source rows or cover every migrated session file.");
	}

	const [targetDatabaseFile, targetToolFile] = await Promise.all([
		inspectRegularFile(databasePlanEntry.targetPath),
		inspectRegularFile(toolMerge.targetPath),
	]);
	const receipt = {
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		completedAt: new Date().toISOString(),
		sourceRoot: portablePath(sourceAgentDirectory),
		targetRoot: portablePath(targetAgentDirectory),
		files: plan.files.map((file) => ({
			mapping: file.mapping,
			sourceRelative: portablePath(relative(sourceAgentDirectory, file.sourcePath)),
			targetRelative: portablePath(relative(targetAgentDirectory, file.targetPath)),
			size: file.source.size,
			sourceSha256: file.source.sha256,
		})),
		excluded: plan.excluded,
		database: {
			source: sourceDatabase,
			target: indexOutput.verification,
			targetSha256: targetDatabaseFile.sha256,
			indexedSessionFiles: indexOutput.discoveredSessionFiles,
		},
		toolRepair: {
			relation: toolMerge.relation,
			sourceSha256: toolMerge.sourceFile.sha256,
			targetBeforeSha256: toolMerge.targetFile.sha256,
			targetSha256: targetToolFile.sha256,
			backupRelative: portablePath(relative(targetAgentDirectory, toolBackupPath)),
		},
	};
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	createdFiles.push(receiptPath);
	console.log(`Migrated ${plan.files.length} historical file(s); indexed ${indexOutput.discoveredSessionFiles} session file(s).`);
	console.log(`Receipt: ${receiptPath}`);
} catch (error) {
	if (toolStoreReplaced) {
		await copyFile(toolBackupPath, toolMerge.targetPath).catch(() => undefined);
	}
	for (const suffix of ["-wal", "-shm"]) await rm(`${targetMemoryDatabasePath}${suffix}`, { force: true }).catch(() => undefined);
	await removeCreatedResources(createdFiles, createdDirectories);
	throw error;
}

await verifyReceipt();
