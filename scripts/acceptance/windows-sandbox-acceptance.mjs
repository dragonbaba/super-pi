// Deliberate manual entry, not CI or production. One blank instance per invocation.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { acquireAcceptanceRoot, blankConfig, DEFAULT_LIMITS, FixedCli, SandboxLifecycle, successful } from "./windows-sandbox-lifecycle.mjs";

export function blankAcceptancePassed(mode, owner, error, closed) {
	const startCall = owner.calls.find(call => call.kind === "start");
	const stopCall = owner.calls.find(call => call.kind === "stop");
	const expectedOutcome = mode === "cancel-start" ? "cancelled" : "timeout";
	const interruptedStart = owner.startAttempted && startCall?.outcome.split("/")[0] === expectedOutcome;
	return closed && owner.state === "closed" && owner.startSettled && owner.registered && owner.stopAttempted
		&& !!startCall && !!stopCall && owner.calls.every(call => successful(call.result))
		&& (mode === "blank" ? !error : interruptedStart);
}

export async function runBlankAcceptance(mode) {
	if (!["blank", "cancel-start", "timeout-start"].includes(mode)) throw new Error("Unknown blank acceptance mode");
	const config = blankConfig();
	const resource = acquireAcceptanceRoot();
	const controller = new AbortController();
	const owner = new SandboxLifecycle({ cli: new FixedCli(), config, journal: resource.journal,
		limits: mode === "timeout-start" ? { ...DEFAULT_LIMITS, startMs: 1 } : DEFAULT_LIMITS });
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
	let timer, error;
	// Cancel only after start has actually dispatched; preflight is not the probe.
	const cli = owner.cli;
	owner.cli = { launch(args) { const call = cli.launch(args); if (mode === "cancel-start" && args[0] === "start") timer = setTimeout(cancel, 1); return call; } };
	try { await owner.start(controller.signal); }
	catch (caught) { error = String(caught.message); }
	finally { clearTimeout(timer); }
	const closed = await owner.cleanup();
	process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
	const report = { mode, taskId: owner.taskId, instanceId: owner.id, state: owner.state, error: error ?? null,
		cleanupError: owner.cleanupError ?? null, calls: owner.calls, artifactRoot: resource.root, artifactsRemoved: false };
	if (closed) { resource.remove(owner); report.artifactsRemoved = true; }
	report.passed = blankAcceptancePassed(mode, owner, error, closed);
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("Expected exactly one acceptance mode");
	const report = await runBlankAcceptance(process.argv[2]);
	process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	if (!report.passed) process.exitCode = 1;
}
