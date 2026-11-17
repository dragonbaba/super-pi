import { codemodeFailureReason } from "./codemode-display.ts";
import { truncateTail } from "./tools/truncate.ts";

const CHILD_DIAGNOSTIC_CHARS = 512;
const FAILURE_TAIL_OPTIONS = Object.freeze({ maxLines: 4, maxBytes: 1024 });
const OUTPUT_PREFIX = "\nOutput: ";

/** Error completion only; source and UI compare the same bounded diagnostic. */
export function codemodeChildDiagnostic(preview: string): string {
	return preview.length <= CHILD_DIAGNOSTIC_CHARS ? preview
		: codemodeFailureReason(preview, "model") + "\n" + truncateTail(preview.slice(-1024), FAILURE_TAIL_OPTIONS).content;
}

export function codemodeChildDiagnosticEnd(text: string, offset: number, preview: string, outputPath?: string): number {
	const diagnostic = codemodeChildDiagnostic(preview);
	if (!text.startsWith(diagnostic, offset)) return -1;
	let end = offset + diagnostic.length;
	if (outputPath) {
		if (!text.startsWith(OUTPUT_PREFIX, end) || !text.startsWith(outputPath, end + OUTPUT_PREFIX.length)) return -1;
		end += OUTPUT_PREFIX.length + outputPath.length;
	}
	return end;
}

export function codemodeIsChildFailure(text: string, ref: string | undefined, preview: string, outputPath?: string): boolean {
	if (!ref || text.charCodeAt(0) !== 91 || !text.startsWith(ref, 1) || !text.startsWith("] ", ref.length + 1)) return false;
	return codemodeChildDiagnosticEnd(text, ref.length + 3, preview, outputPath) === text.length;
}

export function codemodeTruncatedSuccessSuffix(toolName: string): string {
	return `; successful ${toolName.slice(0, 80)} output is truncated. Its content is display text, not a complete document. Inspect the existing Output path when available. Do not repeat completed commands.`;
}
