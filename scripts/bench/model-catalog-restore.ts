import {
	createModels,
	InMemoryModelsStore,
	MODELS_STORE_PROFILE_REVISION,
	type Api,
	type Model,
} from "@super-pi/ai";
import { googleVertexProvider } from "@super-pi/ai/providers/google-vertex";
import { withRemoteCatalog } from "../../packages/coding-agent/src/core/remote-catalog-provider.ts";
import { runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION } from "./fixtures.ts";

function rawCatalogModel(model: Model<Api>): Model<Api> {
	const {
		capabilities: _capabilities,
		profileSource: _profileSource,
		profileDiagnostics: _profileDiagnostics,
		costKnown: _costKnown,
		thinkingBudgetMap: _thinkingBudgetMap,
		...raw
	} = model;
	return structuredClone(raw) as Model<Api>;
}

const provider = googleVertexProvider();
const target = provider.getModels().find((model) => model.id === "gemini-3.1-pro-preview");
if (!target) throw new Error("stored catalog fixture model is missing");
const store = new InMemoryModelsStore();
await store.write(provider.id, {
	profileRevision: MODELS_STORE_PROFILE_REVISION,
	models: [rawCatalogModel(target)],
	lastModified: Date.now() + 60_000,
	checkedAt: Date.now(),
});

await runBenchmarkMain({
	name: "model-catalog-restore",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:model-catalog-restore:offline:raw-profile-revision-${MODELS_STORE_PROFILE_REVISION}`,
	run: async () => {
		const models = createModels({ modelsStore: store });
		models.setProvider(withRemoteCatalog(provider));
		const result = await models.refresh({ providers: [provider.id], allowNetwork: false });
		if (result.errors.size > 0) throw result.errors.values().next().value;
		const restored = models.getModel(provider.id, target.id);
		if (!restored) throw new Error("stored catalog model was not restored");
		if (restored.capabilities?.reasoning.mode !== "levels" || restored.capabilities.strictToolSchema !== true) {
			throw new Error(
				`stored catalog model did not receive current provider profile: ${JSON.stringify(restored.capabilities)}`,
			);
		}
		return {
			modelCount: models.getModels().length,
			profiledModelCount: models.getModels().filter((model) => model.capabilities?.version === 1).length,
			restoredModelCount: 1,
		};
	},
	observations: () => ({
		provider: provider.id,
		model: target.id,
		profileRevision: MODELS_STORE_PROFILE_REVISION,
		network: false,
		reasoningMode: "levels",
		strictToolSchema: true,
	}),
});
