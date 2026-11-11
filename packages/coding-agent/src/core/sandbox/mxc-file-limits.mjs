// Shared by the controlled worker, host validator and tool schema. UTF-16
// budgets are not byte capacities; the JSON envelope has its own byte limit.
export const FILE_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 16 * 1024 * 1024;
export const READ_LINES = 2000;
export const SEARCH_ROWS = 200;
export const SEARCH_ENTRIES = 20000;
export const TEXT_LIMIT = 32768;
export const SEARCH_EXCERPT = 256;
export const FILE_PROTOCOL_LIMIT = 256 * 1024;
export const SEARCH_CLIPPED_MARK = ' ...';
export const DIRECTORY_READ_BUFFER = 32;

// Preserve the effective legacy read window for direct and schema-validated calls.
export function normalizeReadOffset(offset) {
  return Math.max(1, Math.ceil(Number(offset ?? 1)) || 1);
}
export function normalizeReadLimit(limit) {
  return Math.max(0, Math.min(READ_LINES, Math.ceil(Number(limit ?? READ_LINES)) || 0));
}
