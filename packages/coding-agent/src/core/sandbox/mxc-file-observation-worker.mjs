import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { captureTreeIdentity, capturePathIdentity, hashIdentity, sameIdentity, boundedReason } from '../files/file-tree-core.mjs';
import { workspaceFilePath } from '../files/file-workspace-path.mjs';
import { FILE_OBSERVATION_HASH_BYTES, FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES } from '../files/file-operation-limits.mjs';

function need(value, reason) { if (!value) throw new Error('[FILE_OBSERVATION] ' + reason); }
const ROOT_FIELDS = new Set(['id', 'mode', 'workspaces', 'workspaceIdentities', 'operation', 'exchange', 'maxWriteBytes', 'callId', 'requestHash', 'generation', 'version', 'rpc', 'targets']);
const TARGET_FIELDS = new Set(['path', 'workspaceIndex', 'hash']);
function fields(value, allowed) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Expected an observation object');
  for (const key of Object.keys(value)) need(allowed.has(key), 'Unexpected observation field');
}
async function observe(target) {
  let identity;
  try { identity = await captureTreeIdentity(target.path); }
  catch (error) { if (error.code === 'ENOENT') return { path: target.path, exists: false }; throw error; }
  need(identity.canonical === target.path, 'Recorded canonical path now resolves elsewhere');
  const value = { path: target.path, exists: true, identity };
  if (target.hash && !identity.directory && !identity.symbolicLink) {
    if (Number(identity.size) > FILE_OBSERVATION_HASH_BYTES) value.hashOmitted = 'Content exceeds the 32 MiB verification bound.';
    else value.sha256 = await hashIdentity(identity);
  }
  return value;
}
export async function runFileObservationRequest(request, serialized) {
  const reply = { version: 1, rpc: 'file-observation-v1', id: request?.id, requestHash: request?.requestHash,
    generation: request?.generation, wireHash: createHash('sha256').update(serialized).digest('hex'), ok: false };
  try {
    need(Buffer.byteLength(serialized) <= FILE_RPC_REQUEST_BYTES, 'Request exceeds byte budget'); fields(request, ROOT_FIELDS);
    need(request.version === 1 && request.rpc === reply.rpc && request.operation === 'file_observe'
      && Array.isArray(request.targets) && request.targets.length > 0 && request.targets.length <= 35
      && Array.isArray(request.workspaces) && request.workspaces.length > 0 && request.workspaces.length <= 17
      && request.workspaceIdentities?.length === request.workspaces.length, 'Invalid observation scope');
    for (let index = 0; index < request.workspaces.length; index++) {
      const identity = await capturePathIdentity(request.workspaces[index]);
      need(identity.directory && identity.canonical === request.workspaces[index]
        && identity.device + ':' + identity.inode === request.workspaceIdentities[index], 'Workspace identity changed');
    }
    const observations = [];
    for (const target of request.targets) {
      fields(target, TARGET_FIELDS); need(typeof target.hash === 'boolean', 'Invalid content observation marker');
      const path = workspaceFilePath(request.workspaces, target.workspaceIndex, target.path, true);
      observations.push(await observe({ path, hash: target.hash }));
    }
    // Recheck every object after all reads, including absent and metadata-only paths.
    for (const value of observations) {
      if (value.identity) need(sameIdentity(value.identity, await captureTreeIdentity(value.path)), 'Object changed during observation');
      else {
        try { await lstat(value.path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('[FILE_OBSERVATION] Path appeared before absence was accepted');
      }
    }
    reply.ok = true; reply.observations = observations;
  } catch (error) { reply.error = boundedReason(error instanceof Error ? error.message : String(error)); }
  const result = JSON.stringify(reply); need(Buffer.byteLength(result) <= FILE_RPC_REPLY_BYTES, 'Reply exceeds byte budget'); return result;
}
