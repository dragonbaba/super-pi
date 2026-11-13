// Fixed byte budgets shared by native owners, the controlled MXC worker,
// public schemas and tests. None is a limit on the number of target items.
export const FILE_MUTATION_TEXT_BYTES = 1024 * 1024;
export const FILE_OBSERVATION_HASH_BYTES = 32 * 1024 * 1024;
export const FILE_RPC_REQUEST_BYTES = 4 * 1024 * 1024;
export const FILE_RPC_REPLY_BYTES = 256 * 1024;
export const FILE_RESULT_PAGE_BYTES = 64 * 1024;
export const FILE_RESULT_PAYLOAD_BYTES = 54 * 1024;
export const FILE_RESULT_REFERENCE_CHARACTERS = 4096;
export const FILE_RESULT_CURSOR_CHARACTERS = 4096;
export const FILE_RPC_REPLY_HEADER_BYTES = 8192;
export const FILE_RPC_ITEM_METADATA_BYTES = 4096;
export const FILE_RPC_CONTROL_BYTES = 4096;
export const FILE_RESULT_PAGE_RECORDS = 128;
export const FILE_RESULT_PAGE_HEADER_BYTES = 8192;
export const FILE_RESULT_RECORD_WRAPPER_BYTES = 2048;
export const FILE_RESULT_REASON_BYTES = 800;
export const FILE_RESULT_FAILURE_SAMPLES = 8;
export const FILE_RESULT_PREVIEW_SAMPLES = 8;
export const FILE_RESULT_INLINE_ITEMS = 16;
export const FILE_RESULT_INLINE_BYTES = 16 * 1024;
export const FILE_STREAM_BUFFER_BYTES = 64 * 1024;
export const FILE_MANIFEST_RECORD_BYTES = 54 * 1024;
