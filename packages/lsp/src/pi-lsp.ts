import { defineTool, type ExtensionAPI, type ToolDefinition } from "@super-pi/coding-agent";
import { Type } from "typebox";
import { DEFAULT_FILE_LIMIT, MAX_ACTIVE_OPERATIONS, MAX_COLLECTED_FILES, MAX_REQUESTED_PATHS, MIN_DIAGNOSTIC_WAIT_MS, MAX_DIAGNOSTIC_WAIT_MS } from "./limits.ts";
import { consumeFixAuthorization } from "./fix-authorization.ts";
import type { LspClientPool } from "./client-pool.ts";
import type { LspServerAdapter } from "./types.ts";

const STATUS_KEY = "lsp";

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
	waitMs: Type.Optional(Type.Integer({ minimum: MIN_DIAGNOSTIC_WAIT_MS, maximum: MAX_DIAGNOSTIC_WAIT_MS, description: "Per-file first-report wait in milliseconds; defaults to server grace and is capped by global timeout. Empty push reports remain provisional for the observation window; readiness alone does not prove diagnostics complete." })),
});

const SingleFileParameters = {
	path: Type.String({ description: "Target file; server inferred by extension." }),
	root: Type.Optional(Type.String({ description: "Workspace root; defaults to cwd." })),
	write: Type.Optional(Type.Boolean({ description: "Write changes; defaults false." })),
	server: Type.Optional(Type.String({ description: "Configured server; defaults to inference." })),
};

export default function lsp(pi: ExtensionAPI) {
	let clientPool: LspClientPool | undefined;
	let authority = new AbortController();
	let paused = false;
	let closed = false;
	let active = 0;
	let idle: Promise<void> | undefined;
	let finishIdle: (() => void) | undefined;
	let draining: Promise<void> | undefined;
	let pendingShutdown: Promise<void> | undefined;

	function assertAvailable() {
		pi.assertExecutionCurrent?.();
		if (paused || closed) throw new Error("LSP execution is closed while session services are changing or awaiting cleanup.");
	}
	async function getClientPool() {
		assertAvailable();
		if (clientPool) return clientPool;
		const { LspClientPool } = await import("./client-pool.ts");
		assertAvailable();
		return clientPool ??= new LspClientPool();
	}
	function registerTool(tool: ToolDefinition<any, any, any>) {
		pi.registerTool({ ...tool, async execute(id, params, signal, onUpdate, ctx, executionContext) {
			assertAvailable(); signal?.throwIfAborted();
			if (active >= MAX_ACTIVE_OPERATIONS) throw new Error(`LSP has reached its limit of ${MAX_ACTIVE_OPERATIONS} active operations.`);
			if (active++ === 0) idle = new Promise<void>(resolve => { finishIdle = resolve; });
			const executionSignal = signal ? AbortSignal.any([signal, authority.signal]) : authority.signal;
			try {
				const result = await tool.execute(id, params, executionSignal, onUpdate, ctx, executionContext);
				executionSignal.throwIfAborted();
				return result;
			} finally {
				if (--active === 0) { const finish = finishIdle; idle = undefined; finishIdle = undefined; finish?.(); }
			}
		} });
	}
	function revoke() {
		paused = true;
		const reason = new Error("LSP execution cancelled for session transition."); reason.stack = reason.message;
		authority.abort(reason);
		pendingShutdown ??= clientPool?.shutdownAll();
		void pendingShutdown?.catch(observePoolShutdown);
	}
	async function performDrain() {
		try {
			await idle;
			await pendingShutdown;
			await clientPool?.shutdownAll();
			if (!closed) { clientPool?.reopen(); authority = new AbortController(); paused = false; }
		} finally { draining = undefined; pendingShutdown = undefined; }
	}
	function drain(): Promise<void> { return draining ??= performDrain(); }
	pi.registerExecutionOwner?.("lsp", { revoke, drain });

	const lspDiagnosticsTool = defineTool({
		name: "lsp_diagnostics",
		label: "LSP: Diagnostics",
		description: "Run configured LSP diagnostics with optional waitMs. Report elapsed time, batches, per-file confirmation and unconfirmed paths for targeted retries. Project readiness alone does not confirm an empty push report.",
		promptSnippet: "Run configured LSP diagnostics",
		promptGuidelines: [
			"Start at most one server per call; narrow ambiguous routes. Report missing servers and run the authoritative CLI typecheck after broad type changes.",
			"Prefer existing authoritative project checks and available LSP routes covering the target. Tool registration alone does not establish server availability or embedded-language coverage. Reuse known configuration; do not install servers or start them after every write.",
			"Report submitted file count, received diagnostics and uncovered scope. No route, skipped service, zero matching files/scripts or failed diagnostics is not a pass. Supplement only gaps with targeted checks; regex checks do not validate all HTML/JS or browser behavior.",
		],
		parameters: DiagnosticsParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const [{ loadRuntime }, { resolveRoot }, { selectDiagnosticRoutes }, runner, pool] =
				await Promise.all([
					import("./adapters.ts"),
					import("./files.ts"),
					import("./routes.ts"),
					import("./runner.ts"),
					getClientPool(),
				]);
			const requestedRoot = resolveRoot(params.root, ctx.cwd);
			const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const { root, routes, skipped, uncoveredFiles, skippedScopeLimited, routedScopeLimited, incomplete } = selectDiagnosticRoutes(
				adapters,
				{ ...params, root: requestedRoot },
				DEFAULT_FILE_LIMIT,
			);
			const results = [];
			for (const route of routes) {
				const result = await runner.runDiagnostics(
					pool,
					route.adapter,
					{ root, paths: params.paths, limit: params.limit, files: route.files, waitMs: params.waitMs },
					timeoutMs,
					signal,
					ctx,
					STATUS_KEY,
				);
				results.push({ route, result });
			}

			const sections = [];
			const routeDetails = [];
			let submittedFiles = 0;
			let diagnosticFailure = false, serverFailed = false, elapsedMs = 0, batchCount = 0;
			const unconfirmedFiles: string[] = [];
			for (const { route, result } of results) {
				submittedFiles += result.details.submittedFiles ?? route.files.length;
				diagnosticFailure ||= result.isError === true; serverFailed ||= result.details.status === "failed";
				elapsedMs += result.details.elapsedMs ?? 0; batchCount += result.details.batchCount ?? 0;
				for (const file of result.details.unconfirmedFiles ?? []) unconfirmedFiles.push(file);
				sections.push(`${route.reason}\n\n${textFromResult(result)}`);
				routeDetails.push({
					server: route.adapter.name,
					backend: route.adapter.name,
					reason: route.reason,
					files: route.files,
					scopeLimited: route.scopeLimited,
					details: result.details,
				});
			}
			const skippedDetails = [];
			if (skipped.length) {
				let names = "";
				for (const route of skipped) {
					if (names) names += ", ";
					names += route.adapter.name;
					skippedDetails.push({ server: route.adapter.name, reason: route.reason, files: route.files, scopeLimited: route.scopeLimited });
				}
				sections.push(`Skipped unavailable default LSP server(s): ${names}.`);
			}
			if (uncoveredFiles.length) sections.push(`Incomplete: ${uncoveredFiles.length} matching file(s) were not submitted because their default server was unavailable. No validation pass for that scope is established.`);
			if (skippedScopeLimited) sections.push("Incomplete: a skipped route reached the file limit; additional uncovered matches are unknown. Narrow the requested scope before claiming completeness.");
			if (routedScopeLimited) sections.push("Incomplete: an available route reached the file limit with unvisited requested scope. Narrow the scope or raise the bounded limit before claiming completeness.");
			sections.push(submittedFiles === 0
				? "Not checked: 0 files submitted to an LSP server. No validation pass is established."
				: `Scope: ${submittedFiles} file(s) submitted, limited to the selected route and file limit. Embedded languages, unmatched files and browser/runtime behavior are not established by this result.`);
			return { ...runner.textResult(sections.join("\n\n---\n\n"), {
				root,
				status: serverFailed ? "failed" : submittedFiles === 0 ? "not_checked" : incomplete || diagnosticFailure ? "partial" : "diagnostics_received",
				unconfirmedFiles, elapsedMs, batchCount,
				submittedFiles,
				uncoveredFiles,
				skippedScopeLimited,
				routedScopeLimited,
				fileLimit: params.limit ?? DEFAULT_FILE_LIMIT,
				skipped: skippedDetails,
				routes: routeDetails,
			}), isError: submittedFiles === 0 || incomplete || diagnosticFailure };
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
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const input = { ...params };
			const authorization = input.write ? consumeFixAuthorization(params, toolCallId) : undefined;
			const [{ loadRuntime }, { resolveRoot }, { selectFixRoute }, { runFix }, pool] =
				await Promise.all([
					import("./adapters.ts"),
					import("./files.ts"),
					import("./routes.ts"),
					import("./runner.ts"),
					getClientPool(),
				]);
			const requestedRoot = resolveRoot(input.root, ctx.cwd);
			const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const { root, route } = selectFixRoute(adapters, { ...input, root: requestedRoot });
			return runFix(
				pool,
				route.adapter,
				{ root, path: input.path, kind: input.kind, write: input.write },
				timeoutMs,
				signal,
				ctx,
				STATUS_KEY,
				authorization,
			);
		},
	});

	const lspNavigateTool = defineTool({
		name: "lsp_navigate",
		label: "LSP: Navigate",
		description: "Navigate symbols through a reusable configured LSP client. Waits for recognized project readiness; unconfirmed readiness is explicitly marked as potentially incomplete.",
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
					import("./adapters.ts"),
					import("./files.ts"),
					import("./routes.ts"),
					import("./navigation.ts"),
					getClientPool(),
				]);
			const requestedRoot = resolveRoot(params.root, ctx.cwd);
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

	registerTool(lspDiagnosticsTool);
	registerTool(lspFixTool);
	registerTool(lspNavigateTool);

	pi.registerCommand("lsp", {
		description: "Show shared LSP extension configuration",
		handler: async (_args, ctx) => {
			try {
				const [{ consumeLspConfigNotice, loadRuntime }, command] = await Promise.all([
					import("./adapters.ts"),
					import("./command.ts"),
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
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		closed = true;
		revoke();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await drain();
	});
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

// The execution owner awaits this same rejection after admitted calls settle.
function observePoolShutdown(): void {}

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
						? "command available (service and language coverage not yet verified)"
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
