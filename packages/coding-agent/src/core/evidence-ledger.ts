import { createHash } from "node:crypto";

export const EVIDENCE_MAX_RECORDS = 128;
// Leave 64 KiB of the session's 256 KiB envelope for completed read handoffs
// awaiting message_end. Those receipts are never lookup candidates or waiters.
export const EVIDENCE_MAX_METADATA_BYTES = 192 * 1024;
export const EVIDENCE_MAX_ARGUMENT_BYTES = 64 * 1024;
export const EVIDENCE_MAX_LOCATIONS = 64;
export const EVIDENCE_MAX_LOCATION_CHARS = 8 * 1024;

export type EvidenceMissReason = "disabled" | "ineligible-tool" | "no-record" | "args-mismatch" |
	"workspace-generation" | "branch/session/cwd" | "file-generation" | "source-not-active" |
	"source-not-in-context" | "artifact-unavailable" | "mutable-hook" | "uncertain-identity";

export interface EvidenceRecordV1 {
	readonly version: 1;
	readonly evidenceId: string;
	readonly toolKind: "builtin-read";
	readonly canonicalArgsHash: string;
	readonly scopeFingerprint: string;
	readonly resultHandle: string;
	readonly sourceToolCallId: string;
	readonly sourceGeneration: number;
	readonly relativePath: string;
	readonly location: string;
	readonly createdTurn: number;
	readonly workspaceGeneration: number;
	readonly branchGeneration: number;
	readonly canonicalPath: string;
	readonly fileGeneration: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly blocks: number;
	readonly chars: number;
	readonly artifactBytes: number;
	readonly modelTokens: number;
}

export function createEvidenceCounters() {
	return {
		lookups: 0, hits: 0, misses: 0,
		missesByReason: {
			"disabled": 0, "ineligible-tool": 0, "no-record": 0, "args-mismatch": 0,
			"workspace-generation": 0, "branch/session/cwd": 0, "file-generation": 0,
			"source-not-active": 0, "source-not-in-context": 0, "artifact-unavailable": 0,
			"mutable-hook": 0, "uncertain-identity": 0,
		},
		recordsCreated: 0, recordsEvicted: 0, recordsInvalidated: 0, entries: 0, entryHighWaterMark: 0,
		metadataBytes: 0, metadataBytesHighWaterMark: 0, realReadExecutions: 0,
		realReadExecutionsPrevented: 0, modelVisibleTokensAvoided: 0,
		argumentBytesHashed: 0, scopeBytesHashed: 0, canonicalArgumentHashes: 0, scopeFingerprintHashes: 0,
		g2ArtifactIntegrityScans: 0, g2ArtifactIntegrityBytes: 0,
		completeFileHashes: 0, ledgerOwnedResultHashes: 0, completeResultCopies: 0,
		retainedSourceReferences: 0, hashSkippedFileGenerationMisses: 0, hashSkippedNonresidentArtifactMisses: 0,
	};
}

// Conservative accounting includes UTF-16 backing storage and fixed per-entry
// object/Map overhead. No input object, array, source, callback or owner is kept.
export function evidenceMetadataBytes(r: EvidenceRecordV1): number {
	return 512 + 2 * (r.evidenceId.length + r.canonicalArgsHash.length + r.scopeFingerprint.length +
		r.resultHandle.length + r.sourceToolCallId.length + r.relativePath.length + r.location.length +
		r.canonicalPath.length + r.fileGeneration.length + r.sessionId.length + r.cwd.length);
}

// Admission is not lookup. Detach bounded strings so a short substring cannot
// keep an unrelated, unusually large caller backing string alive after eviction.
function ownMetadata(value: string): string { return Buffer.from(value, "utf16le").toString("utf16le"); }

export class EvidenceLedger {
	readonly counters = createEvidenceCounters();
	workspaceGeneration = 0;
	branchGeneration = 0;
	private records = new Map<string, EvidenceRecordV1>();
	private disposed = false;

	hashArguments(material: string): string | undefined {
		if (material.length > EVIDENCE_MAX_ARGUMENT_BYTES) return undefined;
		const bytes = Buffer.byteLength(material);
		if (bytes > EVIDENCE_MAX_ARGUMENT_BYTES) return undefined;
		this.counters.argumentBytesHashed += bytes;
		this.counters.canonicalArgumentHashes++;
		return createHash("sha256").update(material).digest("hex");
	}

	hashScope(material: string): string | undefined {
		if (material.length > EVIDENCE_MAX_ARGUMENT_BYTES) return undefined;
		const bytes = Buffer.byteLength(material);
		if (bytes > EVIDENCE_MAX_ARGUMENT_BYTES) return undefined;
		this.counters.scopeBytesHashed += bytes;
		this.counters.scopeFingerprintHashes++;
		return createHash("sha256").update(material).digest("hex");
	}

	lookup(key: string): EvidenceRecordV1 | undefined {
		this.counters.lookups++;
		return this.disposed ? undefined : this.records.get(key);
	}

	miss(reason: EvidenceMissReason): void {
		this.counters.misses++;
		this.counters.missesByReason[reason]++;
	}

	hit(tokensAvoided: number): void {
		this.counters.hits++;
		this.counters.realReadExecutionsPrevented++;
		this.counters.modelVisibleTokensAvoided += Math.max(0, tokensAvoided);
	}

	admit(input: EvidenceRecordV1): boolean {
		if (this.disposed || input.version !== 1 || input.toolKind !== "builtin-read" ||
			input.location.length > EVIDENCE_MAX_LOCATION_CHARS || input.blocks !== 1 ||
			!Number.isSafeInteger(input.chars) || input.chars < 1 || input.chars > 64 * 1024 ||
			input.workspaceGeneration !== this.workspaceGeneration || input.branchGeneration !== this.branchGeneration ||
			input.evidenceId.length > 512 || input.sourceToolCallId.length > 256 || input.canonicalArgsHash.length > 64 ||
			input.scopeFingerprint.length > 64 || input.resultHandle.length > 1024 || input.relativePath.length > 1024 ||
			input.canonicalPath.length > 4096 || input.cwd.length > 4096 || input.sessionId.length > 256 || input.fileGeneration.length > 512) return false;
		const bytes = evidenceMetadataBytes(input);
		if (bytes > EVIDENCE_MAX_METADATA_BYTES) return false;
		// Copy only the allowlisted primitive fields. Extra runtime properties are
		// deliberately not spread into the ledger's ownership graph.
		const record: EvidenceRecordV1 = {
			version: 1, evidenceId: ownMetadata(input.evidenceId), toolKind: "builtin-read",
			canonicalArgsHash: ownMetadata(input.canonicalArgsHash), scopeFingerprint: ownMetadata(input.scopeFingerprint),
			resultHandle: ownMetadata(input.resultHandle), sourceToolCallId: ownMetadata(input.sourceToolCallId),
			sourceGeneration: input.sourceGeneration,
			relativePath: ownMetadata(input.relativePath), location: ownMetadata(input.location), createdTurn: input.createdTurn,
			workspaceGeneration: input.workspaceGeneration, branchGeneration: input.branchGeneration,
			canonicalPath: ownMetadata(input.canonicalPath), fileGeneration: ownMetadata(input.fileGeneration),
			sessionId: ownMetadata(input.sessionId), cwd: ownMetadata(input.cwd), blocks: input.blocks, chars: input.chars,
			artifactBytes: input.artifactBytes, modelTokens: input.modelTokens,
		};
		this.invalidate(record.canonicalArgsHash);
		while (this.records.size >= EVIDENCE_MAX_RECORDS || this.counters.metadataBytes + bytes > EVIDENCE_MAX_METADATA_BYTES) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) return false;
			this.remove(oldest);
			this.counters.recordsEvicted++;
		}
		this.records.set(record.canonicalArgsHash, record);
		this.counters.recordsCreated++;
		this.counters.entries = this.records.size;
		this.counters.metadataBytes += bytes;
		this.counters.entryHighWaterMark = Math.max(this.counters.entryHighWaterMark, this.counters.entries);
		this.counters.metadataBytesHighWaterMark = Math.max(this.counters.metadataBytesHighWaterMark, this.counters.metadataBytes);
		return true;
	}

	private remove(key: string): boolean {
		const record = this.records.get(key);
		if (!record) return false;
		this.records.delete(key);
		this.counters.metadataBytes -= evidenceMetadataBytes(record);
		this.counters.entries = this.records.size;
		return true;
	}

	invalidate(key: string): void {
		if (this.remove(key)) this.counters.recordsInvalidated++;
	}

	clear(): void {
		this.counters.recordsInvalidated += this.records.size;
		this.records.clear();
		this.counters.entries = 0;
		this.counters.metadataBytes = 0;
	}

	mutate(): void { this.workspaceGeneration++; this.clear(); }
	changeBranch(): void { this.branchGeneration++; this.clear(); }
	dispose(): void { this.disposed = true; this.clear(); }
}
