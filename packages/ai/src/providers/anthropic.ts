import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { assertSupportedAnthropicToken, rejectAnthropicSubscription } from "../auth/anthropic-subscription.ts";
import { anthropicOAuth } from "../auth/oauth/anthropic.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV } from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			interaction.signal.throwIfAborted();
			assertSupportedAnthropicToken(key);
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				assertSupportedAnthropicToken(credential.key);
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}

			const retiredToken = await ctx.env(ANTHROPIC_OAUTH_TOKEN_ENV);
			signal.throwIfAborted();
			if (retiredToken) rejectAnthropicSubscription();
			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			if (authToken) {
				assertSupportedAnthropicToken(authToken);
				return {
					auth: { headers: { Authorization: `Bearer ${authToken}` } },
					source: ANTHROPIC_AUTH_TOKEN_ENV,
				};
			}

			const apiKey = await ctx.env(ANTHROPIC_API_KEY_ENV);
			signal.throwIfAborted();
			if (apiKey) {
				assertSupportedAnthropicToken(apiKey);
				return { auth: { apiKey }, source: ANTHROPIC_API_KEY_ENV };
			}
			return undefined;
		},
	};
}

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: anthropicApiKeyAuth(),
			oauth: anthropicOAuth,
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
