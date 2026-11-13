import { EMPTY_READONLY_ARRAY } from "./collections.ts";
import type { LspClient } from "./lsp-client.ts";
import { convertTypeScriptDiagnostics } from "./typescript-diagnostics.ts";
import type { DiagnosticReport, LspDiagnostic, SynchronousDiagnostics } from "./types.ts";

/** Explicit file-request setup. No diagnostic notification or waiter changes. */
export async function collectSynchronousDiagnostics(client: LspClient, file: string, capability: SynchronousDiagnostics, timeoutMs: number): Promise<DiagnosticReport> {
	const started = performance.now();
	const report: DiagnosticReport = { diagnostics: EMPTY_READONLY_ARRAY, receivedReport: false, completion: "report", elapsedMs: 0 };
	const diagnostics: LspDiagnostic[] = [];
	let request = "";
	try {
		for (request of capability.requests) {
			const response = await client.executeCommand(capability.command, [request, { file }], timeoutMs) as { success?: boolean; body?: unknown } | undefined;
			if (response?.success !== true || !Array.isArray(response.body)) throw new Error("No successful full diagnostic array.");
			for (const diagnostic of convertTypeScriptDiagnostics(response.body)) diagnostics.push(diagnostic);
		}
		report.diagnostics = diagnostics.length ? diagnostics : EMPTY_READONLY_ARRAY;
		report.receivedReport = true;
	} catch (error) {
		report.error = `${request}: ${error instanceof Error ? error.message : String(error)}`;
		report.completion = client.running ? "request_failed" : "server_error";
	}
	report.elapsedMs = performance.now() - started;
	return report;
}
