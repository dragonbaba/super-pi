export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const READ_RESULT_ANNOTATION_PATTERN = /^(?:\[Input repair\]|\[Snapshot edit\]|\[TLG:|\[False-success guard\]|\[FSG:)/u;
export const UNSAFE_NATIVE_PATH_PATTERN = /[\u0000\r\n*?]/u;
export const UNSAFE_RECEIPT_PATH_PATTERN = /[\u0000\r\n]/u;
export const NATIVE_ERROR_CATEGORY_PATTERN = /^\[([^\]]+)\]/u;

export const SNAPSHOT_LINE_REFERENCE_PATTERN = "^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:[1-9]\\d*#[A-F0-9]{4}(?:\\|[^\\r\\n]*)?|>>> [1-9]\\d*#[A-F0-9]{4}\\|[^\\r\\n]*)[ \\t]*$";
export const SNAPSHOT_LINE_REFERENCE_REGEX = new RegExp(SNAPSHOT_LINE_REFERENCE_PATTERN, "u");


export const SNAPSHOT_ID_PATTERN = "^snap_[A-Za-z0-9_-]{22}$";
export const EDIT_INDEX_PATTERN = /edits\[(\d+)\]/u;

export const WINDOWS_BATCH_COMPONENT_PATTERN = /(?:[. ]$|:|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$))/iu;
export const WINDOWS_PATH_SEPARATOR_PATTERN = /[\\/]/u;
