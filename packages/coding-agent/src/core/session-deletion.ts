import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { assertSessionNotLeased, getSessionLeaseDir, withSessionLeaseLock } from "./session-lease.ts";

export interface SessionDeletionResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

/** Explicit user deletion only. Check and mutation share the lease publication lock. */
export function deleteSessionFile(sessionPath: string, agentDir: string): SessionDeletionResult {
	const leaseDir = getSessionLeaseDir(agentDir);
	try {
		return withSessionLeaseLock(leaseDir, () => {
			assertSessionNotLeased(leaseDir, sessionPath);
			const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
			const trash = spawnSync("trash", args, {
				encoding: "utf-8", windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024, killSignal: "SIGKILL",
			});
			const parts: string[] = [];
			if (trash.error) parts.push(trash.error.message);
			const stderr = trash.stderr?.trim();
			if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
			const hint = parts.length ? `trash: ${parts.join(" · ").slice(0, 200)}` : undefined;
			const code = (trash.error as NodeJS.ErrnoException | undefined)?.code;
			// Timeout is a termination request, not a process-tree cleanup guarantee.
			// Uncertain completion must never fall through to permanent deletion,
			// even if the file disappeared or a contradictory success status arrived.
			if (code === "ETIMEDOUT" || code === "ENOBUFS" || trash.signal) {
				return { ok: false, method: "trash", error: hint ?? `trash terminated (${trash.signal ?? code})` };
			}
			if (trash.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
			try {
				// Do not return a Promise from this synchronous lock callback.
				unlinkSync(sessionPath);
				return { ok: true, method: "unlink" };
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return { ok: false, method: "unlink", error: hint ? `${detail} (${hint})` : detail };
			}
		});
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
	}
}
