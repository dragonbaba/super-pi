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
		(error: unknown) =>
			error instanceof Error &&
			error.message.toLowerCase().includes("command completed") &&
			error.message.toLowerCase().includes("not retried"),
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
