import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";
import { createSessionLease, type SessionLease } from "./session-lease.ts";
import { saveSessionExecutionProfile, sessionDirectories } from "./session-execution-profile.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	permissionMode?: import("./permission-mode.ts").SessionPermissionMode;
	directories?: readonly string[];
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private replacementLease: SessionLease | undefined;
	private replacementOperation: Promise<boolean> | undefined;
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private replacementGeneration = 0;
	private disposed = false;
	private disposeOperation: Promise<void> | undefined;
	private resolveDispose: (() => void) | undefined;
	private rejectDispose: ((error: unknown) => void) | undefined;
	private teardownOperation: Promise<void> | undefined;
	private auxiliaryShutdownTimer: ReturnType<typeof setInterval> | undefined;
	private auxiliaryShutdownDeadline = 0;
	private resolveAuxiliaryShutdown: (() => void) | undefined;
	private rejectAuxiliaryShutdown: ((error: Error) => void) | undefined;
	private readonly pollAuxiliaryShutdown = (): void => {
		const pending = this.session.isIdle === false || this.session.isCompacting || this.session.isBashRunning;
		if (pending && Date.now() < this.auxiliaryShutdownDeadline) return;
		if (this.auxiliaryShutdownTimer !== undefined) clearInterval(this.auxiliaryShutdownTimer);
		this.auxiliaryShutdownTimer = undefined;
		this.auxiliaryShutdownDeadline = 0;
		const resolve = this.resolveAuxiliaryShutdown;
		const reject = this.rejectAuxiliaryShutdown;
		this.resolveAuxiliaryShutdown = undefined;
		this.rejectAuxiliaryShutdown = undefined;
		if (pending) {
			const error = new Error("Session shutdown did not settle within 5000ms");
			error.name = "SessionShutdownTimeoutError";
			reject?.(error);
		} else resolve?.();
	};

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		if (this.disposed && rebindSession !== undefined) return;
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		if (this.disposed && beforeSessionInvalidate !== undefined) return;
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	cancelPendingReplacements(): void {
		this.replacementGeneration++;
	}

	private beginReplacement(): number {
		if (this.disposed) throw new Error("Agent session runtime is disposed");
		return this.replacementGeneration;
	}

	private isReplacementCurrent(generation: number): boolean {
		return !this.disposed && this.replacementGeneration === generation;
	}

	private async createAndApplyReplacement(
		options: Parameters<CreateAgentSessionRuntimeFactory>[0],
		generation: number,
	): Promise<boolean> {
		const requiresUserInput = options.sessionManager === this.session.sessionManager && this.session.requiresUserInput;
		const result = await this.createRuntime(options);
		if (options.directories !== undefined) {
			const actual = result.session.settingsManager.getSessionDirectories();
			let matches = actual.length === options.directories.length;
			for (let i = 0; matches && i < actual.length; i++) if (actual[i] !== options.directories[i]) matches = false;
			if (!matches) {
				result.session.dispose(); await result.session.waitForSessionLeaseRelease?.();
				throw new Error("Runtime factory did not apply the selected working directories; execution remains stopped");
			}
		}
		if (options.permissionMode !== undefined && result.session.settingsManager.getPermissionMode() !== options.permissionMode) {
			result.session.dispose(); await result.session.waitForSessionLeaseRelease?.();
			throw new Error("Runtime factory did not apply the selected permission mode; execution remains stopped");
		}
		if (requiresUserInput) {
			try { await result.session.resourceLoader.getExtensions().runtime.executionBoundary.pauseForUser(); }
			catch (error) {
				result.session.dispose(); await result.session.waitForSessionLeaseRelease?.(); throw error;
			}
		}
		if (!this.isReplacementCurrent(generation)) {
			result.session.dispose();
			await result.session.waitForSessionLeaseRelease?.();
			return false;
		}
		this.apply(result);
		return true;
	}

	private replaceCurrent(
		reason: SessionShutdownEvent["reason"],
		options: Parameters<CreateAgentSessionRuntimeFactory>[0],
		generation: number,
	): Promise<boolean> {
		if (!this.isReplacementCurrent(generation)) return Promise.resolve(false);
		if (this.replacementLease) throw new Error("Session replacement is still preparing; no replacement was queued.");
		const manager = options.sessionManager;
		const lease = createSessionLease(options.agentDir, manager.getSessionFile(), manager.getSessionId(), reason === "resume");
		this.replacementLease = lease;
		let resolve!: (applied: boolean) => void, reject!: (error: unknown) => void;
		const operation = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
		this.replacementOperation = operation;
		void this.performReplacement(reason, options, generation, lease, resolve, reject);
		return operation;
	}

	private async performReplacement(
		reason: SessionShutdownEvent["reason"], options: Parameters<CreateAgentSessionRuntimeFactory>[0],
		generation: number, lease: SessionLease, resolve: (applied: boolean) => void, reject: (error: unknown) => void,
	): Promise<void> {
		let applied = false, failed = false, failure: unknown;
		try {
			await this.teardownCurrent(reason, options.sessionManager.getSessionFile());
			if (this.isReplacementCurrent(generation)) applied = await this.createAndApplyReplacement(options, generation);
		} catch (error) { failed = true; failure = error; }
		// The new AgentSession has published its record before apply. Superseded
		// candidates have joined their own cleanup before the reservation is removed.
		try { lease.stop(); }
		catch (error) { if (!failed) { failed = true; failure = error; } }
		this.replacementLease = undefined;
		this.replacementOperation = undefined;
		if (failed) reject(failure);
		else resolve(applied);
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		if (this.teardownOperation) return this.teardownOperation;
		let resolveOperation!: () => void;
		let rejectOperation!: (error: unknown) => void;
		const operation = new Promise<void>((resolve, reject) => {
			resolveOperation = resolve;
			rejectOperation = reject;
		});
		this.teardownOperation = operation;
		// Publish before abort, shutdown handlers or invalidation can reenter.
		void this.performSessionTeardown(reason, targetSessionFile, resolveOperation, rejectOperation);
		return operation;
	}

	private async performSessionTeardown(
		reason: SessionShutdownEvent["reason"], targetSessionFile: string | undefined,
		resolve: () => void, reject: (error: unknown) => void,
	): Promise<void> {
		const session = this.session;
		let failed = false;
		let failure: unknown;
		if (session.isCompacting) {
			try { session.abortCompaction(); }
			catch (error) { failed = true; failure = error; }
			try { session.abortBranchSummary(); }
			catch (error) { if (!failed) { failed = true; failure = error; } }
		}
		if (session.isBashRunning) {
			try { session.abortBash(); }
			catch (error) { if (!failed) { failed = true; failure = error; } }
		}
		const pendingActivities = this.waitForAuxiliaryShutdown();
		try {
			// Both replacement and final disposal must join cooperative active work.
			// A synchronous dispose/abort request alone can outlive a successful quit.
			const abort = session.abort();
			if (pendingActivities) {
				// Observe an early abort rejection while the bounded activity owner
				// finishes. No Promise collection/tail is retained by the runtime.
				void abort.catch((error: unknown) => {
					if (!failed) { failed = true; failure = error; }
				});
				await pendingActivities;
			}
			await abort;
		} catch (error) { if (!failed) { failed = true; failure = error; } }
		// Also observe the lifecycle deadline if an abort callback threw synchronously.
		try { await pendingActivities; }
		catch (error) { if (!failed) { failed = true; failure = error; } }
		try {
			// Publish the exact result before shutdown/abort callbacks can reenter dispose.
			const shutdown = Promise.resolve().then(() => emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason, targetSessionFile }));
			session.captureSessionLeaseShutdown?.(shutdown);
			await shutdown;
		} catch (error) { if (!failed) { failed = true; failure = error; } }
		try {
			// Read at invocation time: final UI detach can disarm this during an await.
			this.beforeSessionInvalidate?.();
		} catch (error) { if (!failed) { failed = true; failure = error; } }
		try {
			session.dispose();
		} catch (error) { if (!failed) { failed = true; failure = error; } }
		try {
			await session.waitForSessionLeaseRelease?.();
		} catch (error) { if (!failed) { failed = true; failure = error; } }
		if (failed) reject(failure);
		else resolve();
	}

	private waitForAuxiliaryShutdown(): Promise<void> | undefined {
		if (this.session.isIdle !== false && !this.session.isCompacting && !this.session.isBashRunning) return undefined;
		// Manual compaction, branch summaries and shell commands have authoritative
		// activity flags but are not part of AgentSession.waitForIdle(). Observe
		// quiescence only at this one-owner lifecycle boundary; no delta/frame timer.
		const operation = new Promise<void>((resolve, reject) => {
			this.resolveAuxiliaryShutdown = resolve;
			this.rejectAuxiliaryShutdown = reject;
		});
		this.auxiliaryShutdownDeadline = Date.now() + 5000;
		this.auxiliaryShutdownTimer = setInterval(this.pollAuxiliaryShutdown, 10);
		return operation;
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this.teardownOperation = undefined;
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(
		generation: number,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<boolean> {
		if (!this.isReplacementCurrent(generation)) return false;
		if (this.rebindSession) {
			await this.rebindSession(this.session);
			if (!this.isReplacementCurrent(generation)) return false;
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
			if (!this.isReplacementCurrent(generation)) return false;
		}
		return true;
	}

	async setPermissionMode(mode: import("./permission-mode.ts").SessionPermissionMode): Promise<{ cancelled: boolean }> {
		if (mode !== "read-only" && mode !== "sandbox-write" && mode !== "host-write") throw new Error("Invalid session permission mode");
		const generation = this.beginReplacement();
		const manager = this.session.sessionManager;
		const directories = this.session.settingsManager.getSessionDirectories();
		if (!(await this.replaceCurrent("reload", { cwd: this.cwd, agentDir: this.services.agentDir, sessionManager: manager, permissionMode: mode, directories,
			sessionStartEvent: { type: "session_start", reason: "reload" } }, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation))) return { cancelled: true };
		try {
			manager.appendCustomEntry("session-permission-mode-v2", { mode, source: "user-command" });
			saveSessionExecutionProfile(this.services.agentDir, manager, { mode, directories });
		} catch (error) { await this.teardownCurrent("reload"); throw error; }
		return { cancelled: false };
	}

	async setWorkingDirectories(values: readonly string[]): Promise<{ cancelled: boolean }> {
		const current = this.session.settingsManager.getSessionDirectories(); let adding = false;
		for (const value of values) if (!current.includes(value)) { adding = true; break; }
		const directories = sessionDirectories(this.cwd, values, adding), mode = this.session.settingsManager.getPermissionMode();
		if (!mode) throw new Error("Working directories require the native session permission modes");
		const generation = this.beginReplacement(), manager = this.session.sessionManager;
		if (!(await this.replaceCurrent("reload", { cwd: this.cwd, agentDir: this.services.agentDir, sessionManager: manager,
			permissionMode: mode, directories, sessionStartEvent: { type: "session_start", reason: "reload" } }, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation))) return { cancelled: true };
		try {
			saveSessionExecutionProfile(this.services.agentDir, manager, { mode, directories });
			manager.appendCustomEntry("session-working-directories-v1", { directories, source: "user-command" });
		} catch (error) { await this.teardownCurrent("reload"); throw error; }
		return { cancelled: false };
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const generation = this.beginReplacement();
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled || !this.isReplacementCurrent(generation)) {
			return { cancelled: true };
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		if (!(await this.replaceCurrent("resume", {
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation, options?.withSession))) return { cancelled: true };
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const generation = this.beginReplacement();
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled || !this.isReplacementCurrent(generation)) {
			return { cancelled: true };
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}
		// Startup handlers must see the initialized destination (including Plan
		// state) before any prompt or background service is admitted there.
		if (options?.setup) {
			await options.setup(sessionManager);
			if (!this.isReplacementCurrent(generation)) return { cancelled: true };
		}

		if (!(await this.replaceCurrent("new", {
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation, options?.withSession))) return { cancelled: true };
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const generation = this.beginReplacement();
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled || !this.isReplacementCurrent(generation)) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				if (!(await this.replaceCurrent("fork", {
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}, generation))) return { cancelled: true };
				if (!(await this.finishSessionReplacement(generation, options?.withSession))) return { cancelled: true };
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Send a message before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			if (!(await this.replaceCurrent("fork", {
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}, generation))) return { cancelled: true };
			if (!(await this.finishSessionReplacement(generation, options?.withSession))) return { cancelled: true };
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		if (!(await this.replaceCurrent("fork", {
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation, options?.withSession))) return { cancelled: true };
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const generation = this.beginReplacement();
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled || !this.isReplacementCurrent(generation)) {
			return { cancelled: true };
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		if (!(await this.replaceCurrent("resume", {
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}, generation))) return { cancelled: true };
		if (!(await this.finishSessionReplacement(generation))) return { cancelled: true };
		return { cancelled: false };
	}

	dispose(): Promise<void> {
		if (this.disposeOperation) return this.disposeOperation;
		const operation = new Promise<void>((resolve, reject) => {
			this.resolveDispose = resolve;
			this.rejectDispose = reject;
		});
		this.disposeOperation = operation;
		this.disposed = true;
		void this.performDispose();
		return operation;
	}

	private async performDispose(): Promise<void> {
		let failed = false;
		let failure: unknown;
		// Capture before joining teardown: its continuations may clear the slot
		// (including after a failed reservation unlink) before this await resumes.
		const replacement = this.replacementOperation;
		try { this.cancelPendingReplacements(); }
		catch (error) { failed = true; failure = error; }
		try { await this.teardownCurrent("quit"); }
		catch (error) { if (!failed) { failed = true; failure = error; } }
		if (replacement) {
			let deadline: NodeJS.Timeout | undefined;
			try {
				await Promise.race([replacement, new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(() => reject(new Error("Session replacement has not stopped within 5000ms; target protection is retained.")), 5000);
				})]);
			} catch (error) { if (!failed) { failed = true; failure = error; } }
			finally { if (deadline) clearTimeout(deadline); }
		}
		this.beforeSessionInvalidate = undefined;
		this.rebindSession = undefined;
		const resolve = this.resolveDispose;
		const reject = this.rejectDispose;
		this.resolveDispose = undefined;
		this.rejectDispose = undefined;
		// Session/services remain readable for the post-TUI resume hint and existing
		// runtime consumers. Their owned listeners/content are released by dispose.
		if (failed) reject?.(failure);
		else resolve?.();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
