export interface ServerCommand {
	command: string;
	args: string[];
}

export interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
}

export interface LspSymbolInformation {
	name: string;
	kind: number;
	containerName?: string;
	location: LspLocation;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: string | number;
	codeDescription?: { href?: string };
	source?: string;
	message: string;
	tags?: number[];
	relatedInformation?: Array<{ location: LspLocation; message: string }>;
}

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface WorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: Array<{
		textDocument?: { uri?: string; version?: number | null };
		edits?: LspTextEdit[];
	}>;
}

export interface CodeAction {
	title: string;
	kind?: string;
	edit?: WorkspaceEdit;
	data?: unknown;
}

export interface DiagnosticEntry {
	path: string;
	uri: string;
	diagnostics: readonly LspDiagnostic[];
}
/** One explicit file request owns this observation; notifications only update its fields. */
export interface DiagnosticReport {
	diagnostics: readonly LspDiagnostic[];
	receivedReport: boolean;
	completion: "report" | "window_expired" | "server_error" | "request_failed";
	elapsedMs: number;
	projectReady?: boolean;
	projectReadyAtCompletion?: boolean;
	projectReadyForMs?: number;
	error?: string;
}

export interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface ConfiguredLspServer {
	command: string[];
	extensions: string[];
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
	skipDirectories?: string[];
	// Quiet period in ms after the latest push-diagnostics publication.
	diagnosticsSettleMs?: number;
	// Maximum wait for a push publication. Silence is unconfirmed, not a clean report.
	pushDiagnosticsGraceMs?: number;
	// Maximum wait for a newer push publication after an empty pull result.
	pullDiagnosticsGraceMs?: number;
}

export interface LspConfig {
	timeout?: number;
	servers: InternalLspServer[];
}

export interface InternalLspServer extends ConfiguredLspServer {
	name: string;
	isDefault?: boolean;
}

/** A tsserver-compatible synchronous diagnostics bridge, declared by its adapter. */
export interface SynchronousDiagnostics {
	command: string;
	requests: readonly [string, string, string];
	maxConcurrentFiles: number;
}

export type DiagnosticPath = "publish" | "pull" | "sync-request";

export interface LspServerAdapter {
	name: string;
	isDefault: boolean;
	defaultCommand: ServerCommand;
	missingCommandHint: string;
	extensions: string[];
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
	skipDirectories: Set<string>;
	diagnosticsSettleMs?: number;
	pushDiagnosticsGraceMs?: number;
	pullDiagnosticsGraceMs?: number;
	synchronousDiagnostics?: SynchronousDiagnostics;
	isSupportedFile: (filePath: string) => boolean;
	languageIdFor: (filePath: string) => string;
}

export interface DiagnosticSummary {
	files: number;
	diagnostics: number;
}
