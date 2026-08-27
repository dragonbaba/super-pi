import { piMessagesApi } from "../api/pi-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadRadiusOAuth } from "../auth/oauth/load.ts";
import {
	legacyRuntimeProfileDiagnostics,
	stripModelProfileMetadata,
	stripModelRuntimeProfile,
	withModelProfile,
} from "../model-capabilities.ts";
import { MODELS_STORE_PROFILE_REVISION } from "../models-store.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModels,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
	normalizeRadiusGatewayUrl,
} from "./radius-config.ts";

export interface RadiusProviderOptions {
	id?: string;
	name?: string;
	gateway?: string;
}

function profileRadiusModel(
	model: Model<"pi-messages">,
	legacyRuntimeProfile = false,
): Model<"pi-messages"> {
	const legacyDiagnostics = legacyRuntimeProfile ? legacyRuntimeProfileDiagnostics(model) : undefined;
	const raw = legacyRuntimeProfile
		? stripModelRuntimeProfile(model)
		: stripModelProfileMetadata(model);
	return withModelProfile(raw, "provider-catalog", {
		capabilities: raw.capabilities,
		costKnown: raw.costKnown ?? true,
		diagnostics: legacyDiagnostics,
	});
}

/** Radius gateway provider with a persisted, dynamically refreshed catalog. */
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	const id = options.id ?? "radius";
	const name = options.name ?? "Radius";
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	let models = getRadiusModels(id, undefined);
	const streams = piMessagesApi();

	return {
		id,
		name,
		auth: {
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
			oauth: lazyOAuth({ name, load: () => loadRadiusOAuth({ name, gateway }) }),
		},
		profileModel: profileRadiusModel,
		getModels: () => models,
		refreshModels: async (context) => {
			const stored = context.stored;
			if (stored) {
				const legacyRuntimeProfile = stored.profileRevision !== MODELS_STORE_PROFILE_REVISION;
				const restored = stored.models
					.filter((model) => model.provider === id)
					.map((model) => profileRadiusModel(model as Model<"pi-messages">, legacyRuntimeProfile));
				if (
					!(await context.publish({
						persist: legacyRuntimeProfile ? stored : undefined,
						migrateLegacyProfile: legacyRuntimeProfile,
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			// Import catalogs cached by the pre-ModelsStore Radius implementation.
			if (!stored && context.credential?.type === "oauth") {
				const legacy = getRadiusModels(id, context.credential);
				if (legacy.length > 0) {
					const profiled = legacy.map((model) => profileRadiusModel(model));
					if (
						!(await context.publish({
							persist: {
								models: legacy,
								checkedAt: Date.now(),
							},
							update: () => {
								models = profiled;
							},
						}))
					) {
						return;
					}
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			const config = await loadRadiusGatewayConfig(gateway, apiKey, context.signal);
			if (context.signal.aborted) return;
			const refreshed = getRadiusModelsFromConfig(id, config);
			const profiled = refreshed.map((model) => profileRadiusModel(model));
			await context.publish({
				persist: {
					models: refreshed,
					checkedAt: Date.now(),
				},
				update: () => {
					models = profiled;
				},
			});
		},
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
