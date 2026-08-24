import {
  ANSI_CSI_PATTERN,
  ANSI_ESCAPE_PATTERN,
  ANSI_OSC_PATTERN,
  ANSI_STRING_PATTERN,
  CONTROL_PATTERN,
  WHITESPACE_PATTERN,
} from "./regex.ts";

export const MAX_UI_FIELD = 180;
export const MAX_UI_ERROR = 500;

export function unknownSessionText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value.description ?? "";
  try { return `${value}`; } catch { return "[无法转换的值]"; }
}

export function sanitizeSessionText(value: unknown, maxLength = MAX_UI_FIELD): string {
  let text = unknownSessionText(value);
  text = text
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_STRING_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
