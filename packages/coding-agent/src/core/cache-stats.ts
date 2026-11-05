import type { AssistantMessage } from "@super-pi/ai";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

/** Display threshold, not a provider cache-breakpoint or retention guarantee. */
const NOISE_FLOOR_TOKENS = 1024;

/** Length-only bound; neither shared content nor cache eligibility is proven. */
export interface CacheOverlapEstimate {
	uncachedOverlapUpperBound: number;
}

export interface CacheOverlapTotals {
	uncachedOverlapUpperBound: number;
	estimatedTurns: number;
}

interface PreviousRequest {
	promptTokens: number;
	provider: string;
	model: string;
	api: string;
	/** Cache activity observed in this uninterrupted provider/model/API segment. */
	reportedCache: boolean;
}

function promptTokens(message: AssistantMessage): number {
	if (message.stopReason === "error" || message.stopReason === "aborted") return 0;
	const usage = message.usage;
	if (!Number.isFinite(usage.input) || usage.input < 0 ||
		!Number.isFinite(usage.cacheRead) || usage.cacheRead < 0 ||
		!Number.isFinite(usage.cacheWrite) || usage.cacheWrite < 0) return 0;
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	return Number.isFinite(total) ? total : 0;
}

function sameModel(prev: PreviousRequest, message: AssistantMessage): boolean {
	return prev.provider === message.provider && prev.model === message.model && prev.api === message.api;
}

function estimateOverlap(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
): CacheOverlapEstimate | undefined {
	const usage = message.usage;
	const tokens = promptTokens(message);
	if (!prev || !sameModel(prev, message) || tokens <= 0 ||
		(usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	// This assumes at most length overlap. It does not inspect prompt content,
	// account, transport, retention, or provider cache eligibility/expiry.
	// Cache reads may belong to new rather than shared content. Subtract them
	// from the current prompt before bounding by the previous prompt's length.
	const uncachedOverlapUpperBound = Math.min(prev.promptTokens, tokens - usage.cacheRead);
	return uncachedOverlapUpperBound > NOISE_FLOOR_TOKENS ? { uncachedOverlapUpperBound } : undefined;
}

function asPreviousRequest(message: AssistantMessage, prev: PreviousRequest | undefined): PreviousRequest | undefined {
	const usage = message.usage;
	const tokens = promptTokens(message);
	if (tokens <= 0) return undefined;
	return {
		promptTokens: tokens,
		provider: message.provider,
		model: message.model,
		api: message.api,
		reportedCache: usage.cacheRead + usage.cacheWrite > 0 || !!(prev?.reportedCache && sameModel(prev, message)),
	};
}

function scan(
	entries: SessionEntry[],
): { prev: PreviousRequest | undefined; totals: CacheOverlapTotals; estimates: Map<AssistantMessage, CacheOverlapEstimate> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheOverlapTotals = { uncachedOverlapUpperBound: 0, estimatedTurns: 0 };
	const estimates = new Map<AssistantMessage, CacheOverlapEstimate>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// Do not compare lengths across an explicit history boundary.
			prev = undefined;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const estimate = estimateOverlap(prev, entry.message);
			if (estimate) {
				totals.uncachedOverlapUpperBound += estimate.uncachedOverlapUpperBound;
				totals.estimatedTurns++;
				estimates.set(entry.message, estimate);
			}
			prev = asPreviousRequest(entry.message, prev);
		}
	}
	return { prev, totals, estimates };
}

/**
 * Sum of per-turn length upper bounds, not measured waste or avoidable cost.
 */
export function computeCacheOverlapTotals(entries: SessionEntry[]): CacheOverlapTotals {
	return scan(entries).totals;
}

/**
 * Re-derive optional transcript estimates on resume/rebuild. The returned Map
 * owns message references only until its caller finishes rendering the entries.
 */
export function collectCacheOverlapEstimates(
	entries: SessionEntry[],
): Map<AssistantMessage, CacheOverlapEstimate> {
	return scan(entries).estimates;
}

/**
 * Estimate a length bound on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
export function detectCacheOverlapEstimate(
	entries: SessionEntry[],
	message: AssistantMessage,
): CacheOverlapEstimate | undefined {
	return estimateOverlap(scan(entries).prev, message);
}

/** Optional live consumer: persisted append tail plus one pre-persistence preview. */
export class CacheOverlapCursor {
	private manager: SessionManager | undefined;
	private generation = -1;
	private cursor = 0;
	private previous: PreviousRequest | undefined;
	private latest: WeakRef<AssistantMessage> | undefined;
	private probing: AssistantMessage | undefined;
	private alreadyPersisted = false;

	estimate(manager: SessionManager, message: AssistantMessage): CacheOverlapEstimate | undefined {
		if (!manager.isHistoryConsistent()) {
			this.clear();
			return undefined;
		}
		if (this.manager === manager && this.latest?.deref() === message) return undefined;
		const generation = manager.getContextGeneration();
		const rebuild = this.manager !== manager || this.generation !== generation;
		this.probing = message;
		this.alreadyPersisted = false;
		try {
			if (rebuild) {
				this.previous = undefined;
				this.manager = manager;
				this.generation = generation;
				// Branch navigation is explicit; never borrow the last appended response of another branch.
				const branch = manager.getBranch();
				for (let index = 0; index < branch.length; index++) this.visitSessionEntry(branch[index]!);
				this.cursor = manager.getAppendCursor();
			} else {
				this.cursor = manager.visitAppendedEntries(this.cursor, this);
			}
			this.latest = new WeakRef(message);
			return this.alreadyPersisted ? undefined : estimateOverlap(this.previous, message);
		} catch (error) {
			this.clear();
			throw error;
		} finally {
			this.probing = undefined;
		}
	}

	visitSessionEntry(entry: SessionEntry): void {
		if (entry.type === "compaction" || entry.type === "branch_summary") this.previous = undefined;
		else if (entry.type === "message" && entry.message.role === "assistant") {
			if (entry.message === this.probing) this.alreadyPersisted = true;
			this.previous = asPreviousRequest(entry.message, this.previous);
		}
	}

	clear(): void {
		this.manager = undefined;
		this.generation = -1;
		this.cursor = 0;
		this.previous = undefined;
		this.latest = undefined;
		this.probing = undefined;
		this.alreadyPersisted = false;
	}
}
