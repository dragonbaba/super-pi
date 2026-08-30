import { getEncoding } from "js-tiktoken";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import { sanitizeSurrogates } from "../../packages/ai/src/utils/sanitize-unicode.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../packages/coding-agent/src/core/tools/truncate.ts";
import {
	createToolTokenEstimatorCorpus,
	TOOL_TOKEN_ESTIMATOR_CORPUS_VERSION,
} from "../../tests/fixtures/tool-token-estimator-corpus.ts";

interface FixtureResult {
	id: string;
	category: string;
	actualTokens: number;
	estimatedTokens: number;
	underestimation: number;
	overestimation: number;
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

const encoding = getEncoding("cl100k_base");
const fixtures = createToolTokenEstimatorCorpus();
const results: FixtureResult[] = [];
for (const fixture of fixtures) {
	const actualTokens = fixture.referenceTokens ?? encoding.encode(sanitizeSurrogates(fixture.text)).length;
	const estimatedTokens = estimateToolOutputTokens([{ type: "text", text: fixture.text }]).estimatedTokens;
	results.push({
		id: fixture.id,
		category: fixture.category,
		actualTokens,
		estimatedTokens,
		underestimation: actualTokens === 0 ? 0 : Math.max(0, (actualTokens - estimatedTokens) / actualTokens),
		overestimation: actualTokens === 0 ? 0 : Math.max(0, (estimatedTokens - actualTokens) / actualTokens),
	});
}

const under = results.map((result) => result.underestimation).sort((left, right) => left - right);
const over = results.map((result) => result.overestimation).sort((left, right) => left - right);
const categoryMap = new Map<string, FixtureResult[]>();
for (const result of results) {
	const category = categoryMap.get(result.category);
	if (category) category.push(result);
	else categoryMap.set(result.category, [result]);
}
const categories = [];
for (const [category, categoryResults] of categoryMap) {
	categories.push({
		category,
		fixtures: categoryResults.length,
		actualTokens: categoryResults.reduce((sum, result) => sum + result.actualTokens, 0),
		estimatedTokens: categoryResults.reduce((sum, result) => sum + result.estimatedTokens, 0),
		averageUnderestimation:
			categoryResults.reduce((sum, result) => sum + result.underestimation, 0) / categoryResults.length,
		averageOverestimation:
			categoryResults.reduce((sum, result) => sum + result.overestimation, 0) / categoryResults.length,
	});
}

function simulatedToolCategory(category: string): string {
	if (category === "english-logs" || category === "shell-output" || category === "stack-traces" || category === "repeated-errors" || category === "ansi-logs") return "shell";
	if (category === "json" || category === "minified-json" || category === "base64-like" || category === "uuid-hash" || category === "urls") return "mcp";
	if (category === "typescript-javascript" || category === "python") return "read";
	return "extension";
}

const budgetValues = [1024, 2048, 4096, 8192, 16384];
const budgetSimulation = budgetValues.map((budget) => ({
	budget,
	wouldTruncateFixtures: 0,
	wouldTruncateRatio: 0,
	currentModelVisibleTokens: 0,
	proposedModelViewTokens: 0,
	modelVisibleTokenReductionRatio: 0,
}));
const toolCategorySimulation = new Map<string, { fixtures: number; currentModelVisibleTokens: number }>();
let currentCeilingWouldTruncate = 0;
let token4kWouldTruncate = 0;
let ceilingTokenDecisionMismatches = 0;
for (const fixture of fixtures) {
	const current = truncateTail(fixture.text);
	const currentTokens = estimateToolOutputTokens([{ type: "text", text: current.content }]).estimatedTokens;
	const toolCategory = simulatedToolCategory(fixture.category);
	const toolAggregate = toolCategorySimulation.get(toolCategory) ?? { fixtures: 0, currentModelVisibleTokens: 0 };
	toolAggregate.fixtures++;
	toolAggregate.currentModelVisibleTokens += currentTokens;
	toolCategorySimulation.set(toolCategory, toolAggregate);
	const currentCeilingDecision = current.truncated;
	const tokenDecision = currentTokens > 4096;
	if (currentCeilingDecision) currentCeilingWouldTruncate++;
	if (tokenDecision) token4kWouldTruncate++;
	if (currentCeilingDecision !== tokenDecision) ceilingTokenDecisionMismatches++;
	for (const simulation of budgetSimulation) {
		simulation.currentModelVisibleTokens += currentTokens;
		simulation.proposedModelViewTokens += Math.min(currentTokens, simulation.budget);
		if (currentTokens > simulation.budget) simulation.wouldTruncateFixtures++;
	}
}
for (const simulation of budgetSimulation) {
	simulation.wouldTruncateRatio = simulation.wouldTruncateFixtures / fixtures.length;
	simulation.modelVisibleTokenReductionRatio = simulation.currentModelVisibleTokens === 0
		? 0
		: 1 - simulation.proposedModelViewTokens / simulation.currentModelVisibleTokens;
}

const report = {
	schemaVersion: 1,
	corpusVersion: TOOL_TOKEN_ESTIMATOR_CORPUS_VERSION,
	referenceTokenizer: "js-tiktoken@1.0.21/cl100k_base",
	fixtureCount: results.length,
	gates: {
		p99UnderestimationAtMost: 0.1,
		averageOverestimationAtMost: 0.35,
	},
	metrics: {
		underestimationP50: percentile(under, 0.5),
		underestimationP95: percentile(under, 0.95),
		underestimationP99: percentile(under, 0.99),
		underestimationMax: percentile(under, 1),
		overestimationP50: percentile(over, 0.5),
		overestimationP95: percentile(over, 0.95),
		overestimationAverage: over.reduce((sum, value) => sum + value, 0) / over.length,
	},
	budgetSimulation: {
		buckets: budgetSimulation,
		toolCategories: [...toolCategorySimulation].map(([toolCategory, values]) => ({ toolCategory, ...values })),
		currentCeilingComparison: {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
			currentCeilingWouldTruncate,
			token4kWouldTruncate,
			decisionMismatches: ceilingTokenDecisionMismatches,
		},
	},
	categories,
	fixtures: results,
};

if (report.metrics.underestimationP99 > report.gates.p99UnderestimationAtMost) {
	throw new Error(`p99 underestimation gate failed: ${report.metrics.underestimationP99}`);
}
if (report.metrics.overestimationAverage > report.gates.averageOverestimationAtMost) {
	throw new Error(`average overestimation gate failed: ${report.metrics.overestimationAverage}`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
