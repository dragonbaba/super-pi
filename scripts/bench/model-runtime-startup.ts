import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, benchmarkFixtureManifest } from "./fixtures.ts";

let modelCount = 0;
let providerCount = 0;
let profiledModelCount = 0;

await runBenchmarkMain({
	name: "model-runtime-startup",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:model-runtime:offline:no-auth-refresh:model-profile-v1`,
	run: async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const models = runtime.getModels();
		modelCount = models.length;
		providerCount = runtime.getProviders().length;
		profiledModelCount = models.filter(
			(model) => model.profileSource !== undefined && model.capabilities?.version === 1,
		).length;
		return { modelCount, providerCount, profiledModelCount };
	},
	observations: () => ({
		modelProfileFixtureSha256: benchmarkFixtureManifest().fixtures.modelProfiles.sha256,
		network: false,
		authRefresh: false,
	}),
});
