// Pinned to the Anthropic strict-schema compatibility rules in upstream Pi 1.0.0.
// Keep these provider restrictions separate from other providers' schema support.
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
	"maxItems", "uniqueItems", "minContains", "maxContains", "minProperties", "maxProperties",
]);
const STRING_FORMATS: ReadonlySet<string> = new Set([
	"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

export function isAnthropicStrictUnsupportedKeyword(key: string, value: unknown): boolean {
	if (UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !STRING_FORMATS.has(value);
	return false;
}
