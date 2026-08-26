import assert from "node:assert/strict";
import test from "node:test";
import {
	clampOpenAIPromptCacheKey,
	OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "../packages/ai/src/api/openai-prompt-cache.ts";

test("short OpenAI prompt cache keys remain readable and unchanged", () => {
	assert.equal(clampOpenAIPromptCacheKey(undefined), undefined);
	assert.equal(clampOpenAIPromptCacheKey("session-readable"), "session-readable");
});

test("long cache keys with the same 64-character prefix retain distinct hash suffixes", () => {
	const sharedPrefix = "x".repeat(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	const first = clampOpenAIPromptCacheKey(`${sharedPrefix}-first-session`);
	const second = clampOpenAIPromptCacheKey(`${sharedPrefix}-second-session`);

	assert.notEqual(first, second);
	assert.equal(Array.from(first ?? "").length, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	assert.equal(Array.from(second ?? "").length, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	assert.match(first ?? "", /^x{39}-[a-f0-9]{24}$/);
	assert.match(second ?? "", /^x{39}-[a-f0-9]{24}$/);
});

test("cache key shortening counts Unicode code points without splitting them", () => {
	const shortened = clampOpenAIPromptCacheKey(`会话-${"🙂".repeat(80)}`);
	assert.equal(Array.from(shortened ?? "").length, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH);
	assert.equal((shortened ?? "").includes("�"), false);
});
