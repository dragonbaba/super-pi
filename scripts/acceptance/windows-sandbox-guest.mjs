// Fixed acceptance workloads only. No production import and no arbitrary command API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL = "super-pi-wsb-fixed-v1";
export const NODE_VERSION = "v26.13.0";
export const STREAM_LIMIT = 32 * 1024;
export const RESULT_LIMIT = 4096;
export const GUEST_INPUT = "C:\\SuperPiProbe\\Input";
export const GUEST_OUTPUT = "C:\\SuperPiProbe\\Output";
export const MODES = Object.freeze(["node", "powershell", "overflow"]);
export const STDOUT = "中文 stdout — literal $() & | \\\n";
export const STDERR = "中文 stderr\n";

export function validateRequest(value) {
	if (!value || Object.keys(value).sort().join(",") !== "mode,nodeVersion,protocol,taskId"
		|| value.protocol !== PROTOCOL || value.nodeVersion !== NODE_VERSION
		|| typeof value.taskId !== "string"
		|| !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.taskId)
		|| !MODES.includes(value.mode)) throw new Error("Invalid fixed Windows Sandbox request");
	return value;
}

// No per-chunk promises, closures, copies, concatenation, or retained output arrays.
// This is acceptance-only transport, not a general untrusted guest disk quota.
export class BoundedFileSink {
	fd;
	written = 0;
	seen = 0;
	truncated = false;
	failed = false;
	chunks = 0;
	constructor(file) { this.fd = fs.openSync(file, "wx"); }
	write(bytes) {
		this.chunks++;
		this.seen = Math.min(Number.MAX_SAFE_INTEGER, this.seen + bytes.length);
		const size = Math.min(bytes.length, STREAM_LIMIT - this.written);
		if (size < bytes.length) this.truncated = true;
		try {
			let offset = 0;
			while (offset < size) {
				const count = fs.writeSync(this.fd, bytes, offset, size - offset);
				if (count === 0) throw new Error("Output write made no progress");
				offset += count;
				this.written += count;
			}
		} catch { this.failed = true; }
	}
	close() {
		if (this.fd === undefined) return;
		const fd = this.fd;
		this.fd = undefined;
		try { fs.closeSync(fd); } catch { this.failed = true; }
	}
}

class FixedProbe {
	child;
	out;
	err;
	timer;
	resolve;
	termination = "exit";
	finished = false;
	onOut = bytes => { this.out.write(bytes); this.checkOutput(); };
	onErr = bytes => { this.err.write(bytes); this.checkOutput(); };
	onError = () => { this.termination = "launch-error"; };
	onClose = code => this.finish(code);
	onDeadline = () => { this.termination = "timeout"; this.stop(); };
	checkOutput() {
		if (this.out.failed || this.err.failed) this.termination = "write-error";
		else if (this.out.truncated || this.err.truncated) this.termination = "output-limit";
		else return;
		this.stop();
	}
	stop() {
		// These fixed probes never create descendants. Real instance/tree cleanup
		// belongs to the future host lifecycle, never to this result file.
		this.child?.kill();
		this.child?.stdout.destroy();
		this.child?.stderr.destroy();
	}
	finish(code) {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer); this.timer = undefined;
		this.child.stdout.removeListener("data", this.onOut);
		this.child.stderr.removeListener("data", this.onErr);
		this.child.removeListener("error", this.onError);
		this.child.removeListener("close", this.onClose);
		this.out.close(); this.err.close();
		if (this.out.failed || this.err.failed) this.termination = "write-error";
		const result = {
			termination: this.termination, exitCode: code,
			stdoutBytes: this.out.written, stderrBytes: this.err.written,
			stdoutTruncated: this.out.truncated, stderrTruncated: this.err.truncated,
		};
		const resolve = this.resolve;
		this.resolve = undefined; this.child = undefined; this.out = undefined; this.err = undefined;
		resolve(result);
	}
	async run(request, input, output) {
		this.out = new BoundedFileSink(path.join(output, "stdout.bin"));
		try { this.err = new BoundedFileSink(path.join(output, "stderr.bin")); }
		catch (error) { this.out.close(); this.out = undefined; throw error; }
		try {
			let executable, args;
			if (request.mode === "powershell") {
				executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
				args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(
					"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(STDOUT).toString("base64") + "'))); [Console]::Error.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(STDERR).toString("base64") + "'))); exit 17", "utf16le").toString("base64")];
			} else {
				executable = path.join(input, "node.exe");
				const code = request.mode === "overflow"
					? "process.stdout.write(Buffer.alloc(65537,65));"
					: `if(process.version!==${JSON.stringify(NODE_VERSION)})process.exit(91);process.stdout.write(${JSON.stringify(STDOUT)});process.stderr.write(${JSON.stringify(STDERR)});process.exitCode=23;`;
				args = ["--input-type=commonjs", "-e", code];
			}
			const done = new Promise(resolve => { this.resolve = resolve; });
			this.child = spawn(executable, args, {
				cwd: input, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
				env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: "C:\\Windows\\Temp", TMP: "C:\\Windows\\Temp", NODE_OPTIONS: "", NODE_PATH: "" },
			});
			this.child.stdout.on("data", this.onOut); this.child.stderr.on("data", this.onErr);
			this.child.on("error", this.onError); this.child.once("close", this.onClose);
			this.timer = setTimeout(this.onDeadline, 10_000);
			return await done;
		} catch (error) {
			clearTimeout(this.timer); this.timer = undefined;
			this.out?.close(); this.err?.close(); this.out = undefined; this.err = undefined; this.resolve = undefined;
			throw error;
		}
	}
}

// Exported for explicit host transport checks. They make no isolation claim.
export async function runFixedProbe(request, input, output) {
	validateRequest(request);
	const result = await new FixedProbe().run(request, input, output);
	const encoded = Buffer.from(JSON.stringify({ protocol: PROTOCOL, taskId: request.taskId, mode: request.mode, ...result }));
	if (encoded.length > RESULT_LIMIT) throw new Error("Result metadata exceeded limit");
	fs.writeFileSync(path.join(output, "result.json"), encoded, { flag: "wx" });
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.platform !== "win32" || process.version !== NODE_VERSION || process.argv.length !== 2
		|| path.dirname(fileURLToPath(import.meta.url)).toLowerCase() !== GUEST_INPUT.toLowerCase()) {
		throw new Error("This entry requires the fixed Windows guest input directory and Node version");
	}
	const raw = fs.readFileSync(path.join(GUEST_INPUT, "request.json"));
	if (raw.length > RESULT_LIMIT) throw new Error("Request metadata exceeded limit");
	await runFixedProbe(JSON.parse(raw.toString("utf8")), GUEST_INPUT, GUEST_OUTPUT);
}
