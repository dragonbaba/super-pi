/** Fixed regular expressions used by grep input and output normalization. */

export const GREP_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g;
export const GREP_BACKSLASH_PATTERN = /\\/g;
export const GREP_CRLF_PATTERN = /\r\n/g;
export const GREP_CARRIAGE_RETURN_PATTERN = /\r/g;
export const GREP_TRAILING_LINE_FEED_PATTERN = /\n$/;
