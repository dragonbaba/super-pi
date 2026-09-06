import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const heap = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const meta = heap.snapshot.meta;
const nf = meta.node_fields, ef = meta.edge_fields;
const ni = Object.fromEntries(nf.map((name, index) => [name, index]));
const ei = Object.fromEntries(ef.map((name, index) => [name, index]));
for (const name of ['type', 'name', 'id', 'self_size', 'edge_count']) assert.ok(name in ni);
for (const name of ['type', 'name_or_index', 'to_node']) assert.ok(name in ei);
const nodeTypes = meta.node_types[ni.type], edgeTypes = meta.edge_types[ei.type];
const count = heap.nodes.length / nf.length;
assert.ok(Number.isInteger(count));
const firstEdge = new Uint32Array(count + 1);
const parent = new Int32Array(count).fill(-1);
const via = new Int32Array(count).fill(-1);
const queue = new Uint32Array(count);
const targets = [];
for (let node = 0; node < count; node++) {
  const offset = node * nf.length;
  firstEdge[node + 1] = firstEdge[node] + heap.nodes[offset + ni.edge_count] * ef.length;
  const type = nodeTypes[heap.nodes[offset + ni.type]];
  const name = heap.strings[heap.nodes[offset + ni.name]];
  const bytes = heap.nodes[offset + ni.self_size];
  if (type === 'string' && bytes >= 65536 && (name.startsWith('start ') || name.startsWith('x'.repeat(64)))) targets.push(node);
}
assert.equal(firstEdge[count], heap.edges.length);
let read = 0, write = 1; queue[0] = 0; parent[0] = 0;
while (read < write) {
  const node = queue[read++];
  for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += ef.length) {
    if (edgeTypes[heap.edges[edge + ei.type]] === 'weak') continue;
    const child = heap.edges[edge + ei.to_node] / nf.length;
    if (parent[child] !== -1) continue;
    parent[child] = node; via[child] = edge; queue[write++] = child;
  }
}
function describe(node) {
  const offset = node * nf.length;
  const type = nodeTypes[heap.nodes[offset + ni.type]];
  const name = heap.strings[heap.nodes[offset + ni.name]];
  return { type, name: type === 'string' ? '<string>' : name.slice(0, 100), bytes: heap.nodes[offset + ni.self_size] };
}
const reports = [];
for (const target of targets.slice(0, 20)) {
  const path = []; let node = target;
  while (parent[node] > 0 && path.length < 128) {
    const edge = via[node]; const type = edgeTypes[heap.edges[edge + ei.type]];
    const index = heap.edges[edge + ei.name_or_index];
    const label = type === 'element' || type === 'hidden' ? String(index) : heap.strings[index];
    path.push({ ...describe(parent[node]), edge: label.length <= 100 ? label : '<long edge label>' });
    node = parent[node];
  }
  reports.push({ id: heap.nodes[target * nf.length + ni.id], ...describe(target), reachableWithoutWeakEdges: parent[target] !== -1, path: path.reverse() });
}
console.log(JSON.stringify({ nodes: count, edges: heap.edges.length / ef.length, fixtureStringTargets: targets.length, reports }));
