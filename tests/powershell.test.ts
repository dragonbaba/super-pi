import assert from "node:assert/strict";
import test from "node:test";
import {
	initializePowerShellPersistence,
	type PowerShellPersistenceDependencies,
} from "../packages/coding-agent/src/core/powershell-persistence.ts";
import {
	createLocalPowerShellOperations,
	createPowerShellToolState,
} from "../packages/coding-agent/src/core/tools/powershell.ts";
import type { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import type { PowerShellConfig } from "../packages/coding-agent/src/utils/shell.ts";
import { normalizeShellProcessResult, observedShellError, shellProcessResultFromError, type ShellProcessResult } from "../packages/coding-agent/src/core/tools/shell-execution.ts";

const INITIAL_CONFIG: PowerShellConfig = {
	shell: "C:\\PowerShell\\pwsh.exe",
	args: ["-NoProfile", "-Command"],
	source: "configured",
};
const RECOVERED_CONFIG: PowerShellConfig = {
	shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
	args: ["-NoProfile", "-Command"],
	source: "standard-pwsh",
	version: "7.6.5",
	edition: "Core",
};
const EXEC_OPTIONS = { onData: (_data: Buffer): void => {} };

for (const facts of [
  { exitCode: 23, termination: "exit" },
  { exitCode: 0 },
  { exitCode: null, termination: "unknown" },
  { exitCode: null, termination: "signal" },
] satisfies ShellProcessResult[]) test(`N3 attached completion facts prevent executable-code replay: ${JSON.stringify(facts)}`, async () => {
  let executions = 0, probes = 0, confirmations = 0;
  const failure = observedShellError(Object.assign(new Error("executor failed"), { code: "ENOENT" }), facts);
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG,
    probe() { probes++; return RECOVERED_CONFIG; }, onConfirmed() { confirmations++; },
    async execute() { executions++; throw failure; } });
  await assert.rejects(operations.exec("stateful", process.cwd(), EXEC_OPTIONS), error => error === failure);
  assert.equal(executions, 1); assert.equal(probes, 0); assert.equal(confirmations, 0);
});

for (const recovered of [true, false]) test(`N3 resolved unstarted PowerShell result recovers only once: recovered=${recovered}`, async () => {
  let executions = 0, probes = 0;
  const confirmed: PowerShellConfig[] = [], state = createPowerShellToolState();
  const unstarted: ShellProcessResult = { exitCode: null, termination: "not_started",
    observation: { started: false, spawnAttempted: true, exitCode: null, signal: null, outputDrained: true } };
  const operations = createLocalPowerShellOperations({ state, resolveCandidate: () => INITIAL_CONFIG,
    probe() { probes++; return RECOVERED_CONFIG; }, onConfirmed(config) { confirmed.push(config); },
    async execute(config) { executions++; return recovered && config === RECOVERED_CONFIG ? { exitCode: 0 } : unstarted; } });
  if (recovered) assert.equal((await operations.exec("stateful", process.cwd(), EXEC_OPTIONS)).exitCode, 0);
  else await assert.rejects(operations.exec("stateful", process.cwd(), EXEC_OPTIONS), error => {
    assert.equal(shellProcessResultFromError(error), unstarted); return true;
  });
  assert.equal(executions, 2); assert.equal(probes, 1); assert.deepEqual(confirmed, [RECOVERED_CONFIG]);
  assert.equal(state.confirmed, recovered); assert.equal(Boolean(state.disabledReason), !recovered);
});

for (const facts of [
  { exitCode: null, termination: "unknown" },
  { exitCode: null, termination: "cancelled", observation: { started: false, exitCode: null, signal: null, outputDrained: true } },
  { exitCode: null, termination: "exit" },
  { exitCode: 0, termination: "signal" },
  { exitCode: 0, termination: "not_started" },
] satisfies ShellProcessResult[]) test(`N3 incomplete PowerShell facts never confirm or replay: ${JSON.stringify(facts)}`, async () => {
  let executions = 0, probes = 0, confirmations = 0;
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG,
    probe() { probes++; return RECOVERED_CONFIG; }, onConfirmed() { confirmations++; },
    async execute() { executions++; return facts; } });
  assert.deepEqual(await operations.exec("stateful", process.cwd(), EXEC_OPTIONS), normalizeShellProcessResult(facts));
  assert.equal(executions, 1); assert.equal(probes, 0); assert.equal(confirmations, 0);
});

for (const facts of [
  { exitCode: null, termination: "exit" }, { exitCode: 0, termination: "signal" }, { exitCode: 0, termination: "not_started" },
] satisfies ShellProcessResult[]) test(`N3 normalization rejects contradictions without observation: ${JSON.stringify(facts)}`, () => {
  const result = normalizeShellProcessResult(facts);
  assert.equal(result.termination, "unknown"); assert.equal(result.exitCode, null); assert.ok(result.observationError);
  assert.equal(shellProcessResultFromError(observedShellError(new Error("fixture"), facts))?.termination, "unknown");
});

for (const persistenceFailure of [false, true]) test(`N3 PowerShell real attempted spawn survives failed recovery, persistence=${persistenceFailure}`, async () => {
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG,
    probe() { throw new Error("No recovery executable"); }, onUnavailable() { if (persistenceFailure) throw new Error("persist unavailable failed"); } });
  await assert.rejects(operations.exec("unused", process.cwd(), EXEC_OPTIONS), (error: any) => {
    const result = shellProcessResultFromError(error); assert.ok(result); assert.equal(result.observation?.started, false);
    assert.equal(result.observation?.spawnAttempted, true); assert.equal(result.termination, "not_started");
    assert.equal(result.observationError, persistenceFailure ? "persist unavailable failed" : undefined); return true;
  });
});

test("N3 successful PowerShell recovery probe with failed confirmation retains the real failed launch", async () => {
  let probes = 0, confirmations = 0;
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG,
    probe() { probes++; return RECOVERED_CONFIG; }, onConfirmed() { confirmations++; throw new Error("confirmation denied"); } });
  await assert.rejects(operations.exec("unused", process.cwd(), EXEC_OPTIONS), (error: any) => {
    const result = shellProcessResultFromError(error)!; assert.equal(result.observation?.started, false); assert.equal(result.observation?.spawnAttempted, true);
    assert.equal(result.termination, "not_started"); assert.equal(result.observationError, "confirmation denied"); return true;
  });
  assert.equal(probes, 1); assert.equal(confirmations, 1);
});

for (const prior of [false, true]) test(`N3 disabled-state persistence failure is a bounded structured diagnostic, prior=${prior}`, async () => {
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG, probe() { throw new Error("no recovery"); },
    async execute() { throw observedShellError(Object.assign(new Error("missing executable"), { code: "ENOENT" }), {
      exitCode: null, termination: "not_started", observation: { started: false, spawnAttempted: true, exitCode: null, signal: null, outputDrained: true },
      observationError: prior ? "first diagnostic" : undefined }); },
    onUnavailable() { throw new Error("persist unavailable " + "x".repeat(2000)); } });
  await assert.rejects(operations.exec("unused", process.cwd(), EXEC_OPTIONS), (error: any) => {
    const result = shellProcessResultFromError(error)!; assert.equal(result.observation?.spawnAttempted, true);
    assert.equal((prior ? result.secondaryObservationError : result.observationError)?.length, 1000);
    assert.ok((prior ? result.secondaryObservationError : result.observationError)?.startsWith("persist unavailable "));
    if (prior) assert.equal(result.observationError, "first diagnostic"); return true;
  });
});

for (const secondary of [false, true]) test(`N3 PowerShell confirmation preserves existing observation diagnostics, secondary=${secondary}`, async () => {
  const operations = createLocalPowerShellOperations({ resolveCandidate: () => INITIAL_CONFIG,
    execute: async () => ({ exitCode: 0, termination: "exit", observationError: "completion " + "x".repeat(2000), secondaryObservationError: secondary ? "existing secondary" : undefined }),
    onConfirmed() { throw new Error("confirmation " + "y".repeat(2000)); } });
  await assert.rejects(operations.exec("unused", process.cwd(), EXEC_OPTIONS), (error: any) => {
    const result = shellProcessResultFromError(error)!; assert.equal(result.exitCode, 0); assert.equal(result.observationError?.length, 1000);
    assert.ok(result.observationError?.startsWith("completion ")); assert.ok(result.secondaryObservationError?.startsWith(secondary ? "existing secondary" : "confirmation "));
    assert.equal(result.observationErrorsOmitted, secondary ? true : undefined); return true;
  });
});

test("a non-zero command exit confirms PowerShell without probing or replaying", async () => {
	let executions = 0;
	let probes = 0;
	let confirmations = 0;
	const operations = createLocalPowerShellOperations({
		resolveCandidate: () => INITIAL_CONFIG,
		probe: () => {
			probes++;
			return RECOVERED_CONFIG;
		},
		execute: async () => {
			executions++;
			return { exitCode: 17 };
		},
		onConfirmed: () => {
			confirmations++;
		},
	});

	assert.deepEqual(await operations.exec("exit 17", process.cwd(), EXEC_OPTIONS), { exitCode: 17 });
	assert.equal(executions, 1);
	assert.equal(probes, 0);
	assert.equal(confirmations, 1);
});

test("an executable launch failure probes once and retries once", async () => {
	let executions = 0;
	let probes = 0;
	const operations = createLocalPowerShellOperations({
		resolveCandidate: () => INITIAL_CONFIG,
		probe: () => {
			probes++;
			return RECOVERED_CONFIG;
		},
		execute: async (config) => {
			executions++;
			if (config === INITIAL_CONFIG) throw Object.assign(new Error("missing executable"), { code: "ENOENT" });
			return { exitCode: 0 };
		},
	});

	assert.deepEqual(await operations.exec("Write-Output ok", process.cwd(), EXEC_OPTIONS), { exitCode: 0 });
	assert.equal(executions, 2);
	assert.equal(probes, 1);
});

test("a confirmation persistence failure never replays a completed command", async () => {
	let executions = 0;
	let probes = 0;
	const operations = createLocalPowerShellOperations({
		resolveCandidate: () => INITIAL_CONFIG,
		probe: () => {
			probes++;
			return RECOVERED_CONFIG;
		},
		execute: async () => {
			executions++;
			return { exitCode: 0 };
		},
		onConfirmed: () => {
			throw Object.assign(new Error("settings denied"), { code: "EACCES" });
		},
	});

	await assert.rejects(
		operations.exec("Write-Output stateful", process.cwd(), EXEC_OPTIONS),
		(error: unknown) => {
			assert.equal(shellProcessResultFromError(error)?.observationError, "settings denied");
			assert.equal(shellProcessResultFromError(error)?.exitCode, 0);
			return error instanceof Error && error.message.toLowerCase().includes("command completed") && error.message.toLowerCase().includes("not retried");
		},
	);
	assert.equal(executions, 1);
	assert.equal(probes, 0);
});

test(
	"persisted unavailable state remains disabled across a path change until explicitly enabled",
	{ skip: process.platform !== "win32" },
	async () => {
		let configuredPath = "C:\\New\\pwsh.exe";
		let resolveCalls = 0;
		let persistedStatus: Record<string, unknown> | undefined;
		const settings = {
			getPowerShellPath: () => configuredPath,
			getPowerShellStatus: () => ({
				trustVersion: 1,
				path: "C:\\Old\\pwsh.exe",
				available: false,
				verified: true,
				configuredPath: "C:\\Old\\pwsh.exe",
			}),
			setPowerShellStatusDurably: async (status: Record<string, unknown>) => {
				persistedStatus = status;
			},
		} as unknown as SettingsManager;
		const dependencies: PowerShellPersistenceDependencies = {
			pathExists: () => true,
			resolveCandidate: () => {
				resolveCalls++;
				return RECOVERED_CONFIG;
			},
		};

		assert.equal(await initializePowerShellPersistence(settings, { dependencies }), false);
		assert.equal(resolveCalls, 0);
		assert.equal(persistedStatus, undefined);

		assert.equal(
			await initializePowerShellPersistence(settings, { forceEnable: true, dependencies }),
			true,
		);
		assert.equal(resolveCalls, 1);
		const enabledStatus = persistedStatus as Record<string, unknown> | undefined;
		assert.ok(enabledStatus);
		assert.equal(enabledStatus.available, true);
		assert.equal(enabledStatus.verified, false);
	},
);

test("a disabled runtime state fails without resolving or executing", async () => {
	const state = createPowerShellToolState();
	state.disable("persisted unavailable");
	let resolveCalls = 0;
	let executions = 0;
	const operations = createLocalPowerShellOperations({
		state,
		resolveCandidate: () => {
			resolveCalls++;
			return INITIAL_CONFIG;
		},
		execute: async () => {
			executions++;
			return { exitCode: 0 };
		},
	});

	await assert.rejects(
		operations.exec("Write-Output no", process.cwd(), EXEC_OPTIONS),
		(error: unknown) => error instanceof Error && error.message.includes("persisted unavailable"),
	);
	assert.equal(resolveCalls, 0);
	assert.equal(executions, 0);
});
