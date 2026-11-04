// Fixed controlled workloads only. Dedicated disposable mappings; never a project workspace.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle, successful } from "./windows-sandbox-lifecycle.mjs";
import { prepareWindowsSandboxPackage, readWindowsSandboxResult, sha256 } from "./windows-sandbox-package.mjs";
import { STDOUT, STDERR } from "./windows-sandbox-guest.mjs";

// Observed from both fixed real runs on pinned 0.8.107.0: { "ExitCode": 0 }.
// This is the guest wrapper's code, not the CLI process or its fixed child.
export function parseFixedEntryExit(result) {
	if (!successful(result)) throw new Error("Cannot interpret an unsuccessful exec CLI reply");
	const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
	if (!value || Object.keys(value).join(",") !== "ExitCode" || !Number.isInteger(value.ExitCode)
		|| value.ExitCode < -2147483648 || value.ExitCode > 4294967295) throw new Error("Unknown fixed exec reply schema");
	return value.ExitCode;
}

function directoryIdentity(directory) {
	const identity = fs.lstatSync(directory, { bigint: true });
	if (!identity.isDirectory() || identity.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("Package directory is redirected");
	return { path: directory, dev: identity.dev.toString(), ino: identity.ino.toString() };
}

async function awaitResultMarker(output, signal) {
	const deadline = Date.now() + 15_000, marker = path.join(output, "result.json");
	for (;;) {
		if (signal.aborted) throw new Error("Fixed task cancelled; stop before reading results");
		// Presence only, never interpret data while the VM can still write it.
		if (fs.existsSync(marker)) return;
		if (Date.now() >= deadline) throw new Error("Fixed result marker deadline exceeded");
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

export async function runFixedAcceptance(mode) {
	if (!["node", "powershell"].includes(mode)) throw new Error("Only the two reviewed fixed tasks are allowed");
	const resource = acquireAcceptanceRoot();
	const prepared = await prepareWindowsSandboxPackage(resource.root, mode);
	const workload = { request: prepared.request, root: directoryIdentity(prepared.root), input: directoryIdentity(prepared.input), output: directoryIdentity(prepared.output),
		nodeSha256: prepared.nodeSha256, guestSha256: prepared.guestSha256, requestSha256: sha256(path.join(prepared.input, "request.json")), arbitraryCommands: false, writableShareQuota: false };
	const owner = new SandboxLifecycle({ cli: new FixedCli(), config: fs.readFileSync(path.join(prepared.root, "sandbox.wsb"), "utf8"),
		journal: resource.journal, taskId: prepared.request.taskId, workload });
	const controller = new AbortController(), cancel = () => controller.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	let error, captured, wrapperExitCode = null;
	try {
		await owner.start(controller.signal);
		wrapperExitCode = parseFixedEntryExit(await owner.executeFixed(controller.signal));
		if (wrapperExitCode !== 0) throw new Error("Fixed guest wrapper failed");
		await awaitResultMarker(prepared.output, controller.signal);
	} catch (caught) { error = String(caught.message); }
	let closed;
	try { closed = await owner.cleanup(); }
	finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
	if (closed && !error) {
		try {
			captured = readWindowsSandboxResult(prepared.output, prepared.request);
			if (captured.result.termination !== "exit" || captured.result.exitCode !== (mode === "node" ? 23 : 17)
				|| !captured.stdout.equals(Buffer.from(STDOUT)) || !captured.stderr.equals(Buffer.from(STDERR))) throw new Error("Fixed task result mismatch");
		} catch (caught) { error = String(caught.message); }
	}
	const report = { mode, taskId: owner.taskId, instanceId: owner.id, workload, state: owner.state,
		error: error ?? null, cleanupError: owner.cleanupError ?? null, calls: owner.calls,
		wrapperExitCode, taskResult: captured?.result ?? null,
		stdoutBase64: captured?.stdout.toString("base64") ?? null, stderrBase64: captured?.stderr.toString("base64") ?? null,
		artifactRoot: resource.root, artifactsRemoved: false };
	if (closed) { resource.remove(owner); report.artifactsRemoved = true; }
	report.passed = closed && !error && wrapperExitCode === 0 && owner.stopAttempted && !!captured && owner.calls.some(call => call.kind === "exec")
		&& owner.calls.every(call => successful(call.result));
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("Expected exactly one fixed mode");
	const report = await runFixedAcceptance(process.argv[2]);
	process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	if (!report.passed) process.exitCode = 1;
}
