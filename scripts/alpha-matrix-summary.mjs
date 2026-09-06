import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Offline report processing; no benchmark workload or user session is loaded.
// Preserve individual-process percentiles. Percentiles of process summaries
// are not pooled event percentiles and must not be presented as such.
const [directory, output, baselineDirectory] = process.argv.slice(2);
assert.ok(directory && output, 'usage: alpha-matrix-summary MATRIX NEW_OUTPUT [BASELINE_MATRIX]');
function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { count: values.length, mean, min: Math.min(...values), max: Math.max(...values), processCv: mean ? Math.sqrt(variance) / Math.abs(mean) : 0, values };
}
function flatten(value, prefix, result) {
  if (typeof value === 'number' && Number.isFinite(value)) result[prefix] = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  }
}
function load(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.results.length, manifest.planned, 'incomplete matrix');
  assert.ok(manifest.results.length <= 1500);
  const groups = new Map();
  for (const entry of manifest.results) {
    assert.equal(entry.exitCode, 0, entry.name);
    assert.match(entry.name, /^[a-z0-9-]+$/);
    const stdout = readFileSync(join(root, `${entry.name}.jsonl`));
    const stderr = readFileSync(join(root, `${entry.name}.stderr`));
    assert.equal(createHash('sha256').update(stdout).digest('hex'), entry.stdoutSha256);
    assert.equal(createHash('sha256').update(stderr).digest('hex'), entry.stderrSha256);
    const records = stdout.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const report = records.findLast(record => record.head === manifest.head);
    assert.ok(report, `missing exact-head record: ${entry.name}`);
    assert.equal(report.dirty, false);
    const name = entry.name.replace(/-n\d+$/, '');
    if (!groups.has(name)) groups.set(name, { suite: entry.suite, fields: new Map(), allocationSites: new Map(), processes: 0 });
    const group = groups.get(name); group.processes++;
    const fields = {}; flatten(report, '', fields);
    for (const [key, value] of Object.entries(fields)) {
      if (!group.fields.has(key)) group.fields.set(key, []);
      group.fields.get(key).push(value);
    }
    for (const site of report.allocations ?? []) {
      const key = `${site.source}:${site.function}`;
      group.allocationSites.set(key, (group.allocationSites.get(key) ?? 0) + site.bytes);
    }
  }
  const cases = {};
  for (const [name, group] of groups) {
    assert.equal(group.processes, manifest.runs);
    cases[name] = { suite: group.suite, processes: group.processes,
      metrics: Object.fromEntries([...group.fields].map(([key, values]) => [key, summarize(values)])),
      sampledTopSites: [...group.allocationSites].sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
  }
  return { head: manifest.head, platform: manifest.platform, node: manifest.node, processes: manifest.planned, cases };
}
const candidate = load(directory);
if (baselineDirectory) {
  const baseline = load(baselineDirectory);
  candidate.baselineHead = baseline.head;
  for (const [name, report] of Object.entries(candidate.cases)) {
    const previous = baseline.cases[name];
    if (!previous) continue;
    for (const [key, metric] of Object.entries(report.metrics)) {
      const before = previous.metrics[key];
      if (!before) continue;
      metric.baselineMean = before.mean;
      metric.absoluteDelta = metric.mean - before.mean;
      metric.percentDelta = before.mean ? 100 * metric.absoluteDelta / Math.abs(before.mean) : null;
      metric.baselineProcessCv = before.processCv;
    }
  }
}
writeFileSync(resolve(output), JSON.stringify({
  interpretation: 'Independent-process summary, not pooled event percentiles. Each original per-process percentile and CV is retained in metrics.*.values. Allocation top sites sum sampled top-15 records, not exact total allocation. Comparisons require matching workload and environment; high variance remains inconclusive. No acceptance decision is inferred.',
  ...candidate,
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ head: candidate.head, baselineHead: candidate.baselineHead, processes: candidate.processes, cases: Object.keys(candidate.cases).length, verifiedHashes: true }));
