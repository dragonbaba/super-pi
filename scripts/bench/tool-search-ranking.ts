import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { searchFixture, type SearchTool } from "../../tests/helpers/tool-search-fixture.ts";

const moduleIndex = process.argv.indexOf("--search-module");
const modulePath = resolve(moduleIndex < 0 ? "packages/tool-classification/src/index.ts" : process.argv[moduleIndex + 1]);
const { default: extension } = await import(pathToFileURL(modulePath).href);
const optimized = moduleIndex < 0, smoke = process.argv.includes("--smoke");
const warmup = 10, timingIterations = 4096, profileIterations = 32, samplingInterval = 1024;
assert.ok(globalThis.gc, "run with --expose-gc");
const query = "export report archive";
function catalog(size: number): SearchTool[] {
	return Array.from({ length: size }, (_, i) => ({ name: `${String(size - i).padStart(4, "0")}_report_export`, description: `Archive report export utility ${i}; ${"bounded catalog text ".repeat(8)}` }));
}
async function gc() { for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); } }
async function count(size: number, query: string) {
	const f = searchFixture(catalog(size), extension);
	const normalize = String.prototype.normalize, includes = String.prototype.includes, sort = Array.prototype.sort;
	let normalizations = 0, substringComparisons = 0, sortComparisons = 0;
	const terms = new Set<string>();
	String.prototype.normalize = function(form) { normalizations++; return normalize.call(this, form); };
	String.prototype.includes = function(term, position) { substringComparisons++; terms.add(term); return includes.call(this, term, position); };
	Array.prototype.sort = function(compare) { return sort.call(this, compare && ((a, b) => { sortComparisons++; return compare(a, b); })); };
	let result;
	try { result = await f.search(query); }
	finally { String.prototype.normalize = normalize; String.prototype.includes = includes; Array.prototype.sort = sort; }
	if (optimized) { assert.equal(normalizations, 1 + 2 * size); assert.ok(substringComparisons <= size * terms.size * 3); }
	assert.equal(f.counters.catalogReads, 1);
	return { size, query, terms: [...terms], normalizations, substringComparisons, sortComparisons, ...f.counters, matches: result.details.matches };
}
async function lifecycle(size: number, mode: "normal" | "rejected" | "error") {
	const f = searchFixture([], extension);
	if (mode === "rejected") f.setAllowed(() => false);
	if (mode === "error") f.setAllowed(() => { throw new Error("fixture activation failed"); });
	const refs: WeakRef<object>[] = [];
	function supply() { const tools = catalog(size); refs.push(new WeakRef(tools)); for (const tool of tools) refs.push(new WeakRef(tool)); f.setCatalog(tools); }
	supply(); let result;
	if (mode === "error") await assert.rejects(f.search(query), /fixture activation failed/);
	else result = await f.search(query);
	f.setCatalog([]);
	await gc(); const retainedCatalogObjects = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
	assert.equal(retainedCatalogObjects, 0);
	if (result) { assert.equal(result.details.matches.length, 6); assert.equal(result.details.added.length, mode === "rejected" ? 0 : 6); }
	// Hold the extension and returned details alive while old catalog objects are collected.
	assert.equal((await f.search("no match")).details.matches.length, 0);
	return { size, mode, observedObjects: refs.length, retainedCatalogObjects };
}
function profileStats(root: any) {
	let total = 0; const sites = new Map<string, number>();
	function visit(node: any) { total += node.selfSize; const label = `${node.callFrame.functionName || "(anonymous)"}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`; sites.set(label, (sites.get(label) ?? 0) + node.selfSize); for (const child of node.children) visit(child); }
	visit(root); return { total, topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
async function measure(size: number, query: string) {
	const f = searchFixture(catalog(size), extension), active = ["tool_search"];
	async function run() { f.setActive(active); return f.search(query); }
	for (let i = 0; i < warmup; i++) await run(); await gc();
	const before = process.memoryUsage(), cpu = process.cpuUsage(), times: number[] = [];
	for (let i = 0; i < timingIterations; i++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
	const elapsedCpu = process.cpuUsage(cpu); await gc(); const after = process.memoryUsage();
	const session = new Session(); session.connect(); let profile;
	try {
		await session.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
		for (let i = 0; i < profileIterations; i++) await run();
		profile = (await session.post("HeapProfiler.stopSampling")).profile;
	} finally { session.disconnect(); }
	const allocations = profileStats(profile.head); times.sort((a, b) => a - b);
	return { size, query, p50Ms: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
		cpuUsPerSearch: (elapsedCpu.user + elapsedCpu.system) / timingIterations,
		sampledBytesPerSearch: allocations.total / profileIterations, topSites: allocations.topSites, before, after };
}
const counters = [], releases = [], profiles = [];
for (const size of [100, 1000]) {
	counters.push(await count(size, query));
	counters.push(await count(size, "検索ファイル"));
	for (const mode of ["normal", "rejected", "error"] as const) releases.push(await lifecycle(size, mode));
	if (!smoke) profiles.push(await measure(size, query), await measure(size, "検索ファイル"));
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, modulePath, optimized,
	sourceSha256: createHash("sha256").update(readFileSync(modulePath)).digest("hex"), warmup, timingIterations, profileIterations, samplingInterval,
	counters, releases, profiles, notes: "Explicit-search boundary only; no catalog index/cache or work on frame/event delivery. Substring comparisons and sort comparisons are counted separately. Caller-owned match names/details remain alive during catalog GC checks." }, null, 2));
