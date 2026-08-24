export const LEADING_AT_PATTERN = /^@/u;
export const PARENT_SEGMENT_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
export const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
export const BLOCKED_RG_FOLLOW_SHORT_OPTION_PATTERN = /^-[^-]*L/u;
export const BLOCKED_RG_EXECUTION_SHORT_OPTION_PATTERN = /^-[^-]*z/u;
export const GIT_NOT_REPOSITORY_PATTERN = /fatal:\s+not a git repository/iu;
export const RG_POSITIONAL_GLOB_PATTERN = /[*?\[\]{}]/u;
export const RG_DASH_PREFIXED_PATTERN_PATTERN = /^--[^=\r\n]*[|(){}\[\]+?\\^$.]/u;
export const RG_UNRECOGNIZED_FLAG_PATTERN = /(?:^|\n)rg:\s+unrecognized flag\b/iu;
