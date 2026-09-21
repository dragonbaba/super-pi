/** Fixed patterns used only by the final Node parse-error preview. */
export const ANSI_SGR_PATTERN = /\x1b\[[\d;]*m/gu;
export const NODE_PARSE_LOCATION_PATTERN = /^(?:\[eval\]:\d+(?::\d+)?|(?:file:\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*\.(?:cjs|mjs|js|ts)(?::\d+(?::\d+)?)?)\s*$/iu;
