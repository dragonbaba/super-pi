/** Chat Completions protocol/state fields that cannot be supplied through generation sampling params. */
export const OPENAI_CHAT_SAMPLING_RESERVED_KEYS: ReadonlySet<string> = new Set([
	"model", "messages", "input", "instructions", "audio", "function_call", "functionCall", "functions",
	"max_completion_tokens", "max_tokens", "metadata", "modalities", "n",
	"parallel_tool_calls", "prediction", "previous_response_id", "prompt_cache_key", "prompt_cache_retention",
	"prompt_cache_options", "cache_control", "cachePoint", "cachedContent", "reasoning", "reasoning_effort",
	"thinking", "response_format",
	"safety_identifier", "service_tier", "store", "stream", "stream_options",
	"tool_choice", "tools", "user", "web_search_options", "webSearchOptions",
]);

/** Responses/Azure Responses protocol/state fields excluded from generation sampling params. */
export const OPENAI_RESPONSES_SAMPLING_RESERVED_KEYS: ReadonlySet<string> = new Set([
	"model", "background", "context_management", "conversation", "function_call",
	"functionCall", "functions", "include", "input", "instructions", "messages", "max_output_tokens",
	"metadata", "parallel_tool_calls", "previous_response_id", "prompt", "prompt_cache_key",
	"prompt_cache_retention", "prompt_cache_options", "cache_control", "cachePoint", "cachedContent",
	"reasoning", "reasoning_effort", "thinking", "safety_identifier",
	"service_tier", "store", "stream", "stream_options", "text", "tool_choice", "tools",
	"truncation", "user", "web_search_options", "webSearchOptions",
]);
