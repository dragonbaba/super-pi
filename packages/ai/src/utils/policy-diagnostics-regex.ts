export const POLICY_FEEDBACK_WHITESPACE_PATTERN = /\s+/gu;
export const POLICY_FEEDBACK_URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s]+/giu;
export const POLICY_FEEDBACK_SECRET_PATTERN = /\b(?:(?:api[_-]?key|token|password|secret)\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)|authorization\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+))/giu;
export const POLICY_FEEDBACK_PATH_PATTERN = /(?:^|(?<=[\s=:]))(?:"(?:[A-Za-z]:[\\/]|\/)[^"\r\n]{16,}"|'(?:[A-Za-z]:[\\/]|\/)[^'\r\n]{16,}'|(?:[A-Za-z]:[\\/]|\/)[^\s,;)]{16,})/gu;
