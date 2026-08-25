/** Fixed regular expressions used while parsing and rendering diffs. */

export const DIFF_LINE_PATTERN = /^([+-\s])(\s*\d*)\s(.*)$/;
export const DIFF_TAB_PATTERN = /\t/g;
export const DIFF_WHITESPACE_CHARACTER_PATTERN = /^\s$/;
