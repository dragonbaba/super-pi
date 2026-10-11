import { close, createWriteStream, openSync, write, writev } from "node:fs";
import { openWindowsPrivateOutput } from "./windows-private-output.ts";

/** Internal filesystem boundary shared by user bash and tool output spools. */
export const privateOutputFileSystem = {
	openSync(path: string): number {
		return process.platform === "win32" ? openWindowsPrivateOutput(path) : openSync(path, "wx", 0o600);
	},
};

function openPrivateStream(path: string, _flags: number, _mode: number, callback: (error: Error | null, fd?: number) => void): void {
	let fd: number;
	try { fd = privateOutputFileSystem.openSync(path); }
	catch (error) { callback(error instanceof Error ? error : new Error(String(error))); return; }
	callback(null, fd);
}

// One shared adapter. Only open changes: Node still owns buffering/writev/close.
const WINDOWS_STREAM_OPTIONS = { flags: "wx", mode: 0o600, fs: { open: openPrivateStream, write, writev, close } };
const POSIX_STREAM_OPTIONS = { flags: "wx", mode: 0o600 };

export function createPrivateOutputStream(path: string) {
	return createWriteStream(path, process.platform === "win32" ? WINDOWS_STREAM_OPTIONS : POSIX_STREAM_OPTIONS);
}
