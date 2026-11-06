// Actual guest search helpers over a synthetic filesystem. No VM or project I/O.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { Session } from 'node:inspector/promises';
import { setImmediate } from 'node:timers/promises';
import ts from 'typescript';
import { isProtectedWorkspaceName } from '../../packages/coding-agent/src/core/sandbox/workspace-policy.mjs';

assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc');
const source = ts.createSourceFile('worker.mjs', fs.readFileSync('packages/coding-agent/src/core/sandbox/workspace-worker.mjs', 'utf8'), ts.ScriptTarget.Latest, true);
const helpers = new Set(['need', 'local', 'read', 'grepRows', 'search']);
const constants = new Set(['FILE_LIMIT', 'TRAILING_PATH_PATTERN', 'SEARCH_ROWS', 'SEARCH_ENTRIES', 'DIRECTORY_ENTRIES']);
const text = source.statements.filter(node => ts.isFunctionDeclaration(node) && helpers.has(node.name?.text)
  || ts.isVariableStatement(node) && constants.has(node.declarationList.declarations[0].name.getText(source)))
  .map(node => node.getText(source)).join('\n');
const create = new Function('fs', 'path', 'isUtf8', 'isProtectedWorkspaceName', text + '\nreturn search;');
const root = path.resolve('fixture'), scope = path.join(root, 'src');
const refs = [], iterations = 256;
function yes() { return true; }
function no() { return false; }
const directory = { isDirectory: yes, isFile: no, isSymbolicLink: no };
const file = { isDirectory: no, isFile: yes, isSymbolicLink: no, size: 7 };
function fixture() {
  const entries = Array.from({length:201}, (_, index) => ({name:index+'.txt',isDirectory:no,isFile:yes,isSymbolicLink:no}));
  const bytes = Buffer.from('needle\n');
  const io = {
    lists:0, reads:0, stats:0, fail:false,
    existsSync:no,
    lstatSync(target) { this.stats++; return target === scope ? directory : file; },
    readdirSync(target) { assert.equal(target, scope); this.lists++; return entries; },
    readFileSync() { this.reads++; if (this.fail && this.reads === 7) throw new Error('fixture read failure'); return bytes; },
  };
  const search = create(io, path, isUtf8, isProtectedWorkspaceName);
  refs.push(new WeakRef(io), new WeakRef(entries), new WeakRef(bytes), new WeakRef(search));
  return {io, search};
}
function exercise(operation) {
  const {io, search} = fixture();
  for (let index = 0; index < 32; index++) search(root, operation, 'src', operation === 'find' ? '.txt' : 'needle');
  io.lists = 0; io.reads = 0; io.stats = 0;
  for (let index = 0; index < iterations; index++) {
    const result = search(root, operation, 'src', operation === 'find' ? '.txt' : 'needle');
    assert.ok(result.endsWith('[Results truncated at 200 rows; narrow the search scope.]'));
  }
  assert.equal(io.lists, iterations);
  assert.equal(io.reads, operation === 'grep' ? iterations * 201 : 0);
  return {lists:io.lists / iterations, reads:io.reads / iterations, stats:io.stats / iterations};
}
function fail() {
  const {io, search} = fixture(); io.fail = true;
  assert.throws(() => search(root, 'grep', 'src', 'needle'), /fixture read failure/);
  io.fail = false;
  assert.ok(search(root, 'grep', 'src', 'needle').includes('Results truncated'));
}
const profiler = new Session(); profiler.connect();
const results = [];
try {
  for (const operation of ['ls', 'find', 'grep']) {
    await profiler.post('HeapProfiler.startSampling', {samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
    const counters = exercise(operation);
    const {profile} = await profiler.post('HeapProfiler.stopSampling');
    let sampledBytes = 0; const sites = [];
    function inspect(node) {
      sampledBytes += node.selfSize;
      if (node.selfSize) sites.push({name:node.callFrame.functionName,bytes:node.selfSize});
      for (const child of node.children ?? []) inspect(child);
    }
    inspect(profile.head); sites.sort((a,b) => b.bytes-a.bytes);
    results.push({operation, measuredInvocations:iterations, warmupInvocations:32, counters, sampledBytes,
      sampledBytesPerInvocationIncludingWarmup:sampledBytes/(iterations+32), sites:sites.slice(0,8)});
  }
  fail();
  for (let index = 0; index < 4; index++) { await setImmediate(); globalThis.gc(); }
  let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(retained, 0);
  console.log(JSON.stringify({results, structural:{maximumRows:200,overflowProbeRows:1,collectorArraysPerInvocation:2,
    perEntryCallbacks:0,perEntryPromises:0,perEntryAbortControllers:0,perEntryOptionWrappers:0,wholeWorkspaceCatalogs:0},
    lifecycle:{observed:refs.length,retained,paths:['normal','overflow','throw','retry'],collectorClearedInFinally:true},
    note:'Includes synthetic fixture and path-library allocation; source invariants enforce the structural contract. No VM latency or speedup claim.'}));
} finally { profiler.disconnect(); }
