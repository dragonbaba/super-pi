#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

if (!("Bun" in globalThis)) {
	throw new Error("This helper must run with Bun so SQLite ABI compatibility is deterministic.");
}

const [mode, memoryDirectoryArgument, sessionsDirectoryArgument] = process.argv.slice(2);
if ((mode !== "--check" && mode !== "--index") || !memoryDirectoryArgument) {
	throw new Error("Usage: bun scripts/migrate-pi-memory-db.mjs <--check|--index> <memory-directory> [sessions-directory]");
}
if (mode === "--index" && !sessionsDirectoryArgument) {
	throw new Error("--index requires the migrated sessions directory.");
}

const memoryDirectory = resolve(memoryDirectoryArgument);
const databasePath = resolve(memoryDirectory, "sessions.db");

function scalar(database, sql) {
	const row = database.query(sql).get();
	return Number(Object.values(row ?? {})[0] ?? 0);
}

function inspectReadOnly() {
	const database = new Database(databasePath, { readonly: true, strict: true });
	try {
		const quickCheckRows = database.query("PRAGMA quick_check").all();
		const quickCheck = quickCheckRows.map((row) => String(Object.values(row)[0] ?? ""));
		const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all().length;
		return {
			quickCheck,
			foreignKeyViolations,
			sessions: scalar(database, "SELECT COUNT(*) FROM sessions"),
			messages: scalar(database, "SELECT COUNT(*) FROM messages"),
			memories: scalar(database, "SELECT COUNT(*) FROM memories"),
			sessionFiles: scalar(database, "SELECT COUNT(*) FROM session_files"),
		};
	} finally {
		database.close();
	}
}

if (mode === "--check") {
	console.log(JSON.stringify(inspectReadOnly()));
	process.exit(0);
}

const { DatabaseManager } = await import("../packages/memory/dist/store/db.js");
const {
	countSessionFiles,
	indexAllSessions,
	touchBackfillTimestamp,
} = await import("../packages/memory/dist/store/session-indexer.js");

const sessionsDirectory = resolve(sessionsDirectoryArgument);
const manager = new DatabaseManager(memoryDirectory);
let indexResult;
let indexedStats;
let discoveredSessionFiles;
try {
	discoveredSessionFiles = countSessionFiles(sessionsDirectory);
	indexResult = indexAllSessions(manager, sessionsDirectory);
	if (indexResult.errors.length > 0) {
		throw new Error(`Session indexing failed for ${indexResult.errors.length} file(s): ${indexResult.errors.join(" | ")}`);
	}
	if (indexResult.sessionsProcessed !== discoveredSessionFiles) {
		throw new Error(`Indexed ${indexResult.sessionsProcessed} of ${discoveredSessionFiles} discovered session file(s).`);
	}
	touchBackfillTimestamp(manager);
	indexedStats = manager.getStats();
} finally {
	manager.close();
}

console.log(JSON.stringify({
	discoveredSessionFiles,
	indexResult,
	indexedStats,
	verification: inspectReadOnly(),
}));
