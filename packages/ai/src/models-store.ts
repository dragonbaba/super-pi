import type { Api, Model } from "./types.ts";
import { stripModelProfileMetadata, stripModelRuntimeProfile } from "./model-capabilities.ts";

export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	/** Raw-catalog schema revision. Missing means a legacy runtime-profiled cache. */
	profileRevision?: number;
	/** Unix timestamp from the remote catalog's Last-Modified header. */
	lastModified?: number;
	/** Unix timestamp of the last completed remote check. */
	checkedAt?: number;
	/**
	 * Opaque validator from the remote catalog's ETag header, stored verbatim
	 * (quotes included) and echoed back as If-None-Match.
	 */
	etag?: string;
}

export const MODELS_STORE_PROFILE_REVISION = 1;

/** Persist raw provider facts, optionally removing a pre-revision host-derived runtime profile. */
export function rawModelsStoreEntry(entry: ModelsStoreEntry, migrateLegacyProfile = false): ModelsStoreEntry {
	return {
		...entry,
		profileRevision: MODELS_STORE_PROFILE_REVISION,
		models: entry.models.map((model) => {
			if (!migrateLegacyProfile) return stripModelProfileMetadata(model);
			return stripModelRuntimeProfile(model);
		}),
	};
}

export interface ModelsStoreOperationOptions {
	signal?: AbortSignal;
}

/** Persistent model catalogs keyed by provider ID. */
export interface ModelsStore {
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}
