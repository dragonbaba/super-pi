import path from "node:path";
import { compareStrings, EMPTY_READONLY_ARRAY } from "./collections.js";
import { commandExists, commandPathValue } from "./command.js";
import { collectSupportedFiles, resolveRoot } from "./files.js";
import type { LspServerAdapter } from "./types.js";

export type LspAction = "diagnostics" | "fix" | "navigate";

export interface DiagnosticRoute {
	adapter: LspServerAdapter;
	reason: string;
	files: readonly string[];
}

export interface SingleFileRoute {
	adapter: LspServerAdapter;
	reason: string;
}

export interface DiagnosticRouteParams {
	root?: string;
	paths?: string[];
	limit?: number;
	server?: string;
}

export interface SingleFileRouteParams {
	root?: string;
	path: string;
	server?: string;
}

export const SUPPORTED_SERVER_DESCRIPTION =
	"Supported LSP servers are defined by pi-lsp config and selected by file extension.";

export function selectDiagnosticRoutes(
	adapters: LspServerAdapter[],
	params: DiagnosticRouteParams,
	defaultLimit: number,
) {
	const root = resolveRoot(params.root);
	const candidates = filterAdapters(adapters, params.server);
	const skipped: DiagnosticRoute[] = [];
	const filesByPolicy = new Map<string, string[]>();
	const routes: DiagnosticRoute[] = [];
	for (const adapter of candidates) {
		if (!params.server && adapter.isDefault) {
			const command = adapter.defaultCommand;
			if (!commandExists(command.command, root, commandPathValue(adapter.env))) {
				skipped.push({ adapter, reason: `${adapter.name} command missing`, files: EMPTY_READONLY_ARRAY });
				continue;
			}
		}
		const key = diagnosticFilePolicyKey(adapter);
		let files = filesByPolicy.get(key);
		if (!files) {
			files = collectSupportedFiles(adapter, root, params.paths, params.limit ?? defaultLimit);
			filesByPolicy.set(key, files);
		}
		if (files.length === 0) continue;
		routes.push({ adapter, reason: `${adapter.name} diagnostics`, files });
		if (routes.length > 1) {
			throw new Error(
				`Multiple LSP diagnostic routes match this request: ${routes[0].adapter.name}, ${routes[1].adapter.name}. ` +
					"One lsp_diagnostics call may start only one server; narrow paths or specify one server name.",
			);
		}
	}

	if (routes.length === 0 && skipped.length === 0) {
		const scope = params.paths?.length ? ` in requested paths: ${params.paths.join(", ")}` : "";
		throw new Error(`No supported files found${scope}. ${SUPPORTED_SERVER_DESCRIPTION}`);
	}

	return { root, routes, skipped };
}

export function selectFixRoute(adapters: LspServerAdapter[], params: SingleFileRouteParams) {
	return selectSingleFileRoute(adapters, params, "fix", "lsp_fix");
}

export function selectNavigationRoute(adapters: LspServerAdapter[], params: SingleFileRouteParams) {
	return selectSingleFileRoute(adapters, params, "navigate", "lsp_navigate");
}

function selectSingleFileRoute(
	adapters: LspServerAdapter[],
	params: SingleFileRouteParams,
	action: "fix" | "navigate",
	toolName: "lsp_fix" | "lsp_navigate",
) {
	const root = resolveRoot(params.root);
	const file = path.resolve(root, params.path);
	const candidates = filterAdapters(adapters, params.server).filter((adapter) =>
		adapter.isSupportedFile(file),
	);
	if (candidates.length === 0) throw unsupportedFileError(action, params.path, params.server);
	if (!params.server && candidates.length > 1) {
		throw new Error(
			`Multiple LSP servers support ${params.path}: ${candidates.map((adapter) => adapter.name).join(", ")}. ` +
				`Specify the server parameter for ${toolName}.`,
		);
	}
	const adapter = candidates[0];
	return {
		root,
		route: {
			adapter,
			reason: `${adapter.name} ${action}`,
		},
	};
}

function diagnosticFilePolicyKey(adapter: LspServerAdapter) {
	return JSON.stringify([
		adapter.extensions,
		[...adapter.skipDirectories].sort(compareStrings),
	]);
}

function filterAdapters(adapters: LspServerAdapter[], selected: unknown) {
	if (selected === undefined) return adapters;
	if (typeof selected !== "string") {
		throw new Error("LSP server parameter must be one configured server name, not an array or object.");
	}
	const name = selected.trim();
	if (!name) throw new Error("LSP server parameter must not be blank.");
	for (const adapter of adapters) if (adapter.name === name) return [adapter];
	const configured = adapters.map((adapter) => adapter.name).join(", ") || "none";
	throw new Error(
		`Unknown LSP server: ${name}. Configured LSP servers: ${configured}. ` +
			"Omit the server parameter to infer one matching server.",
	);
}

function unsupportedFileError(action: LspAction, filePath: string, server: string | undefined) {
	const override = server ? ` for server '${server}'` : "";
	return new Error(
		`No ${action} route supports ${filePath}${override}. ${SUPPORTED_SERVER_DESCRIPTION}`,
	);
}
