export function unknownText(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value.description ?? "symbol";
  try { return `${value}`; } catch { return "[unprintable value]"; }
}
