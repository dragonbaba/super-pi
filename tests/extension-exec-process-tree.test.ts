import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { execCommand } from "../packages/coding-agent/src/core/exec.ts";
import { windowsShellJobDiagnostics } from "../packages/coding-agent/src/utils/windows-shell-job.ts";

// Every PID comes from this invocation's private loopback handshake. No process scan.
for (const mode of ["normal", "inherited-output", "abort", "timeout", "cap"] as const) {
	test(`exec owns an ignored-stdio descendant through ${mode}`, { timeout: 15000 }, async () => {
		const controller = new AbortController();
		let descendant: number | undefined, socket: Socket | undefined;
		const server = createServer();
		server.listen(0, "127.0.0.1"); await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		const ready = new Promise<void>(resolve => server.once("connection", connection => {
			socket = connection;
			connection.on("error", error => { assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET"); });
			let data = "";
			connection.on("data", chunk => {
				data += chunk;
				if (!data.endsWith("\n")) return;
				descendant = Number(data.trim());
				assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
				resolve();
			});
		}));
		const source = `
const {spawn}=require('node:child_process');
const descendant=spawn(process.execPath,['-e',${JSON.stringify(`
const socket=require('node:net').connect(${port},'127.0.0.1',()=>{
 socket.write(process.pid+'\\n');process.send('ready');
});
setInterval(()=>{${mode === "inherited-output" ? "process.stdout.write('tail');" : ""}},10);
`)}],{stdio:['ignore',${mode === "inherited-output" ? "'inherit','inherit'" : "'ignore','ignore'"},'ipc'],windowsHide:true,detached:process.platform==='win32'});
descendant.once('message',()=>{
 ${mode === "normal" || mode === "inherited-output" ? "process.exit(0);" : mode === "cap" ? "process.stdout.write('overflow');" : ""}
});
setInterval(()=>{},1000);
`;
		let pending: ReturnType<typeof execCommand> | undefined;
		try {
			pending = execCommand(process.execPath, ["-e", source], process.cwd(), {
				signal: controller.signal, timeout: mode === "timeout" ? 1000 : 10000, maxBuffer: mode === "cap" ? 1 : 1024,
			});
			await Promise.race([ready, pending.then(() => { if (!descendant) throw new Error("command exited before descendant handshake"); })]);
			if (mode === "abort") controller.abort();
			const result = await pending;
			const cancelled = mode !== "normal" && mode !== "inherited-output";
			assert.equal(result.code, cancelled ? 1 : 0, result.stderr);
			assert.equal(result.killed, cancelled);
			assert.throws(() => process.kill(descendant!, 0), { code: "ESRCH" });
			assert.equal(windowsShellJobDiagnostics().handles, 0);
			assert.equal(windowsShellJobDiagnostics().processHandles, 0);
		} finally {
			controller.abort();
			if (descendant) {
				try { process.kill(descendant, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
			await pending;
			socket?.destroy();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});
}
