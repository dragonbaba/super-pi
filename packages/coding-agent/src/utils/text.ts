/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Remove one trailing line ending while preserving all other content. */
export function stripTrailingLineEnding(content: string): string {
	if (!content.endsWith("\n")) return content;
	return content.charCodeAt(content.length - 2) === 13 ? content.slice(0, -2) : content.slice(0, -1);
}
