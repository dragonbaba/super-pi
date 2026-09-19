import { ANTHROPIC_SUBSCRIPTION_DISABLED, rejectAnthropicSubscription } from "../anthropic-subscription.ts";
import type { OAuthAuth } from "../types.ts";

// Compatibility tombstone: old imports fail locally without callback servers or token requests.
export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic subscription OAuth (disabled; use API key)",
	loginLabel: "Subscription OAuth disabled — migrate to API key",
	isSubscription: true,
	disabledReason: ANTHROPIC_SUBSCRIPTION_DISABLED,
	async login() {
		return rejectAnthropicSubscription();
	},
	async refresh() {
		return rejectAnthropicSubscription();
	},
	async toAuth() {
		return rejectAnthropicSubscription();
	},
};
