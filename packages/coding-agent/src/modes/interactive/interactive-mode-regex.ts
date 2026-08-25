/** Fixed regular expressions used by interactive mode command and path handling. */

export const SHELL_ARGUMENT_UNSAFE_CHARACTER_PATTERN = /[^a-zA-Z0-9_\-./~:@]/;
export const SHELL_ARGUMENT_APOSTROPHE_PATTERN = /'/g;
export const CHANGELOG_VERSION_HEADING_PATTERN = /##\s+\[?(\d+\.\d+\.\d+)\]?/;
export const TYPESCRIPT_INDEX_SUFFIX_PATTERN = /\/index\.ts$/;
export const JAVASCRIPT_INDEX_SUFFIX_PATTERN = /\/index\.js$/;
export const PATH_BACKSLASH_PATTERN = /\\/g;
export const NPM_PACKAGE_ROOT_PATTERN = /^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/;
export const NPM_PACKAGE_PATH_PATTERN = /node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/;
export const GIT_PACKAGE_PATH_PATTERN = /git\/[^/]+\/[^/]+\/(.*)/;
export const WHITESPACE_CHARACTER_PATTERN = /\s/;
export const NAME_COMMAND_PREFIX_PATTERN = /^\/name\s*/;
