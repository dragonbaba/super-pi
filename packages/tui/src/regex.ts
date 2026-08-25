/** Shared regular expressions for terminal rendering, input parsing, and text formatting. */

export const ZERO_WIDTH_PATTERN = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
export const LEADING_NON_PRINTING_PATTERN =
	/^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
export const NON_PRINTING_CHARACTER_PATTERN =
	/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
export const MARK_CHARACTER_PATTERN = /^\p{Mark}$/v;
export const TERMINAL_SPACING_MARK_PATTERN =
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
export const RGI_EMOJI_PATTERN = /^\p{RGI_Emoji}$/v;
export const CJK_BREAK_PATTERN =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

export const TAB_PATTERN = /\t/g;
export const CARRIAGE_RETURN_PATTERN = /\r/g;
export const CRLF_PATTERN = /\r\n/g;
export const LINE_FEED_PATTERN = /\n/g;
export const LINE_BREAK_PATTERN = /\r\n|\r|\n/;
export const OSC8_HYPERLINK_PATTERN = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/;
export const THAI_LAO_AM_PATTERN = /[\u0e33\u0eb3]/;
export const ANSI_SEQUENCE_FINAL_PATTERN = /[mGKHJ]/;
export const SGR_PARAMETERS_PATTERN = /\x1b\[([\d;]*)m/;

export const FUZZY_ALPHA_NUMERIC_PATTERN = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/;
export const FUZZY_NUMERIC_ALPHA_PATTERN = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/;
export const FUZZY_TOKEN_SEPARATOR_PATTERN = /[\s/]+/;

export const PASTE_MARKER_PATTERN = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
export const PASTE_MARKER_EXACT_PATTERN = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
export const REGEX_CHARACTER_CLASS_ESCAPE_PATTERN = /[\\^$.*+?()[\]{}|-]/g;
export const CTRL_MODIFIED_CODEPOINT_PATTERN = /\x1b\[(\d+);5u/g;

export const KITTY_CSI_U_PATTERN = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
export const KITTY_ARROW_KEY_PATTERN = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/;
export const KITTY_FUNCTION_KEY_PATTERN = /^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/;
export const KITTY_HOME_END_PATTERN = /^\x1b\[1;(\d+)(?::(\d+))?([HF])$/;
export const MODIFY_OTHER_KEYS_PATTERN = /^\x1b\[27;(\d+);(\d+)~$/;
export const UNMODIFIED_KITTY_PRINTABLE_PATTERN = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/;
export const KITTY_FLAGS_PATTERN = /^\x1b\[\?(\d+)u$/;
export const DEVICE_ATTRIBUTES_PATTERN = /^\x1b\[\?[\d;]*c$/;
export const DEVICE_ATTRIBUTES_PREFIX_PATTERN = /^\x1b\[\?[\d;]*$/;
export const SGR_MOUSE_PAYLOAD_PATTERN = /^<\d+;\d+;\d+[Mm]$/;
export const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
export const OSC133_ZONE_PREFIX_PATTERN = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
export const OSC133_PROMPT_START_PATTERN = /^\x1b\]133;A(?:\x07|\x1b\\)/;

export const LATEX_SCRIPT_OPERATOR_SPACING_PATTERN = /\s*([=+-])\s*/g;
export const ASCII_LETTERS_PATTERN = /^[A-Za-z]+$/;
export const LATEX_SIMPLE_VALUE_PATTERN = /^[\p{L}\p{N}.]+$/u;
export const LATEX_SIMPLE_DENOMINATOR_PATTERN = /^[\p{N}.]+$/u;
export const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
export const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;
export const HORIZONTAL_WHITESPACE_RUN_PATTERN = /[ \t]+/g;
export const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
export const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
export const LATEX_LIMIT_MODIFIER_PATTERN = /^\\(limits|nolimits)(?![A-Za-z])/;
export const LATEX_ENVIRONMENT_ROW_PATTERN = /\\\\(?:\[[^\]\n]*\])?/;
export const LATEX_LEADING_ARRAY_SPEC_PATTERN = /^\s*\{[^}]*\}/;
export const LATEX_TRAILING_COMMA_PATTERN = /,\s*$/;
export const LATEX_CONDITION_PREFIX_PATTERN = /^(?:if|when|for|otherwise)\b/i;

export const MARKDOWN_STRICT_STRIKETHROUGH_PATTERN = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
export const MARKDOWN_PENDING_MATH_PATTERN = /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/;
export const MARKDOWN_DOLLAR_WHITESPACE_PATTERN = /^\$\s/;
export const MARKDOWN_TRAILING_WHITESPACE_PATTERN = /\s$/;
export const MARKDOWN_LEADING_DIGIT_PATTERN = /^\d/;
export const MARKDOWN_ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/;
export const MARKDOWN_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
export const MARKDOWN_DOLLAR_BLOCK_PATTERN = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/;
export const MARKDOWN_BRACKET_BLOCK_PATTERN = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/;
export const MARKDOWN_PENDING_BRACKET_BLOCK_PATTERN = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/;
export const MARKDOWN_PENDING_DOLLAR_BLOCK_PATTERN = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/;
export const MARKDOWN_BLOCK_START_PATTERN = /(?:^|\n) {0,3}(?:\$\$|\\\[)/;
export const MARKDOWN_FENCE_START_PATTERN = /^(`{3,}|~{3,})/;
export const TRAILING_LINE_FEED_PATTERN = /\n$/;
export const ANSI_RESET_PATTERN = /\x1b\[0m/g;
export const MARKDOWN_ORDERED_LIST_MARKER_PATTERN = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/;
export const MARKDOWN_UNORDERED_LIST_MARKER_PATTERN = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/;

export const KITTY_IMAGE_CONTROLS_PATTERN = /\x1b_G([^;]*);/;
export const KITTY_IMAGE_ID_CONTROL_PATTERN = /(?:^|,)i=(\d+)(?:,|$)/;
export const KITTY_IMAGE_MORE_CHUNKS_PATTERN = /(?:^|,)m=1(?:,|$)/;
export const KITTY_IMAGE_CROP_CONTROL_PATTERN = /^[yhr]=/;
