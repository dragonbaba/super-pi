import { readFileSync } from "node:fs";
import { parseBenchmarkResult } from "./benchmark.ts";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
	console.error("Usage: compare.ts <baseline.json> <candidate.json>");
	process.exitCode = 1;
} else {
	try {
		const baseline = parseBenchmarkResult(readFileSync(baselinePath, "utf8"));
		const candidate = parseBenchmarkResult(readFileSync(candidatePath, "utf8"));
		if (baseline.name !== candidate.name) throw new Error(`Benchmark names differ: ${baseline.name} vs ${candidate.name}`);
		if (baseline.fixture !== candidate.fixture) throw new Error(`Benchmark fixtures differ: ${baseline.fixture} vs ${candidate.fixture}`);

		const metrics: Record<string, { baseline: number; candidate: number; changePercent: number | null }> = {};
		for (const [name, baselineValue] of Object.entries(baseline.metrics)) {
			const candidateValue = candidate.metrics[name];
			if (candidateValue === undefined) continue;
			metrics[name] = {
				baseline: baselineValue,
				candidate: candidateValue,
				changePercent: baselineValue === 0 ? null : ((candidateValue - baselineValue) / baselineValue) * 100,
			};
		}
		process.stdout.write(`${JSON.stringify({ name: baseline.name, fixture: baseline.fixture, metrics }, null, 2)}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
