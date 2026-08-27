/** Capability-controlled and cross-protocol fields never accepted as generation sampling parameters. */
export const OPENAI_COMMON_SAMPLING_RESERVED_KEYS: ReadonlySet<string> = new Set([
	"model", "stream", "store", "messages", "input", "instructions", "system", "systemInstruction",
	"tools", "tool_choice", "toolChoice", "parallel_tool_calls", "parallelToolCalls", "toolConfig",
	"max_tool_calls", "maxToolCalls", "functions", "function_call", "functionCall", "tool_calls", "tool_call_id",
	"web_search_options", "webSearchOptions", "previous_response_id", "previousResponseId",
	"reasoning", "reasoning_effort", "reasoningEffort", "thinking", "thinkingConfig", "thinking_token_budget",
	"include", "prompt_cache_key", "promptCacheKey", "prompt_cache_retention", "promptCacheRetention",
	"prompt_cache_options", "promptCacheOptions", "cache_control", "cacheControl", "cachePoint", "cacheRetention",
	"cachedContent", "strict",
]);

/** Chat Completions protocol/state fields that cannot be supplied through generation sampling params. */
export const OPENAI_CHAT_SAMPLING_RESERVED_KEYS: ReadonlySet<string> = new Set([
	...OPENAI_COMMON_SAMPLING_RESERVED_KEYS,
	"audio", "max_completion_tokens", "max_tokens", "metadata", "modalities", "n", "prediction",
	"response_format", "safety_identifier", "service_tier", "stream_options", "user",
]);

/** Responses/Azure Responses protocol/state fields excluded from generation sampling params. */
export const OPENAI_RESPONSES_SAMPLING_RESERVED_KEYS: ReadonlySet<string> = new Set([
	...OPENAI_COMMON_SAMPLING_RESERVED_KEYS,
	"background", "context_management", "conversation", "max_output_tokens", "metadata", "prompt",
	"safety_identifier", "service_tier", "stream_options", "text", "truncation", "user",
]);
