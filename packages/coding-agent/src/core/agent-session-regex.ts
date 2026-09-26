/** Shared patterns for Session parsing/metadata; consumers create no regex objects. */
export const SKILL_BLOCK_PATTERN = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;
export const COMPACTION_ERROR_NEWLINE_PATTERN = /[\r\n]+/gu;
export const PROMPT_SNIPPET_NEWLINE_PATTERN = /[\r\n]+/g;
export const PROMPT_SNIPPET_WHITESPACE_PATTERN = /\s+/g;
export const EXTENSION_LABEL_BRACKET_PATTERN = /[<>]/g;
export const EXTENSION_SOURCE_SUFFIX_PATTERN = /\.(ts|js)$/;
export const SESSION_EXPORT_TIMESTAMP_PATTERN = /[:.]/g;
