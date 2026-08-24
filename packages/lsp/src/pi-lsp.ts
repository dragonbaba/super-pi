import { defineTool, type ExtensionAPI } from "@super-pi/coding-agent";
import { Type } from "typebox";
import { DEFAULT_FILE_LIMIT, MAX_COLLECTED_FILES, MAX_REQUESTED_PATHS } from "./limits.js";
import type { LspClientPool } from "./client-pool.js";
import type { LspServerAdapter } from "./types.js";

const STATUS_KEY = "lsp";
let clientPool: LspClientPool | undefined;

async function getClientPool() {
	if (clientPool) return clientPool;
	const { LspClientPool } = await import("./client-pool.js");
	clientPool = new LspClientPool();
	return clientPool;
}

const ServerParameter = Type.Optional(
	Type.String({ description: "Configured server; automatic inference must resolve exactly one." }),
);

const DiagnosticsParameters = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files/directories; defaults to root and routes by extension.",
			maxItems: MAX_REQUESTED_PATHS,
		}),
	),
	root: Type.Optional(Type.String({ description: "Workspace root; defaults to cwd." })),
	limit: Type.Optional(Type.Number({
		description: `Files per server, capped at ${MAX_COLLECTED_FILES}.`,
		minimum: 1,
		maximum: MAX_COLLECTED_FILES,
	})),
	server: ServerParameter,
});

const SingleFileParameters = {
	path: Type.String({ description: "Target file; server inferred by extension." }),
	root: Type.Optional(Type.String({ description: "Workspace root; defaults to cwd." })),
	write: Type.Optional(Type.Boolean({ description: "Write changes; defaults false." })),
	server: Type.Optional(Type.String({ description: "Configured server; defaults to inference." })),
};

const lspDiagnosticsTool = defineTool({
	name: "lsp_diagnostics",
	label: "LSP: Diagnostics",
	description: "Run diagnostics using configured, language-agnostic LSP server routes.",
	promptSnippet: "Run configured LSP diagnostics",
	promptGuidelines: [
		"Start at most one server per call; narrow ambiguous routes. Report missing servers and run the authoritative CLI typecheck after broad type changes.",
	],
	parameters: DiagnosticsParameters,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const [{ loadRuntime }, { resolveRoot }, { selectDiagnosticRoutes }, runner, pool] =
			await Promise.all([
				import("./adapters.js"),
				import("./files.js"),
				import("./routes.js"),
				import("./runner.js"),
				getClientPool(),
			]);
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const { root, routes, skipped } = selectDiagnosticRoutes(
			adapters,
			{ ...params, root: requestedRoot },
			DEFAULT_FILE_LIMIT,
		);
		const results = [];
		for (const route of routes) {
			const result = await runner.runDiagnostics(
				pool,
				route.adapter,
				{ root, paths: params.paths, limit: params.limit, files: route.files },
				timeoutMs,
				signal,
				ctx,
				STATUS_KEY,
			);
			results.push({ route, result });
		}

		const sections = [];
		const routeDetails = [];
		for (const { route, result } of results) {
			sections.push(`${route.reason}\n\n${textFromResult(result)}`);
			routeDetails.push({
				server: route.adapter.name,
				backend: route.adapter.name,
				reason: route.reason,
				files: route.files,
				details: result.details,
			});
		}
		const skippedDetails = [];
		if (skipped.length) {
			let names = "";
			for (const route of skipped) {
				if (names) names += ", ";
				names += route.adapter.name;
				skippedDetails.push({ server: route.adapter.name, reason: route.reason, files: route.files });
			}
			sections.push(`Skipped unavailable default LSP server(s): ${names}.`);
		}
		return runner.textResult(sections.join("\n\n---\n\n"), {
			root,
			skipped: skippedDetails,
			routes: routeDetails,
		});
	},
});

const lspFixTool = defineTool({
	name: "lsp_fix",
	label: "LSP: Fix",
	description: "Apply source fixes or import organization using configured LSP server routes.",
	promptSnippet: "Apply configured LSP source fixes to a file",
	parameters: Type.Object({
		...SingleFileParameters,
		kind: Type.Optional(Type.String({ description: "Source action kind. Defaults to source.fixAll." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const [{ loadRuntime }, { resolveRoot }, { selectFixRoute }, { runFix }, pool] =
			await Promise.all([
				import("./adapters.js"),
				import("./files.js"),
				import("./routes.js"),
				import("./runner.js"),
				getClientPool(),
			]);
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const { root, route } = selectFixRoute(adapters, { ...params, root: requestedRoot });
		return runFix(
			pool,
			route.adapter,
			{ root, path: params.path, kind: params.kind, write: params.write },
			timeoutMs,
			signal,
			ctx,
			STATUS_KEY,
		);
	},
});

const lspNavigateTool = defineTool({
	name: "lsp_navigate",
	label: "LSP: Navigate",
	description: "Navigate symbols through a reusable configured LSP client.",
	promptSnippet: "Navigate symbols through LSP",
	promptGuidelines: [
		"Use LSP for symbols and text search for literals/config; read a returned target before explaining or editing it.",
	],
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("definition"),
			Type.Literal("references"),
			Type.Literal("implementation"),
			Type.Literal("workspace_symbols"),
		]),
		path: Type.String({ description: "Anchor file selecting server and workspace." }),
		root: Type.Optional(Type.String({ description: "Workspace root; defaults to cwd." })),
		line: Type.Optional(Type.Number({ description: "1-indexed line for position actions." })),
		symbol: Type.Optional(Type.String({ description: "Symbol; use name#N if repeated on the line." })),
		query: Type.Optional(Type.String({ description: "workspace_symbols query." })),
		includeDeclaration: Type.Optional(Type.Boolean({ description: "Include declarations; defaults true." })),
		maxResults: Type.Optional(Type.Number({ description: "Results, capped at 200; defaults 50." })),
		server: Type.Optional(Type.String({ description: "Configured server." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const [{ loadRuntime }, { resolveRoot }, { selectNavigationRoute }, { runNavigation }, pool] =
			await Promise.all([
				import("./adapters.js"),
				import("./files.js"),
				import("./routes.js"),
				import("./navigation.js"),
				getClientPool(),
			]);
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const { root, route } = selectNavigationRoute(adapters, {
			root: requestedRoot,
			path: params.path,
			server: params.server,
		});
		return runNavigation(
			pool,
			route.adapter,
			{ ...params, root },
			timeoutMs,
			signal,
			ctx,
			STATUS_KEY,
		);
	},
});

export default function lsp(pi: ExtensionAPI) {
	pi.registerTool(lspDiagnosticsTool);
	pi.registerTool(lspFixTool);
	pi.registerTool(lspNavigateTool);

	pi.registerCommand("lsp", {
		description: "Show shared LSP extension configuration",
		handler: async (_args, ctx) => {
			try {
				const [{ consumeLspConfigNotice, loadRuntime }, command] = await Promise.all([
					import("./adapters.js"),
					import("./command.js"),
				]);
				const { adapters } = loadRuntime(ctx.cwd, {
					projectTrusted: ctx.isProjectTrusted(),
				});
				const notice = consumeLspConfigNotice();
				if (notice) ctx.ui.notify(notice, "warning");
				ctx.ui.notify(
					buildStatusMessage(adapters, ctx.cwd, command),
					statusLevel(adapters, ctx.cwd, command),
				);
			} catch (error) {
				ctx.ui.notify(`LSP config ignored: ${formatError(error)}`, "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clientPool?.reopen();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await clientPool?.shutdownAll();
	});
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }) {
	return result.content?.find((item) => item.type === "text")?.text ?? "";
}

interface CommandHelpers {
	commandExists(command: string, cwd: string, pathValue?: string): boolean;
	commandPathValue(env?: Record<string, string>): string | undefined;
}

function buildStatusMessage(adapters: LspServerAdapter[], cwd: string, helpers: CommandHelpers) {
	return adapters
		.flatMap((adapter) => {
			const command = adapter.defaultCommand;
			return [
				`${adapter.name} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
				`${adapter.name} status: ${
					helpers.commandExists(command.command, cwd, helpers.commandPathValue(adapter.env))
						? "ready"
						: "command missing"
				}`,
			];
		})
		.join("\n");
}

function statusLevel(adapters: LspServerAdapter[], cwd: string, helpers: CommandHelpers) {
	return adapters.every((adapter) => {
		const command = adapter.defaultCommand;
		return helpers.commandExists(command.command, cwd, helpers.commandPathValue(adapter.env));
	})
		? "info"
		: "warning";
}
