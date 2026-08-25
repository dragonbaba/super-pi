export const SUPPORTED_SP_VERSION_PATTERN = /^0\.84\.\d+(?:[-+].*)?$/u;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TRAILING_SLASH_PATTERN = /\/+$/;
export const CRLF_PATTERN = /\r\n/g;
export const CARRIAGE_RETURN_PATTERN = /\r/g;
export const REMOTE_COMPACTION_UNSUPPORTED_FEATURE_PATTERN = /(?:compaction[_ -]?trigger|remote[_ -]?compaction[_ -]?v2)/iu;
export const REMOTE_COMPACTION_UNSUPPORTED_REASON_PATTERN = /(?:not supported|unsupported|unknown|unrecognized|not enabled|disabled|invalid (?:input )?(?:item )?(?:type|value))/iu;
