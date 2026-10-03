/** Limits count UTF-16 code units unless explicitly named bytes. Immutable policy, no session state. */
export const MAX_CODE_CHARS = 128 * 1024;
export const MAX_ARGUMENT_CHARS = 256 * 1024;
export const MAX_VALUE_CHARS = 1024 * 1024;
export const MAX_OUTPUT_CHARS = 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 1024;
export const MAX_BRIDGE_CHARS = 8 * 1024 * 1024;
export const MAX_CALLS = 256;
export const MAX_TOOLS = 4096;
export const MAX_CATALOG_CHARS = 2 * 1024 * 1024;
export const MAX_STORE_VALUE_CHARS = 256 * 1024;
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
export const MAX_STORE_KEYS = 4096;
export const MAX_STORE_KEY_CHARS = 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
export const MAX_ERROR_CHARS = 16 * 1024;
