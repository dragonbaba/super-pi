import { pathToFileURL } from "node:url";
import { EMPTY_READONLY_ARRAY } from "./collections.ts";
import type { LspDiagnostic, LspPosition, SynchronousDiagnostics } from "./types.ts";

const TYPESCRIPT_COMMAND = /(?:^|[\\/])typescript-language-server(?:\.(?:cmd|bat|ps1|exe))?$/iu;

export const TYPESCRIPT_SYNCHRONOUS_DIAGNOSTICS: SynchronousDiagnostics = Object.freeze({
	command: "typescript.tsserverRequest",
	requests: Object.freeze(["syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync"] as const),
	// The manual 1/4/16-file measurement selects this adapter-owned bound.
	maxConcurrentFiles: 1,
});

export function typescriptDiagnosticsCapability(name: string, command: string): SynchronousDiagnostics | undefined {
	return name === "typescript" || TYPESCRIPT_COMMAND.test(command) ? TYPESCRIPT_SYNCHRONOUS_DIAGNOSTICS : undefined;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tsserver diagnostic object.");
	return value as Record<string, unknown>;
}

function position(value: unknown): LspPosition {
	const item = record(value);
	if (!Number.isInteger(item.line) || (item.line as number) < 1 || !Number.isInteger(item.offset) || (item.offset as number) < 1) {
		throw new Error("Invalid tsserver diagnostic position.");
	}
	return { line: (item.line as number) - 1, character: (item.offset as number) - 1 };
}

/** Matches typescript-language-server 5.3's category mapping, including its
 * conservative Error default. Input and source files are never modified. */
export function convertTypeScriptDiagnostics(values: readonly unknown[], ignoredCodes: readonly unknown[] = EMPTY_READONLY_ARRAY): readonly LspDiagnostic[] {
	if (values.length === 0) return EMPTY_READONLY_ARRAY;
	const result: LspDiagnostic[] = [];
	for (const value of values) {
		const item = record(value);
		if (item.code !== undefined && ignoredCodes.includes(item.code)) continue;
		if (typeof item.text !== "string") throw new Error("Invalid tsserver diagnostic message.");
		if (item.code !== undefined && typeof item.code !== "number" && typeof item.code !== "string") throw new Error("Invalid tsserver diagnostic code.");
		const diagnostic: LspDiagnostic = {
			range: { start: position(item.start), end: position(item.end) },
			message: item.text,
			severity: item.category === "warning" ? 2 : item.category === "suggestion" ? 4 : 1,
			code: item.code,
			source: typeof item.source === "string" && item.source ? item.source : "typescript",
		};
		if (item.reportsUnnecessary || item.reportsDeprecated) {
			diagnostic.tags = [];
			if (item.reportsUnnecessary) diagnostic.tags.push(1);
			if (item.reportsDeprecated) diagnostic.tags.push(2);
		}
		if (item.relatedInformation !== undefined) {
			if (!Array.isArray(item.relatedInformation)) throw new Error("Invalid tsserver related information.");
			diagnostic.relatedInformation = [];
			for (const relatedValue of item.relatedInformation) {
				const related = record(relatedValue);
				if (!related.span) continue; // The language server also omits global spans.
				const span = record(related.span);
				if (typeof span.file !== "string" || !span.file || typeof related.message !== "string") throw new Error("Invalid tsserver related span.");
				diagnostic.relatedInformation.push({
					location: { uri: pathToFileURL(span.file).href, range: { start: position(span.start), end: position(span.end) } },
					message: related.message,
				});
			}
		}
		result.push(diagnostic);
	}
	return result;
}
