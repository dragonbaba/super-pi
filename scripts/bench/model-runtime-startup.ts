import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, benchmarkFixtureManifest } from "./fixtures.ts";

type StartupMode = "cold" | "warm";

function startupMode(): StartupMode {
	const index = process.argv.indexOf("--mode");
	const value = index === -1 ? "cold" : process.argv[index + 1];
	if (value !== "cold" && value !== "warm") throw new Error("--mode must be cold or warm");
	return value;
}

interface StartupMetrics {
	modelCount: number;
	providerCount: number;
	profiledModelCount: number;
}

let modelCount = 0;
let providerCount = 0;
let profiledModelCount = 0;
const mode = startupMode();
const requireProfileCoverage = !process.argv.includes("--allow-unprofiled");

async function constructRuntime(): Promise<StartupMetrics> {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const models = runtime.getModels();
	return {
		modelCount: models.length,
		providerCount: runtime.getProviders().length,
		profiledModelCount: models.filter(
			(model) => model.profileSource !== undefined && model.capabilities?.version === 1,
		).length,
	};
}

function constructColdRuntime(): StartupMetrics {
	const worker = fileURLToPath(new URL("./model-runtime-startup-worker.ts", import.meta.url));
	const child = spawnSync(process.execPath, ["--experimental-strip-types", worker], {
		cwd: process.cwd(),
		encoding: "utf8",
		windowsHide: true,
	});
	if (child.status !== 0) throw new Error(child.stderr || `cold startup worker exited ${String(child.status)}`);
	return JSON.parse(child.stdout) as StartupMetrics;
}

await runBenchmarkMain({
	name: `model-runtime-startup-${mode}`,
	fixture: `${BENCHMARK_FIXTURE_VERSION}:model-runtime:${mode}:offline:no-auth-refresh:model-profile-v1`,
	run: async () => {
		const metrics = mode === "cold" ? constructColdRuntime() : await constructRuntime();
		({ modelCount, providerCount, profiledModelCount } = metrics);
		if (requireProfileCoverage && profiledModelCount !== modelCount) {
			throw new Error(`profile coverage mismatch: ${profiledModelCount}/${modelCount}`);
		}
		return { modelCount, providerCount, profiledModelCount };
	},
	observations: () => ({
		modelProfileFixtureSha256: benchmarkFixtureManifest().fixtures.modelProfiles.sha256,
		startupMode: mode,
		processIsolation: mode === "cold" ? "child-per-sample" : "same-process",
		network: false,
		authRefresh: false,
	}),
});
