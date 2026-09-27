export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const READ_RESULT_ANNOTATION_PATTERN = /^(?:\[Input repair\]|\[Snapshot edit\]|\[TLG:|\[False-success guard\]|\[FSG:)/u;
export const UNSAFE_NATIVE_PATH_PATTERN = /[\u0000\r\n*?]/u;
export const UNSAFE_RECEIPT_PATH_PATTERN = /\u0000/u;
export const NATIVE_ERROR_CATEGORY_PATTERN = /^\[([^\]]+)\]/u;

export const SNAPSHOT_LINE_REFERENCE_PATTERN = "^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:[1-9]\\d*#[A-F0-9]{4}(?:\\|[^\\r\\n]*)?|>>> [1-9]\\d*#[A-F0-9]{4}\\|[^\\r\\n]*)[ \\t]*$";
export const SNAPSHOT_LINE_REFERENCE_REGEX = new RegExp(SNAPSHOT_LINE_REFERENCE_PATTERN, "u");


export const SNAPSHOT_ID_PATTERN = "^snap_[A-Za-z0-9_-]{22}$";
export const EDIT_INDEX_PATTERN = /edits\[(\d+)\]/u;

export const WINDOWS_BATCH_COMPONENT_PATTERN = /(?:[. ]$|:|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$))/iu;
export const WINDOWS_PATH_SEPARATOR_PATTERN = /[\\/]/u;

export const SNAPSHOT_ID_REGEX = new RegExp(SNAPSHOT_ID_PATTERN, "u");
export const PREVIEW_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu;
export const DISPLAY_METADATA_CONTROL_PATTERN = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
export const CHANGE_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
export const OBSERVATION_UNSIGNED_INTEGER_PATTERN = /^\d{1,30}$/u;
export const OBSERVATION_SIGNED_INTEGER_PATTERN = /^-?\d{1,30}$/u;
export const RETAINED_COMMIT_NAME_PATTERN = /^\.pi-file-commit-\d+-[a-f0-9]{24}\.tmp$/u;
export const LINE_ID_PATTERN = /^([1-9]\d*)#([A-F0-9]{4})$/u;
export const DISPLAYED_LINE_PATTERN = /^([1-9]\d*)#[A-F0-9]{4}\|(.*?)(\r?)$/u;
