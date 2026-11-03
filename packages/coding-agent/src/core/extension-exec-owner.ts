import { execCommand, type ExecLifecycleOwner, type ExecOptions, type ExecResult } from "./exec.ts";
import type { ExecutionBoundaryParticipant, SessionExecutionBoundary } from "./execution-boundary.ts";

/** One service per runtime. Only invocation/finish and transition touch this set. */
export class ExtensionExecOwner implements ExecLifecycleOwner, ExecutionBoundaryParticipant {
	private readonly boundary: SessionExecutionBoundary;
	private readonly pending = new Set<Promise<ExecResult>>();
	private cleanupFailure: string | undefined;
	constructor(boundary: SessionExecutionBoundary) {
		this.boundary = boundary;
		boundary.register("extension-exec", this);
	}
	get signal(): AbortSignal { return this.boundary.signal; }
	async exec(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult> {
		this.boundary.assertCurrent();
		if (this.cleanupFailure) throw new Error(this.cleanupFailure);
		const execution = execCommand(command, args, cwd, options, this);
		this.pending.add(execution);
		try { return await execution; }
		finally { this.pending.delete(execution); }
	}
	recordCleanupFailure(message: string): void { this.cleanupFailure ??= message; }
	// SessionExecutionBoundary aborts its signal synchronously before revoking services.
	revoke(): void {}
	async drain(): Promise<void> {
		// Invalid arguments reject to their caller; only failed physical cleanup poisons drain.
		await Promise.allSettled(this.pending);
		if (this.cleanupFailure) throw new Error(this.cleanupFailure);
	}
}
