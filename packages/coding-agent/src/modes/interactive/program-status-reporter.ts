import { sanitizeProgramStatusMessage, type ProgramStatusKind, type ProgramStatusState, type Terminal } from "@super-pi/tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";

function firstLine(text: string | undefined): string {
	const bounded = text?.slice(0, 2048) ?? "";
	const end = bounded.search(/[\r\n]/);
	return sanitizeProgramStatusMessage(end < 0 ? bounded : bounded.slice(0, end)) ?? "Error";
}

/** Fixed run/dialog state; ordinary deltas return without reporting or allocating. */
export class ProgramStatusReporter {
	private runActive = false;
	private compacting = false;
	private waitingForInput = false;
	private runResult: ProgramStatusState = "done";
	private runMessage: string | undefined;
	private restingState: ProgramStatusState = "idle";
	private restingMessage: string | undefined;
	private dialogKind: ProgramStatusKind | undefined;
	private dialogMessage: string | undefined;
	private loginMessage: string | undefined;
	private loginActive = false;
	private loginLatest = false;
	private lastState: ProgramStatusState | undefined;
	private lastKind: ProgramStatusKind | undefined;
	private lastMessage: string | undefined;
	private lastTerminal: Terminal | undefined;
	private disposed = false;
	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;

	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
	}

	handleEvent(event: AgentSessionEvent): void {
		if (this.disposed) return;
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.waitingForInput = false;
				this.runResult = "done";
				this.runMessage = undefined;
				break;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.runResult = event.message.stopReason === "error" ? "error" : "done";
				this.runMessage = this.runResult === "error" ? firstLine(event.message.errorMessage) : undefined;
				break;
			case "agent_end":
				this.waitingForInput = event.requiresUserInput === true;
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end": {
				this.compacting = false;
				const state = event.aborted ? "idle" : event.errorMessage ? "error" : "done";
				const message = state === "error" ? firstLine(event.errorMessage) : undefined;
				if (this.runActive) {
					if (event.aborted || event.errorMessage) { this.runResult = state; this.runMessage = message; }
				} else if (event.aborted || event.reason === "manual") {
					this.restingState = state;
					this.restingMessage = message;
				}
				break;
			}
			case "agent_settled":
				this.runActive = false;
				if (event.aborted) this.waitingForInput = false;
				this.restingState = event.aborted ? "idle" : this.runResult;
				this.restingMessage = event.aborted ? undefined : this.runMessage;
				break;
			case "session_info_changed": break;
			default: return;
		}
		this.report();
	}

	setBlocked(source: "extension-dialog" | "login", kind?: ProgramStatusKind, message?: string): void {
		if (this.disposed) return;
		if (source === "login") {
			this.loginActive = kind !== undefined;
			this.loginMessage = kind ? sanitizeProgramStatusMessage(message) : undefined;
			if (kind) this.loginLatest = true;
		} else {
			this.dialogKind = kind;
			this.dialogMessage = kind ? sanitizeProgramStatusMessage(message) : undefined;
			if (kind) this.loginLatest = false;
		}
		this.report();
	}

	reset(): void {
		this.runActive = false;
		this.compacting = false;
		this.waitingForInput = false;
		this.runResult = "done";
		this.runMessage = undefined;
		this.restingState = "idle";
		this.restingMessage = undefined;
		this.dialogKind = undefined;
		this.dialogMessage = undefined;
		this.loginActive = false;
		this.loginMessage = undefined;
		this.report();
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
		this.lastTerminal = undefined;
		this.lastMessage = undefined;
		this.lastState = undefined;
		this.lastKind = undefined;
	}

	report(): void {
		if (this.disposed) return;
		let state = this.runActive ? "working" as const : this.restingState;
		let message = this.runActive ? undefined : this.restingMessage;
		let kind: ProgramStatusKind | undefined;
		if (this.loginActive && (this.loginLatest || !this.dialogKind)) {
			state = "blocked"; kind = "auth"; message = this.loginMessage;
		} else if (this.dialogKind) {
			state = "blocked"; kind = this.dialogKind; message = this.dialogMessage;
		} else if (this.compacting) {
			state = "working"; message = "Compacting context";
		} else if (this.waitingForInput) {
			state = "blocked"; kind = "question"; message = "Waiting for input";
		} else if (state === "working" || state === "done") {
			message = sanitizeProgramStatusMessage(this.getSessionName());
		}
		const terminal = this.getTerminal();
		if (terminal === this.lastTerminal && state === this.lastState && kind === this.lastKind && message === this.lastMessage) return;
		// Optional metadata must not interrupt dialog resolution or owner cleanup.
		// ProcessTerminal already records output failure for its frame/lifecycle lane.
		try { terminal.setProgramStatus?.(state, message, kind, APP_NAME); }
		catch { return; }
		this.lastTerminal = terminal;
		this.lastState = state;
		this.lastKind = kind;
		this.lastMessage = message;
	}
}
