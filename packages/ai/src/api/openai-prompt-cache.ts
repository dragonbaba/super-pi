import { createHash } from "node:crypto";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const OPENAI_PROMPT_CACHE_KEY_HASH_LENGTH = 24;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	const suffix = createHash("sha256").update(key).digest("hex").slice(0, OPENAI_PROMPT_CACHE_KEY_HASH_LENGTH);
	const readableLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - OPENAI_PROMPT_CACHE_KEY_HASH_LENGTH - 1;
	return `${chars.slice(0, readableLength).join("")}-${suffix}`;
}
