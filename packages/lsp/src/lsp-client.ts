import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandPathValue, mergeEnvironment, resolveCommandPath } from "./command.js";
import { EMPTY_READONLY_ARRAY } from "./collections.js";
import { directoryUri } from "./files.js";
import { COMMAND_SCRIPT_PATTERN, LSP_CONTENT_LENGTH_PATTERN } from "./regex.js";
import { positionAt } from "./text-edits.js";
import type {
	CodeAction,
	JsonRpcMessage,
	LspDiagnostic,
	LspLocation,
	LspLocationLink,
	LspPosition,
	LspServerAdapter,
	LspSymbolInformation,
	ServerCommand,
} from "./types.js";

export function resolveSpawnCommand(
	command: ServerCommand,
	platform: NodeJS.Platform = process.platform,
	comSpec = process.env.ComSpec,
): ServerCommand {
	if (platform !== "win32" || !COMMAND_SCRIPT_PATTERN.test(command.command)) return command;
	return {
		command: comSpec?.trim() || "cmd.exe",
		args: ["/d", "/s", "/c", command.command, ...command.args],
	};
}

// Quiet period (ms) after each publish before treating push diagnostics as settled.
const PUBLISHED_DIAGNOSTICS_SETTLE_MS = 800;
const MAX_STDERR_CHARS = 50_000;
const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_LSP_BUFFER_BYTES = MAX_LSP_MESSAGE_BYTES + 64 * 1024;
const MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS = 256;
const SHUTDOWN_GRACE_MS = 1_000;

export class LspClient {
	#child?: ChildProcessWithoutNullStreams;
	#buffer = Buffer.alloc(0);
	#nextId = 1;
	#pending = new Map<
		number,
		{
			resolve: (message: JsonRpcMessage) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	#publishedDiagnostics = new Map<string, { version: number; diagnostics: readonly LspDiagnostic[] }>();
	#diagnosticWaiters = new Map<
		string,
		Set<{
			onPublish: (publication: { version: number; diagnostics: readonly LspDiagnostic[] }) => void;
			reject: (reason: unknown) => void;
			dispose: () => void;
		}>
	>();
	#stderr = "";
	#serverCapabilities: Record<string, unknown> = {};
	#adapter: LspServerAdapter;
	#command: ServerCommand;
	#cwd: string;
	#timeoutMs: number;

	constructor(adapter: LspServerAdapter, command: ServerCommand, cwd: string, timeoutMs: number) {
		this.#adapter = adapter;
		this.#command = command;
		this.#cwd = cwd;
		this.#timeoutMs = timeoutMs;
	}

	get running() {
		const child = this.#child;
		return Boolean(
			child && !child.killed && child.exitCode === null && child.signalCode === null,
		);
	}

	async start() {
		const commandPath = resolveCommandPath(
			this.#command.command,
			this.#cwd,
			process.platform,
			commandPathValue(this.#adapter.env),
		);
		if (!commandPath) {
			throw new Error(
				`${this.#adapter.name} LSP command not found: ${this.#command.command}. ${this.#adapter.missingCommandHint}`,
			);
		}

		const spawnCommand = resolveSpawnCommand({ ...this.#command, command: commandPath });
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd: this.#cwd,
			env: mergeEnvironment(this.#adapter.env),
			stdio: "pipe",
		});
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			try {
				this.#onData(chunk);
			} catch (error) {
				this.#fail(
					`${this.#adapter.name} LSP server sent invalid JSON-RPC data: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
				);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
		});
		child.stdin.on("error", (error) => {
			this.#fail(
				`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
			);
		});
		child.once("exit", (code, signal) => {
			if (this.#child === child) this.#child = undefined;
			const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
			this.#rejectPending(
				(id) =>
					`${this.#adapter.name} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
			);
		});

		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => {
				const message = `${this.#adapter.name} LSP process failed to start: ${error.message}.${this.#formatStderr()}`;
				this.#rejectPending(message);
				if (this.#child === child) this.#child = undefined;
				reject(new Error(message));
			});
		});
	}

	async initialize(root: string) {
		const rootUri = directoryUri(root);
		const workspaceFolders = [{ uri: rootUri, name: path.basename(root) || "workspace" }];
		const response = await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders,
			initializationOptions: this.#adapter.initialization ?? {},
			capabilities: {
				textDocument: {
					codeAction: {
						dynamicRegistration: false,
						resolveSupport: { properties: ["edit"] },
					},
					diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
					publishDiagnostics: {},
					definition: { dynamicRegistration: false, linkSupport: true },
					implementation: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					synchronization: { didSave: true },
				},
				workspace: {
					configuration: true,
					workspaceEdit: { documentChanges: true },
					workspaceFolders: true,
				},
			},
		});
		this.#serverCapabilities =
			(response.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ??
			{};
		this.notify("initialized", {});
		if (this.#adapter.initialization) {
			this.notify("workspace/didChangeConfiguration", { settings: this.#adapter.initialization });
		}
	}

	didOpen(uri: string, text: string, languageId: string) {
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	didClose(uri: string) {
		try {
			if (!this.#child) return false;
			this.notify("textDocument/didClose", {
				textDocument: { uri },
			});
			return true;
		} finally {
			this.#publishedDiagnostics.delete(documentUriKey(uri));
		}
	}

	async diagnostics(uri: string) {
		// Only pull if the server advertised it; otherwise use push diagnostics.
		if (!this.#serverCapabilities.diagnosticProvider) {
			return this.#waitForPublishedDiagnostics(
				uri,
				this.#adapter.pushDiagnosticsGraceMs
					? {
							afterVersion: 0,
							diagnostics: EMPTY_READONLY_ARRAY,
							waitMs: this.#adapter.pushDiagnosticsGraceMs,
						}
					: undefined,
			);
		}
		const published = this.#publishedDiagnostics.get(documentUriKey(uri));
		// Ignore a provisional empty publish, but preserve diagnostics that arrived before the pull.
		const afterVersion = published?.diagnostics.length
			? published.version - 1
			: (published?.version ?? 0);
		const response = await this.request("textDocument/diagnostic", {
			textDocument: { uri },
		});
		const result = response.result as { items?: LspDiagnostic[] } | undefined;
		const diagnostics = result?.items ?? EMPTY_READONLY_ARRAY;
		if (diagnostics.length > 0 || !this.#adapter.pullDiagnosticsGraceMs) return diagnostics;
		return this.#waitForPublishedDiagnostics(uri, {
			afterVersion,
			diagnostics,
			waitMs: this.#adapter.pullDiagnosticsGraceMs,
		});
	}

	async definition(uri: string, position: LspPosition) {
		const response = await this.request("textDocument/definition", {
			textDocument: { uri },
			position,
		});
		return (response.result as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null) ?? null;
	}

	async implementation(uri: string, position: LspPosition) {
		const response = await this.request("textDocument/implementation", {
			textDocument: { uri },
			position,
		});
		return (response.result as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null) ?? null;
	}

	async references(uri: string, position: LspPosition, includeDeclaration: boolean) {
		const response = await this.request("textDocument/references", {
			textDocument: { uri },
			position,
			context: { includeDeclaration },
		});
		return (response.result as LspLocation[] | null) ?? EMPTY_READONLY_ARRAY;
	}

	async workspaceSymbols(query: string) {
		const response = await this.request("workspace/symbol", { query });
		return (response.result as LspSymbolInformation[] | null) ?? EMPTY_READONLY_ARRAY;
	}

	async codeActions(uri: string, text: string, diagnostics: readonly LspDiagnostic[], kind: string) {
		const response = await this.request("textDocument/codeAction", {
			textDocument: { uri },
			range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) },
			context: { diagnostics, only: [kind] },
		});
		return (response.result as CodeAction[] | null | undefined) ?? EMPTY_READONLY_ARRAY;
	}

	async resolveActions(actions: readonly CodeAction[]) {
		// Only resolve when the server advertised resolveProvider; otherwise use the
		// action as-is. Any error from an advertised resolve is real and propagates.
		const codeActionProvider = this.#serverCapabilities.codeActionProvider;
		const canResolve =
			typeof codeActionProvider === "object" &&
			codeActionProvider !== null &&
			(codeActionProvider as { resolveProvider?: boolean }).resolveProvider === true;

		const resolvedActions: CodeAction[] = [];
		for (const action of actions) {
			if (action.edit || !canResolve) {
				resolvedActions.push(action);
				continue;
			}

			const response = await this.request("codeAction/resolve", action);
			resolvedActions.push((response.result as CodeAction | undefined) ?? action);
		}

		return resolvedActions;
	}

	async shutdown() {
		const child = this.#child;
		if (!child) return;

		try {
			await this.request("shutdown", null);
			this.notify("exit", undefined);
			await waitForExit(child, SHUTDOWN_GRACE_MS);
		} catch {
			// The process may already be gone; exact termination below guarantees cleanup.
		} finally {
			this.#rejectPending(`${this.#adapter.name} LSP request cancelled.`);
			if (this.#child === child) {
				child.kill("SIGTERM");
				if (!(await waitForExit(child, SHUTDOWN_GRACE_MS))) child.kill("SIGKILL");
				if (this.#child === child) this.#child = undefined;
			}
			this.#clearRetainedState();
		}
	}

	#rejectPending(message: string | ((id: number | "diagnostics") => string)) {
		for (const [id, pending] of this.#pending.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(typeof message === "string" ? message : message(id)));
		}
		this.#pending.clear();
		for (const waiters of this.#diagnosticWaiters.values()) {
			for (const waiter of [...waiters]) {
				waiter.reject(new Error(typeof message === "string" ? message : message("diagnostics")));
			}
		}
		this.#diagnosticWaiters.clear();
	}

	#fail(message: string) {
		this.#rejectPending(message);
		if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
		// Keep the exact child reference until its exit event or shutdown() confirms
		// termination, so callers can await cleanup instead of racing the OS.
		this.#clearRetainedState();
	}

	#clearRetainedState() {
		this.#buffer = Buffer.alloc(0);
		this.#publishedDiagnostics.clear();
		this.#serverCapabilities = {};
		this.#stderr = "";
	}

	private request(method: string, params: unknown) {
		const id = this.#nextId++;

		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new Error(
						`${this.#adapter.name} LSP request timed out: ${method}.${this.#formatStderr()}`,
					),
				);
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve, reject, timeout });

			try {
				this.#send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				clearTimeout(timeout);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	private notify(method: string, params: unknown) {
		this.#send(
			params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
		);
	}

	#send(message: JsonRpcMessage) {
		if (!this.#child) throw new Error(`${this.#adapter.name} LSP server is not running.`);

		const body = JSON.stringify(message);
		try {
			this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		} catch (error) {
			const errorMessage =
				`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.` +
				this.#formatStderr();
			this.#fail(errorMessage);
			throw new Error(errorMessage);
		}
	}

	#onData(chunk: Buffer) {
		if (chunk.length > MAX_LSP_BUFFER_BYTES - this.#buffer.length) {
			throw new Error(`LSP response buffer exceeds ${MAX_LSP_BUFFER_BYTES} bytes`);
		}
		this.#buffer = Buffer.concat([this.#buffer, chunk]);

		while (true) {
			const separator = this.#buffer.indexOf("\r\n\r\n");
			if (separator < 0) return;

			const header = this.#buffer.subarray(0, separator).toString("utf8");
			const contentLength = LSP_CONTENT_LENGTH_PATTERN.exec(header)?.[1];
			if (!contentLength) throw new Error(`Invalid LSP response header: ${header}`);

			const bodyStart = separator + 4;
			const bodyLength = Number(contentLength);
			if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_LSP_MESSAGE_BYTES) {
				throw new Error(`LSP response Content-Length exceeds ${MAX_LSP_MESSAGE_BYTES} bytes`);
			}
			if (this.#buffer.length < bodyStart + bodyLength) return;

			const rawBody = this.#buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
			this.#buffer = this.#buffer.subarray(bodyStart + bodyLength);
			this.#handleMessage(JSON.parse(rawBody) as JsonRpcMessage);
		}
	}

	#handleMessage(message: JsonRpcMessage) {
		if (Object.hasOwn(message, "id") && !message.method) {
			const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
			if (!pending) return;

			clearTimeout(pending.timeout);
			this.#pending.delete(message.id as number);
			if (message.error) {
				pending.reject(new Error(`${this.#adapter.name} LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message);
			}
			return;
		}

		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			if (params?.uri) {
				const uriKey = documentUriKey(params.uri);
				const previousVersion = this.#publishedDiagnostics.get(uriKey)?.version ?? 0;
				const publication = {
					version: previousVersion + 1,
					diagnostics: params.diagnostics ?? EMPTY_READONLY_ARRAY,
				};
				this.#recordPublishedDiagnostics(uriKey, publication);
				const waiters = this.#diagnosticWaiters.get(uriKey);
				if (waiters) {
					for (const waiter of [...waiters]) waiter.onPublish(publication);
				}
			}
			return;
		}

		if (Object.hasOwn(message, "id") && message.method) {
			this.#respondToServerRequest(message);
		}
	}

	#recordPublishedDiagnostics(
		uri: string,
		publication: { version: number; diagnostics: readonly LspDiagnostic[] },
	) {
		this.#publishedDiagnostics.delete(uri);
		if (this.#publishedDiagnostics.size >= MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS) {
			const oldestUri = this.#publishedDiagnostics.keys().next().value;
			if (oldestUri !== undefined) this.#publishedDiagnostics.delete(oldestUri);
		}
		this.#publishedDiagnostics.set(uri, publication);
	}

	#waitForPublishedDiagnostics(
		uri: string,
		fallback?: { afterVersion: number; diagnostics: readonly LspDiagnostic[]; waitMs: number },
	) {
		// See PUBLISHED_DIAGNOSTICS_SETTLE_MS. Bounded by #timeoutMs.
		return new Promise<readonly LspDiagnostic[]>((resolve, reject) => {
			const uriKey = documentUriKey(uri);
			let settleTimer: NodeJS.Timeout | undefined;
			let fallbackTimer: NodeJS.Timeout | undefined;
			let overallTimer: NodeJS.Timeout | undefined;
			let latestPublication: { version: number; diagnostics: readonly LspDiagnostic[] } | undefined;
			let sawNonEmptyPublication = false;
			const afterVersion = fallback?.afterVersion ?? 0;

			const dispose = () => {
				if (settleTimer) clearTimeout(settleTimer);
				if (fallbackTimer) clearTimeout(fallbackTimer);
				if (overallTimer) clearTimeout(overallTimer);
				const set = this.#diagnosticWaiters.get(uriKey);
				set?.delete(waiter);
				if (set && set.size === 0) this.#diagnosticWaiters.delete(uriKey);
			};
			const settleWith = (diagnostics: readonly LspDiagnostic[]) => {
				dispose();
				resolve(diagnostics);
			};
			const fail = (reason: unknown) => {
				dispose();
				reject(reason);
			};
			const onPublish = (publication: { version: number; diagnostics: readonly LspDiagnostic[] }) => {
				if (publication.version <= afterVersion) return;
				if (fallback && publication.diagnostics.length === 0 && !sawNonEmptyPublication) return;
				sawNonEmptyPublication ||= publication.diagnostics.length > 0;
				latestPublication = publication;
				if (fallbackTimer) clearTimeout(fallbackTimer);
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(
					() => settleWith(publication.diagnostics),
					this.#adapter.diagnosticsSettleMs ?? PUBLISHED_DIAGNOSTICS_SETTLE_MS,
				);
			};

			const waiter = { onPublish, reject: fail, dispose };
			const set = this.#diagnosticWaiters.get(uriKey) ?? new Set<typeof waiter>();
			set.add(waiter);
			this.#diagnosticWaiters.set(uriKey, set);

			if (fallback) {
				fallbackTimer = setTimeout(
					() => {
						settleWith(latestPublication?.diagnostics ?? fallback.diagnostics);
					},
					Math.min(fallback.waitMs, this.#timeoutMs),
				);
			}
			overallTimer = setTimeout(() => {
				if (latestPublication) {
					settleWith(latestPublication.diagnostics);
				} else if (fallback) {
					settleWith(fallback.diagnostics);
				} else {
					fail(
						new Error(
							`${this.#adapter.name} LSP did not return diagnostics for ${uri} before timeout.`,
						),
					);
				}
			}, this.#timeoutMs);

			const existing = this.#publishedDiagnostics.get(uriKey);
			if (existing) onPublish(existing);
		});
	}

	#respondToServerRequest(message: JsonRpcMessage) {
		if (message.method === "workspace/configuration") {
			const params = message.params as { items?: Array<{ section?: string }> } | undefined;
			this.#send({
				jsonrpc: "2.0",
				id: message.id,
				result: (params?.items ?? EMPTY_READONLY_ARRAY).map((item) => this.#configurationValue(item.section)),
			});
			return;
		}

		if (message.method === "workspace/workspaceFolders") {
			const rootUri = directoryUri(this.#cwd);
			this.#send({
				jsonrpc: "2.0",
				id: message.id,
				result: [{ uri: rootUri, name: path.basename(this.#cwd) || "workspace" }],
			});
			return;
		}

		if (
			message.method === "client/registerCapability" ||
			message.method === "client/unregisterCapability"
		) {
			this.#send({ jsonrpc: "2.0", id: message.id, result: null });
			return;
		}

		this.#send({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: `Method not found: ${message.method ?? "unknown"}` },
		});
	}

	#configurationValue(section: string | undefined) {
		if (!section) return this.#adapter.initialization ?? {};
		return this.#adapter.initialization?.[section] ?? {};
	}

	#formatStderr() {
		const stderr = this.#stderr.trim();
		return stderr ? `\nServer stderr:\n${stderr}` : "";
	}
}

function documentUriKey(uri: string) {
	try {
		const canonical = pathToFileURL(path.normalize(fileURLToPath(uri))).href;
		return process.platform === "win32" ? canonical.toLowerCase() : canonical;
	} catch {
		return uri;
	}
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let timer: NodeJS.Timeout;
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		timer = setTimeout(() => {
			child.removeListener("exit", onExit);
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
		child.once("exit", onExit);
	});
}

function formatErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
