import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { resolveClipboardNative } from "./clipboard-native.ts";
import type { ClipboardModule } from "./clipboard-native.ts";

export const NATIVE_CLIPBOARD_TIMEOUT_MS = 3000;
export const NATIVE_CLIPBOARD_STOP_MS = 1000;
// Same 10 MiB encoded-image limit as the attachment owner. Text is separately bounded.
const IMAGE_BYTES = 10 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024;
const STDERR_BYTES = 4096;

// Fixed application program, binary stdout, no shell or clipboard-derived code/arguments.
// hasImage AND async addon work live in this disposable process. Length is checked
// before materializing the addon's number[] as a second byte buffer. The addon may
// already have decoded/allocated internally; this is not a native peak-memory bound.
const NATIVE_CLIPBOARD_SCRIPT = `
const [modulePath, kind, limitText] = process.argv.slice(1);
const limit = Number(limitText);
(async () => {
 const source = require(modulePath);
 let data;
 if (kind === 'image') {
  if (!source.hasImage()) return;
  data = await source.getImageBinary();
  if (data.length > limit) { process.exitCode = 3; return; }
 } else {
  data = await source.getText();
  if (Buffer.byteLength(data, 'utf8') > limit) { process.exitCode = 3; return; }
 }
 const bytes = Buffer.from(data);
 await new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
})().catch(() => { process.exitCode = 2; });
`;

export class NativeClipboardError extends Error {
	readonly fatal: boolean;
	constructor(message: string, fatal = false) { super(message); this.fatal = fatal; }
}

async function readNativeClipboardSource(kind: "image" | "text", source: ClipboardModule, signal?: AbortSignal): Promise<Buffer | null> {
	signal?.throwIfAborted();
	if (kind === "image" && !source.hasImage()) return null;
	const value = kind === "image" ? await source.getImageBinary() : await source.getText();
	signal?.throwIfAborted();
	const bytes = kind === "image" ? Uint8Array.from(value as number[]) : Buffer.from(value as string, "utf8");
	const limit = kind === "image" ? IMAGE_BYTES : TEXT_BYTES;
	if (bytes.byteLength > limit) throw new NativeClipboardError("剪贴板内容超过字节限制", true);
	return bytes.byteLength ? Buffer.from(bytes) : null;
}

// One physical read across sessions, including a quarantined operation whose
// termination could not be confirmed. No queue and no recurring retry timer.
let activeRead: object | undefined;

/** Results and ordinary errors settle only after child close (exit plus closed pipes). */
export function readNativeClipboard(kind: "image" | "text", signal?: AbortSignal, source?: ClipboardModule | null, modulePathOverride?: string): Promise<Buffer | null> {
	signal?.throwIfAborted();
	if (source !== undefined) return source ? readNativeClipboardSource(kind, source, signal) : Promise.resolve(null);
	if (activeRead) return Promise.reject(new NativeClipboardError("原生剪贴板读取仍在停止中，尚未确认退出", true));
	const modulePath = modulePathOverride ?? resolveClipboardNative();
	if (!modulePath) return Promise.resolve(null);
	// A compiled executable cannot safely be relaunched with Node's -e contract.
	if (import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN")) {
		return Promise.reject(new NativeClipboardError("当前编译运行时不支持隔离剪贴板 helper"));
	}
	const token = {}; activeRead = token;
	return new Promise((resolve, reject) => {
		const limit = kind === "image" ? IMAGE_BYTES : TEXT_BYTES;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, ["-e", NATIVE_CLIPBOARD_SCRIPT, modulePath, kind, String(limit)], {
				cwd: dirname(modulePath), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) { activeRead = undefined; reject(error); return; }
		let chunks: Buffer[] = [], size = 0, stderrSize = 0;
		let failure: Error | undefined, settled = false, stopping = false;
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = setTimeout(() => stop(new NativeClipboardError("原生剪贴板读取超时（3000 ms）", true)), NATIVE_CLIPBOARD_TIMEOUT_MS);
		function settle(error?: Error, value?: Buffer | null): void {
			if (settled) return;
			settled = true;
			clearTimeout(deadline); clearTimeout(stopTimer);
			signal?.removeEventListener("abort", abort);
			chunks = []; size = 0;
			if (error) reject(error); else resolve(value ?? null);
		}
		function stop(error: Error): void {
			failure ??= error;
			if (stopping) return;
			stopping = true; clearTimeout(deadline); chunks = []; size = 0;
			stopTimer = setTimeout(() => {
				// Keep token and minimal close/error observers until actual close.
				// Callers must NOT fall through to another backend on this fault.
				settle(new NativeClipboardError("原生剪贴板停止失败：尚未确认进程退出，请重启会话进程后重试", true));
			}, NATIVE_CLIPBOARD_STOP_MS);
			try { child.kill("SIGKILL"); } catch { /* close or bounded quarantine decides ownership. */ }
		}
		function abort(): void { stop(new NativeClipboardError("剪贴板读取已取消", true)); }
		function onError(error: Error): void { stop(error); }
		function onData(data: Buffer): void {
			if (stopping || settled) return;
			size += data.length;
			if (size > limit) { stop(new NativeClipboardError("剪贴板内容超过字节限制", true)); return; }
			chunks.push(data);
		}
		function onStderr(data: Buffer): void {
			stderrSize += data.length;
			if (stderrSize > STDERR_BYTES) stop(new NativeClipboardError("原生剪贴板错误输出超过限制", true));
		}
		function onClose(code: number | null): void {
			clearTimeout(deadline); clearTimeout(stopTimer); signal?.removeEventListener("abort", abort);
			child.removeListener("error", onError); child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onData); child.stdout?.removeListener("error", onError);
			child.stderr?.removeListener("data", onStderr); child.stderr?.removeListener("error", onError);
			if (activeRead === token) activeRead = undefined;
			const error = failure ?? (code === 3 ? new NativeClipboardError("剪贴板内容超过字节限制", true)
				: code !== 0 ? new NativeClipboardError(`原生剪贴板读取失败（退出码 ${code}）`) : undefined);
			const result = !settled && !error && size ? Buffer.concat(chunks, size) : null;
			settle(error, result);
		}
		child.on("error", onError); child.once("close", onClose);
		child.stdout?.on("data", onData); child.stdout?.on("error", onError);
		child.stderr?.on("data", onStderr); child.stderr?.on("error", onError);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
