import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import type { Api, Model } from "../../packages/ai/src/types.ts";

export const generatorUrl = new URL("../../packages/ai/scripts/generate-models.ts", import.meta.url);

// Run the actual generator, including final overrides/serialization. All HTTP
// and output filesystem effects stay inside this fixture-owned VM.
export async function generateCatalog(fixtures: Record<string, unknown>): Promise<Record<string, Record<string, Model<Api>>>> {
	const source = readFileSync(generatorUrl, "utf8");
	const file = ts.createSourceFile("generate-models.ts", source, ts.ScriptTarget.Latest, true);
	const writes = new Map<string, string>();
	const globals: Record<string, unknown> = {
		process: { argv: ["node", fileURLToPath(generatorUrl), "--json-only", "--json-output", "fixture-catalog"] },
		console: { log() {}, error(error: unknown) { throw error; } },
		fetch: async (url: string) => {
			assert.ok(Object.hasOwn(fixtures, url), `unexpected catalog request: ${url}`);
			return { ok: true, json: async () => structuredClone(fixtures[url]) };
		},
	};
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		if (!clause || clause.isTypeOnly) continue;
		const specifier = statement.moduleSpecifier.text;
		const imported = await import(specifier.startsWith(".") ? new URL(specifier, generatorUrl).href : specifier);
		if (clause.name) globals[clause.name.text] = imported.default;
		if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
			for (const binding of clause.namedBindings.elements) {
				if (!binding.isTypeOnly) globals[binding.name.text] = imported[(binding.propertyName ?? binding.name).text];
			}
		}
	}
	// JSON-only generation must never reach internal data-directory operations.
	for (const name of ["renameSync", "mkdtempSync", "readFileSync", "readdirSync"]) {
		globals[name] = () => { throw new Error(`unexpected generator filesystem call: ${name}`); };
	}
	globals.rmSync = () => {};
	globals.mkdirSync = () => {};
	globals.writeFileSync = (path: string, value: string) => { writes.set(path, value); };
	const statements = file.statements.filter(statement => !ts.isImportDeclaration(statement));
	const startup = statements.pop();
	assert.ok(startup?.getText(file).startsWith("generateModels().catch("));
	const program = statements.map(statement => statement.getText(file)).join("\n")
		.replaceAll("import.meta.url", JSON.stringify(generatorUrl.href));
	const javascript = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	const context = vm.createContext(globals);
	vm.runInContext(javascript, context);
	await vm.runInContext("generateModels()", context);
	const output = [...writes].find(([path]) => path.endsWith(join("fixture-catalog", "models.json")));
	assert.ok(output, "generator did not publish models.json");
	const catalog = JSON.parse(output[1]);
	for (const [provider, models] of Object.entries(catalog)) {
		assert.deepEqual(JSON.parse(writes.get(join(dirname(output[0]), "providers", `${provider}.json`))!), models);
	}
	return catalog;
}

export const baseRates = { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 };
export const tieredCost = {
	...baseRates,
	tiers: [
		{ tier: { type: "context", size: 200 }, input: 6, output: 18, cache_read: 0.6, cache_write: 7.5 },
		{ tier: { type: "context", size: 100 }, input: 4, output: 12, cache_read: 0.4, cache_write: 5 },
	],
};
export const sourceProviders = [
	"amazon-bedrock", "anthropic", "google", "google-vertex", "openai", "groq", "cerebras",
	"cloudflare-workers-ai", "cloudflare-ai-gateway", "xai", "zai-coding-plan", "mistral", "huggingface",
	"nvidia", "togetherai", "opencode", "opencode-go", "github-copilot", "minimax", "minimax-cn",
	"kimi-for-coding", "moonshotai", "moonshotai-cn", "xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp", "alibaba-token-plan", "alibaba-token-plan-cn", "baseten", "fireworks-ai",
] as const;
export function catalogFixtures(cost: unknown = tieredCost): Record<string, any> {
	const modelsDev: Record<string, unknown> = {};
	for (const provider of sourceProviders) {
		const id = provider.startsWith("minimax") ? "MiniMax-M3" : provider === "cloudflare-ai-gateway" ? "openai/gpt-tier-fixture"
			: provider === "google-vertex" ? "gemini-tier-fixture"
				: provider === "alibaba-token-plan" ? "qwen3.8-max" : "gpt-tier-fixture";
		modelsDev[provider] = { models: { [id]: {
			id, name: id, tool_call: true, reasoning: false, cost,
			limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] },
		} } };
	}
	return {
		"https://models.dev/api.json": modelsDev,
		"https://integrate.api.nvidia.com/v1/models": { data: [{ id: "gpt-tier-fixture" }] },
		"https://openrouter.ai/api/v1/models": { data: [] },
		"https://ai-gateway.vercel.sh/v1/models": { data: [] },
	};
}
