import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "node:inspector";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fixture } from "../../tests/helpers/evidence-ledger-fixture.ts";
import { EvidenceLedger } from "../../packages/coding-agent/src/core/evidence-ledger.ts";

const mode = process.argv[2];
const out = process.argv[3] ?? "evidence-ledger-results";
if (!["hit", "miss", "disabled", "compare", "profile", "gc"].includes(mode)) throw new Error("Expected hit/miss/disabled/compare/profile/gc");
mkdirSync(out, { recursive: true });

function percentile(values: number[], fraction: number): number {
	values.sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

async function measure(config: "hit" | "miss" | "disabled", large: boolean) {
	const f = await fixture(config !== "disabled");
	if (large) writeFileSync(join(f.cwd, "file.txt"), "large source text with line content\n".repeat(20_000));
	const times: number[] = [];
	const integrityTimes: number[] = [];
	const owner = f.internals._toolResultPresentation!;
	const validate = owner.validateEvidenceArtifact.bind(owner);
	owner.validateEvidenceArtifact = (...args) => {
		const start = performance.now();
		const valid = validate(...args);
		integrityTimes.push(performance.now() - start);
		return valid;
	};
	try {
		await f.read();
		for (let i = 0; i < 110; i++) {
			if (config === "miss") f.internals._evidenceLedger!.mutate();
			const start = performance.now();
			await f.read();
			if (i >= 10) times.push(performance.now() - start);
		}
		const counters = f.internals._evidenceLedger?.counters;
		if (config === "hit") {
			assert.equal(counters!.realReadExecutions, 1);
			assert.equal(counters!.hits, 110);
			assert.equal(counters!.g2ArtifactIntegrityScans, 110);
		}
		return { config, corpus: large ? "large" : "medium", samples: times.length,
			p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95),
			integrityP50Ms: integrityTimes.length ? percentile(integrityTimes, 0.5) : 0,
			integrityP95Ms: integrityTimes.length ? percentile(integrityTimes, 0.95) : 0,
			bytesHashedPerHit: counters?.hits ? counters.g2ArtifactIntegrityBytes / counters.hits : 0,
			counters: counters ?? null, ledgerAllocated: !!counters };
	} finally { f.close(); }
}

function post(session: Session, method: string, params: object = {}): Promise<any> {
	return new Promise((resolve, reject) => session.post(method as any, params, (error, result) => error ? reject(error) : resolve(result)));
}

// The same three configurations in one process, alternating order to reduce
// worker/JIT drift observed between the first independent-process samples.
async function compare(large: boolean) {
	const configs = ["hit", "miss", "disabled"] as const;
	const fixtures = [await fixture(), await fixture(), await fixture(false)];
	const times: number[][] = [[], [], []];
	const integrity: number[] = [];
	const owner = fixtures[0].internals._toolResultPresentation!;
	const validate = owner.validateEvidenceArtifact.bind(owner);
	owner.validateEvidenceArtifact = (...args) => {
		const start = performance.now(); const valid = validate(...args);
		integrity.push(performance.now() - start); return valid;
	};
	try {
		for (const f of fixtures) {
			if (large) writeFileSync(join(f.cwd, "file.txt"), "large source text with line content\n".repeat(20_000));
			await f.read();
		}
		for (let i = 0; i < 110; i++) {
			for (let n = 0; n < 3; n++) {
				const index = i % 2 ? n : 2 - n;
				if (index === 1) fixtures[index].internals._evidenceLedger!.mutate();
				const start = performance.now(); await fixtures[index].read();
				if (i >= 10) times[index].push(performance.now() - start);
			}
		}
		assert.equal(fixtures[0].internals._evidenceLedger!.counters.hits, 110);
		assert.equal(fixtures[0].internals._evidenceLedger!.counters.realReadExecutions, 1);
		return configs.map((config, index) => {
			const c = fixtures[index].internals._evidenceLedger?.counters;
			return { config, corpus: large ? "large" : "medium", paired: true, samples: 100,
				p50Ms: percentile(times[index], 0.5), p95Ms: percentile(times[index], 0.95),
				integrityP50Ms: index === 0 ? percentile(integrity, 0.5) : 0,
				integrityP95Ms: index === 0 ? percentile(integrity, 0.95) : 0,
				bytesHashedPerHit: c?.hits ? c.g2ArtifactIntegrityBytes / c.hits : 0,
				counters: c ?? null, ledgerAllocated: !!c };
		});
	} finally { for (const f of fixtures) f.close(); }
}

async function disposedReferences() {
	const f = await fixture();
	const message = await f.read();
	const refs = { session: new WeakRef(f.session), owner: new WeakRef(f.internals._toolResultPresentation!),
		message: new WeakRef(message), content: new WeakRef(message.content) };
	const ledger = f.internals._evidenceLedger!;
	f.close();
	return { refs, ledger };
}

if (mode === "compare") {
	assert.notEqual(process.platform, "win32");
	const results = [...await compare(false), ...await compare(true)];
	writeFileSync(join(out, "comparison.json"), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results));
} else if (mode === "gc") {
	assert.ok(global.gc, "Use --expose-gc");
	const { refs, ledger } = await disposedReferences();
	let released = false;
	for (let i = 0; i < 20; i++) {
		await nextTurn();
		global.gc();
		await nextTurn();
		released = !refs.session.deref() && !refs.owner.deref() && !refs.message.deref() && !refs.content.deref();
		if (released) break;
	}
	assert.equal(released, true, "Disposed ledger must not retain session/source/owner graphs");
	assert.equal(ledger.counters.entries, 0);
	assert.equal(ledger.counters.metadataBytes, 0);
	const structural = new EvidenceLedger();
	for (let i = 0; i < 100_000; i++) structural.lookup("absent");
	assert.equal(structural.counters.entries, 0);
	assert.equal(structural.counters.metadataBytes, 0);
	const result = { released, weakRefs: 4, entries: ledger.counters.entries, metadataBytes: ledger.counters.metadataBytes,
		retainedSourceReferences: ledger.counters.retainedSourceReferences, structuralLookups: structural.counters.lookups };
	writeFileSync(join(out, "gc.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
} else if (mode === "profile") {
	assert.notEqual(process.platform, "win32", "Actual hit profiling requires reliable filesystem identity");
	const f = await fixture();
	writeFileSync(join(f.cwd, "file.txt"), "large source text with line content\n".repeat(20_000));
	await f.read();
	for (let i = 0; i < 10; i++) await f.read();
	const session = new Session(); session.connect();
	try {
		await post(session, "HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < 100; i++) await f.read();
		const profile = await post(session, "HeapProfiler.stopSampling");
		const c = f.internals._evidenceLedger!.counters;
		assert.equal(c.hits, 110);
		assert.equal(c.realReadExecutions, 1);
		const result = { samples: 100, hits: c.hits, realReadExecutions: c.realReadExecutions,
			entries: c.entries, metadataBytes: c.metadataBytes, retainedSourceReferences: c.retainedSourceReferences };
		writeFileSync(join(out, "allocation.heapprofile.json"), JSON.stringify(profile.profile));
		writeFileSync(join(out, "allocation-summary.json"), JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result));
	} finally { session.disconnect(); f.close(); }
} else {
	assert.notEqual(process.platform, "win32", "These three comparable configurations require an eligible local filesystem");
	const results = [await measure(mode as "hit" | "miss" | "disabled", false), await measure(mode as "hit" | "miss" | "disabled", true)];
	writeFileSync(join(out, `${mode}.json`), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results));
}
