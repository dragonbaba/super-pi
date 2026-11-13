/** typescript-language-server's ServerInitializingIndicator reports this task
 * for project loading. Unrelated work-done progress does not prove readiness. */
export const TYPESCRIPT_PROJECT_PROGRESS_TITLE = "Initializing JS/TS language features…";
export const PROJECT_READY_TIMEOUT_MS = 10_000;
// Readiness metadata bounds; overflow remains unconfirmed, never a tool refusal.
export const MAX_PROJECT_PROGRESS_TOKENS = 64;
export const MAX_PROJECT_PROGRESS_TOKEN_CHARS = 1024;
