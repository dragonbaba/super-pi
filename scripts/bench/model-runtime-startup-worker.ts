import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
const models = runtime.getModels();
const result = {
	modelCount: models.length,
	providerCount: runtime.getProviders().length,
	profiledModelCount: models.filter(
		(model) => model.profileSource !== undefined && model.capabilities?.version === 1,
	).length,
};

process.stdout.write(JSON.stringify(result));
