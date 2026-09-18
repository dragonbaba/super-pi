/** Fixed patterns shared by local image input and attachment display. */

// Predicates/splitters are non-global and non-sticky: calls share no cursor.
export const IMAGE_FILE_URI_PATTERN = /^file:/i;
export const IMAGE_NETWORK_PATH_PATTERN = /^[\\/]{2}/;
export const IMAGE_REMOTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
export const IMAGE_PATH_CONTROL_PATTERN = /[\r\n\x00]/;
export const IMAGE_FILE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif)$/i;
export const IMAGE_ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|\/|file:)/i;
export const CLIPBOARD_LINE_BREAK_PATTERN = /\r?\n/;
export const CLIPBOARD_WSL_RELEASE_PATTERN = /microsoft|wsl/i;
export const CLIPBOARD_IMAGE_LIMIT_PATTERN = /Image exceeds (pixel|byte) limit/;

// Global patterns are used only by replace with literal replacement strings.
// That operation resets lastIndex; never use these shared patterns with test/exec.
export const IMAGE_LABEL_CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
export const IMAGE_DESCRIPTION_LINE_BREAK_PATTERN = /\r\n?/g;
export const IMAGE_DESCRIPTION_CONTROL_PATTERN = /[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Bidi_Control}]/gu;
