export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const READ_RESULT_ANNOTATION_PATTERN = /^(?:\[Input repair\]|\[Snapshot edit\]|\[TLG:|\[False-success guard\]|\[FSG:)/u;
export const UNSAFE_NATIVE_PATH_PATTERN = /[\u0000\r\n*?]/u;
export const UNSAFE_RECEIPT_PATH_PATTERN = /[\u0000\r\n]/u;
export const NATIVE_ERROR_CATEGORY_PATTERN = /^\[([^\]]+)\]/u;
