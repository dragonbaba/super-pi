import {
	type Api,
	MODELS_STORE_PROFILE_REVISION,
	type Model,
	type ModelsStoreEntry,
	type Provider,
	legacyRuntimeProfileDiagnostics,
	stripModelProfileMetadata,
	stripModelRuntimeProfile,
	withModelProfile,
} from "@super-pi/ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { mergeCatalogModels } from "./model-catalog-merge.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
// Keep each provider request inside the caller's aggregate refresh budget. A slow
// catalog must fail independently instead of aborting every provider refresh.
const REMOTE_CATALOG_REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_CATALOG_MAX_RETRIES = 1;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => stripModelProfileMetadata({ ...model, provider: providerId }));
}

function remoteModelId(provider: Provider, model: Model<Api>): string {
	// Old cached and newly downloaded catalogs can still carry models.dev's
	// dotted Claude IDs. Canonicalize before precedence checks and merging;
	// provider profile hooks also run on user-defined models and are too broad.
	if (
		provider.id === "cloudflare-ai-gateway" &&
		model.api === "anthropic-messages" &&
		model.id.startsWith("claude-") &&
		model.id.includes(".")
	) {
		return model.id.replaceAll(".", "-");
	}
	return model.id;
}

function profileRemoteModel(provider: Provider, model: Model<Api>, legacyRuntimeProfile = false): Model<Api> {
	const legacyDiagnostics = legacyRuntimeProfile ? legacyRuntimeProfileDiagnostics(model) : undefined;
	const raw = legacyRuntimeProfile
		? stripModelRuntimeProfile(model)
		: stripModelProfileMetadata(model);
	raw.id = remoteModelId(provider, raw);
	const enriched = provider.profileModel?.(raw) ?? raw;
	return withModelProfile(enriched, "provider-catalog", {
		costKnown: enriched.costKnown ?? true,
		diagnostics: legacyDiagnostics,
	});
}

function remoteModels(
	provider: Provider,
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		// A newer bundle can correct existing definitions without containing every
		// remote model. Keep remote-only IDs; stale overlaps must not undo fixes.
		// This index is refresh-local, and canonical IDs prevent renamed aliases
		// from bypassing the built-in definition's precedence.
		const builtinIds = new Set<string>();
		for (const model of provider.getModels()) builtinIds.add(model.id);
		return entry.models.filter((model) =>
			model.provider === provider.id && !builtinIds.has(remoteModelId(provider, model)));
	}
	return entry.models;
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly Model<Api>[] = [];
	let mergedModels: readonly Model<Api>[] | undefined;

	return {
		...provider,
		getModels: () => (mergedModels ??= mergeCatalogModels(provider.getModels(), dynamicModels)),
		refreshModels: async (context) => {
			const stored = context.stored;
			const legacyRuntimeProfile = stored !== undefined && stored.profileRevision !== MODELS_STORE_PROFILE_REVISION;
			const restored = remoteModels(provider, stored, localGeneratedAt)
				.filter((model) => model.provider === provider.id)
				.map((model) => profileRemoteModel(provider, model, legacyRuntimeProfile));
			if (
				!(await context.publish({
					persist:
						stored && legacyRuntimeProfile ? stored : undefined,
					migrateLegacyProfile: legacyRuntimeProfile,
					update: () => {
						dynamicModels = restored;
						mergedModels = undefined;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored?.models.length ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{
					timeoutMs: REMOTE_CATALOG_REQUEST_TIMEOUT_MS,
					maxRetries: REMOTE_CATALOG_MAX_RETRIES,
				},
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
						lastModified: 0,
						etag: undefined,
					},
				});
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
					},
				});
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const rawRefreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry = {
				models: rawRefreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(provider, entry, localGeneratedAt).map((model) => profileRemoteModel(provider, model));
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
					mergedModels = undefined;
				},
			});
		},
	};
}
