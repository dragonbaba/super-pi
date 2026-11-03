// Manual metadata-only diagnostic. Never constructs a CLI, VM, or snapshot owner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireAcceptanceRoot } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { sha256 } from "./windows-sandbox-package.mjs";

const SOURCE = fileURLToPath(new URL("./windows-sandbox-clipboard-formats.cs", import.meta.url));
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const STATUSES = new Set(["complete", "open-failed", "close-failed", "enumeration-failed", "enumeration-cycle", "enumeration-limit", "name-unavailable", "metadata-changed-or-unavailable", "query-failed", "output-limit"]);
export function validateMetadata(value) {
	if (!value || value.protocol !== "super-pi-wsb-clipboard-formats-v1" || !STATUSES.has(value.status) || value.enumerationLimit !== 64 || value.acceptanceCountLimit !== 5
		|| !Array.isArray(value.formats) || value.formats.length > 64) throw new Error("Invalid metadata receipt");
	for (const flag of ["enumerationComplete", "namesComplete", "metadataStable", "opened", "closed"]) if (typeof value[flag] !== "boolean") throw new Error("Missing metadata completion flag");
	for (const key of ["error", "cleanupError"]) if (value[key] !== null && (typeof value[key] !== "string" || value[key].length > 512)) throw new Error("Invalid metadata error");
	for (const key of ["sequenceBefore", "sequenceAfter"]) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 4294967295) throw new Error("Invalid metadata sequence");
	for (const key of ["ownerBefore", "ownerAfter"]) if (value[key] !== null && (typeof value[key] !== "string" || !/^\d+$/.test(value[key]))) throw new Error("Invalid metadata owner");
	if (!Number.isInteger(value.sessionId) || value.sessionId < 0 || value.metadataStable && (value.sessionId === 0 || value.sequenceBefore === 0
		|| value.sequenceBefore !== value.sequenceAfter || value.ownerBefore === null || value.ownerBefore !== value.ownerAfter)) throw new Error("Unproven metadata stability");
	if (value.closed && !value.opened || value.enumerationComplete && !value.opened) throw new Error("Invalid metadata lifecycle");
	const expectedClass = !value.enumerationComplete ? "unknown" : value.formats.length === 0 ? "empty" : value.formats.length > 5 ? "over-acceptance-count" : "within-acceptance-count";
	if (value.countClass !== expectedClass || (value.enumerationComplete ? value.count !== value.formats.length : value.count !== null)) throw new Error("Incomplete enumeration cannot give an exact count");
	const seen = new Set(); let allNames = true;
	for (const format of value.formats) {
		if (!format || !Number.isInteger(format.id) || format.id < 1 || format.id > 0xFFFF || seen.has(format.id) || !Number.isInteger(format.nameError) || format.nameError < 0) throw new Error("Invalid metadata format identity");
		seen.add(format.id);
		if (format.id >= 0xC000) {
			if (format.nameStatus === "resolved") {
				if (typeof format.registeredName !== "string" || format.registeredName.length < 1 || format.registeredName.length >= 255 || format.nameError !== 0) throw new Error("Invalid registered name");
			} else {
				if (!["not-queried", "failed", "at-buffer-limit", "omitted-output-limit"].includes(format.nameStatus) || format.registeredName !== null) throw new Error("Invalid unresolved name");
				allNames = false;
			}
		} else if (format.registeredName !== null || format.nameStatus !== "not-registered" || format.nameError !== 0) throw new Error("Nonregistered format has a fabricated name");
	}
	if (value.namesComplete && (!allNames || !value.enumerationComplete) || value.status === "complete" && (!value.enumerationComplete || !value.namesComplete || !value.metadataStable || !value.closed || value.error !== null || value.cleanupError !== null)) throw new Error("Incomplete metadata cannot be complete");
	return value; // Metadata completion never grants acceptance to unknown formats or >5 items.
}
export async function runMetadataDiagnostic() {
	const resource = acquireAcceptanceRoot();
	const executable = path.join(resource.root, "formats-only.exe");
	const record = { taskId: randomUUID(), kind: "clipboard-format-metadata", state: "prepared", sourceSha256: null, compilerSha256: COMPILER_HASH, binarySha256: null,
		helperCalls: [], helperPendingPid: null, receipt: null, error: null, artifactRoot: resource.root, artifactsRemoved: false };
	const helpers = new OwnedHelperRunner(resource.root, () => {
		record.helperCalls = helpers.calls; record.helperPendingPid = helpers.active?.pid ?? null; resource.journal(record);
	});
	const controller = new AbortController(), cancel = () => controller.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	try {
		record.sourceSha256 = sha256(SOURCE); resource.journal(record);
		if (process.platform !== "win32" || sha256(COMPILER) !== COMPILER_HASH) throw new Error("Pinned local compiler changed");
		await helpers.run(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000, controller.signal);
		record.binarySha256 = sha256(executable); record.state = "querying-metadata"; resource.journal(record);
		if (controller.signal.aborted) throw new Error("Cancelled before metadata query");
		await helpers.run(executable, [], 5000, controller.signal); // Exactly one query, no retry.
	} catch (error) { record.error = String(error.message); }
	finally {
		process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
		const query = helpers.calls[1]?.result;
		if (query && !query.truncated) {
			try { record.receipt = validateMetadata(JSON.parse(query.stdout)); }
			catch (error) { record.error ??= String(error.message); }
		}
		record.helperCalls = helpers.calls; record.helperPendingPid = helpers.active?.pid ?? null;
		if (!helpers.active && helpers.calls.every(call => call.result?.closedUtc)) {
			// Shared artifact guard's terminal state: every helper physically ended; no VM was started.
			record.state = "closed-before-start"; resource.journal(record);
			resource.remove({ state: record.state, active: helpers.active }); record.artifactsRemoved = true;
		} else { record.state = "helper-exit-unconfirmed"; resource.journal(record); }
	}
	record.diagnosticComplete = !record.error && record.receipt?.status === "complete" && record.artifactsRemoved;
	process.stdout.write(JSON.stringify(record) + "\n"); return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("No arguments accepted");
	if (!(await runMetadataDiagnostic()).diagnosticComplete) process.exitCode = 1;
}
