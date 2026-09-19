import type { ProviderHeaders } from "../types.ts";

export const ANTHROPIC_SUBSCRIPTION_DISABLED =
	"[ANTHROPIC_SUBSCRIPTION_DISABLED] Super Pi's built-in Claude subscription OAuth is disabled. " +
	"No request was sent. Do not retry automatically. Explicitly configure an Anthropic Console API key " +
	"using API-key login or an explicit request key (separate API billing). Stored credentials and history " +
	"are unchanged; no fallback key is selected. See docs/repairs/session-clean-timeout-boundaries.md.";

export function rejectAnthropicSubscription(): never {
	throw new Error(ANTHROPIC_SUBSCRIPTION_DISABLED);
}

/** Recognize the retired credential format, not arbitrary Bearer/proxy credentials. */
export function assertSupportedAnthropicToken(token: string | null | undefined): void {
	if (token?.trim().startsWith("sk-ant-oat")) rejectAnthropicSubscription();
}

export function assertSupportedAnthropicHeaders(headers: ProviderHeaders | undefined): void {
	if (!headers) return;
	const names = Object.keys(headers);
	for (let index = 0; index < names.length; index++) {
		const name = names[index]!;
		const key = name.toLowerCase();
		const value = headers[name]?.trim();
		if (key === "x-api-key") assertSupportedAnthropicToken(value);
		if (key === "authorization" && value?.slice(0, 7).toLowerCase() === "bearer ") {
			assertSupportedAnthropicToken(value.slice(7));
		}
	}
}
