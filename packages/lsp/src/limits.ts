export const MAX_COLLECTED_FILES = 200;
export const MAX_REQUESTED_PATHS = 200;
export const DEFAULT_FILE_LIMIT = 50;
// Existing per-extension admission bound; unchanged by diagnostic serialization.
export const MAX_ACTIVE_OPERATIONS = 8;
// Open/wait/close concurrency, independent of the total collection limit.
export const DIAGNOSTIC_BATCH_SIZE = 16;
export const MIN_DIAGNOSTIC_WAIT_MS = 1;
export const MAX_DIAGNOSTIC_WAIT_MS = 120_000;
