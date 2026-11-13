// This module executes only in the controlled worker. Importing it has no effects.
import fs from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { capturePathIdentity, captureTreeIdentity, sameIdentity, executeTree, hashIdentity, boundedReason } from '../files/file-tree-core.mjs';
import { executeFileCreation, originalCreatedFileIdentity, FileCreationFailure, summarizeCreatedDirectories as creationSummary } from '../files/file-creation-core.mjs';
import { prepareFileWorkerManifest, readFileWorkerManifest, revalidateFileWorkerManifest, readFileParentManifest, writeFileParentManifest } from '../files/file-worker-plan.mjs';
import { workspaceFilePath } from '../files/file-workspace-path.mjs';
import { MxcFilePublication } from '../files/mxc-file-publication.mjs';
import { prepareTextMutation, executePreparedTextMutation } from './mxc-file-worker.mjs';
import { FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES, FILE_MUTATION_TEXT_BYTES } from '../files/file-operation-limits.mjs';

const OWNER_ID = /^[a-f0-9]{32}$/, SHA256 = /^[a-f0-9]{64}$/, ENTRY_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const REQUEST_FIELDS = new Set(['id', 'mode', 'workspaces', 'operation', 'exchange', 'maxWriteBytes', 'callId', 'requestHash', 'generation', 'workspaceIdentities', 'version', 'rpc', 'itemCount', 'start', 'items', 'phase', 'control']);
const CONTROL_FIELDS = new Set(['prepared', 'readyHash', 'intentId', 'preview']);
const PREPARED_FIELDS = new Set(['owned', 'manifest', 'validated', 'shared', 'effects']);
const BASE_FIELDS = ['operation', 'path', 'workspaceIndex', 'inputHash', 'purpose'];
const COPY_FIELDS = new Set([...BASE_FIELDS, 'destination', 'destinationWorkspaceIndex', 'overwrite']);
const MOVE_FIELDS = new Set([...BASE_FIELDS, 'destination', 'destinationWorkspaceIndex']);
const DELETE_FIELDS = new Set([...BASE_FIELDS, 'recursive']);
const WRITE_FIELDS = new Set([...BASE_FIELDS, 'mode', 'content', 'snapshot']);
const EDIT_FIELDS = new Set([...BASE_FIELDS, 'edits', 'snapshot']);
const EDIT_FIELDS_INNER = new Set(['oldText', 'newText', 'expectedLine']);
function need(value, message) { if (!value) throw new Error('[FILE_RPC_INVALID] ' + message); }
function fields(value, allowed) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Expected a protocol object');
  for (const key of Object.keys(value)) need(allowed.has(key), 'Unexpected protocol field');
}
function validateItem(request, item) {
  const allowed = item?.operation === 'copy' ? COPY_FIELDS : item?.operation === 'move' ? MOVE_FIELDS : item?.operation === 'delete' ? DELETE_FIELDS : item?.operation === 'write' ? WRITE_FIELDS : item?.operation === 'edit' ? EDIT_FIELDS : undefined;
  need(allowed, 'Invalid mutation operation'); fields(item, allowed);
  need(request.operation === 'file_batch' || request.operation === item.operation, 'Item does not belong to this public operation');
  need(typeof item.inputHash === 'string' && SHA256.test(item.inputHash), 'Missing original item hash');
  workspaceFilePath(request.workspaces, item.workspaceIndex, item.path, item.operation === 'copy');
  if (item.operation === 'copy' || item.operation === 'move') workspaceFilePath(request.workspaces, item.destinationWorkspaceIndex, item.destination);
  need(item.overwrite === undefined || typeof item.overwrite === 'boolean', 'Invalid overwrite flag');
  need(item.recursive === undefined || typeof item.recursive === 'boolean', 'Invalid recursive flag');
  need(item.mode === undefined || item.mode === 'create' || item.mode === 'overwrite', 'Invalid write mode');
  need(item.snapshot === undefined || typeof item.snapshot === 'string' && SHA256.test(item.snapshot), 'Invalid sandbox snapshot');
  need(item.purpose === undefined || typeof item.purpose === 'string' && item.purpose.length <= 800, 'Invalid purpose');
  if (item.operation === 'write') {
    need(typeof item.content === 'string', 'Missing write content'); return Buffer.byteLength(item.content);
  }
  if (item.operation === 'edit') {
    need(item.snapshot && Array.isArray(item.edits) && item.edits.length > 0 && item.edits.length <= 20, 'Invalid exact edit request');
    let bytes = 0;
    for (const edit of item.edits) {
      fields(edit, EDIT_FIELDS_INNER); need(typeof edit.oldText === 'string' && edit.oldText.length > 0 && typeof edit.newText === 'string', 'Invalid replacement text');
      if (edit.expectedLine !== undefined) need(Number.isSafeInteger(edit.expectedLine) && edit.expectedLine > 0, 'Invalid line hint');
      bytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
    }
    return bytes;
  }
  return 0;
}

export async function validateFileMutationEnvelope(request) {
  fields(request, REQUEST_FIELDS);
  need(request.version === 3 && request.rpc === 'file-mutation-v3' && typeof request.id === 'string' && OWNER_ID.test(request.id)
    && typeof request.callId === 'string' && request.callId.length > 0 && request.callId.length <= 256
    && typeof request.requestHash === 'string' && SHA256.test(request.requestHash)
    && Number.isSafeInteger(request.generation) && request.generation >= 0 && Number.isSafeInteger(request.itemCount) && request.itemCount > 0
    && Number.isSafeInteger(request.start) && request.start >= 0 && Array.isArray(request.items) && request.items.length > 0
    && request.start + request.items.length <= request.itemCount, 'Invalid call identity or global item range');
  need(request.mode === 'read-only' || request.mode === 'sandbox-write', 'Invalid sandbox mode');
  need(request.phase === 'prepare' || request.phase === 'validate' || request.phase === 'execute', 'Invalid mutation phase');
  need(request.maxWriteBytes === FILE_MUTATION_TEXT_BYTES, 'Mutation text budget differs from the host');
  need(Array.isArray(request.workspaces) && request.workspaces.length > 0 && request.workspaces.length <= 17
    && Array.isArray(request.workspaceIdentities) && request.workspaceIdentities.length === request.workspaces.length, 'Invalid authorized workspace table');
  for (let index = 0; index < request.workspaces.length; index++) {
    const root = await capturePathIdentity(request.workspaces[index]);
    need(root.directory && root.canonical === request.workspaces[index] && root.device + ':' + root.inode === request.workspaceIdentities[index], 'Authorized workspace identity changed');
  }
  const exchange = await capturePathIdentity(request.exchange); need(exchange.directory && exchange.canonical === request.exchange, 'Exchange directory changed');
  fields(request.control, CONTROL_FIELDS);
  need(Array.isArray(request.control.prepared) && request.control.prepared.length === request.items.length, 'Missing complete manifest control table');
  let bytes = 0;
  for (let offset = 0; offset < request.items.length; offset++) {
    bytes += validateItem(request, request.items[offset]); fields(request.control.prepared[offset], PREPARED_FIELDS);
    need(bytes <= FILE_MUTATION_TEXT_BYTES, 'Subrequest mutation text exceeds the whole-call budget');
  }
  if (request.phase === 'execute') need(request.mode === 'sandbox-write' && request.items.length === 1
    && typeof request.control.readyHash === 'string' && SHA256.test(request.control.readyHash)
    && typeof request.control.intentId === 'string' && ENTRY_ID.test(request.control.intentId), 'An effect requires exactly one current ready/intent binding');
}

class WorkerItemExecution {
  constructor(request, item, index, control) {
    this.request = request; this.item = item; this.index = index; this.control = control;
    this.publication = undefined; this.effectsPossible = false; this.prepared = undefined; this.shared = undefined;
    this.controlAccepted = false;
  }
  current = () => {};
  assertCreationPath = async () => this.prepared.creation.canonicalTarget;
  async run() {
    const { request, item, index, control } = this;
    let receipt, creationResult, createdParents;
    try {
      const prepared = this.prepared = await readFileWorkerManifest(request, item, index, control.manifest);
      const header = prepared.header;
      if (control.shared) {
        need(prepared.creation, 'Only exclusive text creation may carry shared parents');
        this.shared = (await readFileParentManifest(request, index, prepared.creation, 'shared', control.shared)).shared;
      }
      this.controlAccepted = true;
      const verified = await revalidateFileWorkerManifest(request, item, prepared, false, this.shared);
      if (header.destinationIdentity) need(control.validated && control.validated.sourceSha256 === verified.sourceSha256
        && control.validated.previousSha256 === verified.previousSha256, 'Copy content no longer matches the globally validated preimages');
      if (prepared.creation) {
        if (prepared.creation.directories.length) need(control.effects, 'Missing preassigned created-parent output');
        need(typeof item.content === 'string' && createHash('sha256').update(item.content).digest('hex') === header.text.nextSha256, 'Prepared creation content changed');
        this.effectsPossible = true;
        creationResult = await executeFileCreation(prepared.creation, item.content, this.assertCreationPath, undefined, undefined, this.shared, this.current, true);
        createdParents = creationResult.createdDirectories;
        const original = originalCreatedFileIdentity(creationResult), observed = await capturePathIdentity(prepared.creation.path);
        need(original && observed.device === original.device && observed.inode === original.inode
          && await hashIdentity(observed) === header.text.nextSha256, 'Created file changed before accepting its continuation');
        receipt = { status: 'succeeded', stateChanged: true, created: true, category: 'success', sha256: header.text.nextSha256,
          snapshot: header.text.nextSha256, bytes: header.text.bytes };
      } else if (header.text) {
        this.effectsPossible = true;
        receipt = executePreparedTextMutation(request.workspaces[item.workspaceIndex], item.operation, item, request.maxWriteBytes, header.text);
        if (receipt.status === 'succeeded') { receipt.sha256 = receipt.snapshot; receipt.previousSha256 = header.text.previousSha256; receipt.category = 'success'; }
      } else if (header.destinationIdentity) {
        this.effectsPossible = true;
        const fd = fs.openSync(header.destination, 'r');
        this.publication = new MxcFilePublication(header.destination, fd, fs.fstatSync(fd, { bigint: true }), control.validated.previousSha256, header.destinationParent);
        const sha256 = await this.publication.commitCopy(header.source, control.validated.sourceSha256, this.current);
        receipt = { status: 'succeeded', stateChanged: true, sha256, previousSha256: control.validated.previousSha256, bytes: Number(header.source.size), files: 1, directories: 0,
          skippedLinks: 0, coverageComplete: true, commit: { strategy: 'staged_replace', outcome: 'committed', fileSynced: true, directorySynced: false } };
      } else {
        // MXC rejects hardlink creation even within one writable mount. Select
        // the already verified copy/unlink strategy before the first effect;
        // never retry a failed or possibly completed publication.
        this.effectsPossible = true;
        receipt = await executeTree(prepared.tree, item.operation, header.sourceParent, header.destination, header.destinationParent, this.current, undefined, true);
      }
    } catch (error) {
      if (error instanceof FileCreationFailure) {
        const facts = error.facts; createdParents = facts.createdDirectories;
        receipt = { status: facts.status, stateChanged: facts.stateChanged, requiresVerification: facts.requiresVerification, reason: boundedReason(String(facts.cause)) };
      } else if (this.publication) {
        const publication = this.publication;
        receipt = { status: publication.outcome === 'unknown' ? 'state_unknown' : publication.outcome === 'committed' ? 'partial' : 'failed_no_change',
          stateChanged: publication.outcome === 'unknown' ? 'unknown' : publication.outcome === 'committed', requiresVerification: publication.requiresVerification || publication.retainedTemporary !== undefined,
          commit: { strategy: 'staged_replace', outcome: publication.outcome, fileSynced: publication.outcome === 'committed', directorySynced: false, retainedTemporary: publication.retainedTemporary },
          reason: boundedReason(String(error.message)) };
      } else receipt = { status: this.effectsPossible ? 'state_unknown' : 'failed_no_change', stateChanged: this.effectsPossible ? 'unknown' : false,
        requiresVerification: this.effectsPossible || undefined, stopInvocation: !this.controlAccepted || undefined, reason: boundedReason(String(error.message)) };
    }
    try {
      if (this.publication) {
        this.publication.dispose();
        if (receipt.commit) receipt.commit.retainedTemporary = this.publication.retainedTemporary;
        receipt.requiresVerification ||= this.publication.requiresVerification;
      }
      if (createdParents && control.effects) {
        receipt.createdParents = await writeFileParentManifest(request, index, this.prepared.creation, control.effects, 'created', createdParents);
        receipt.creation = creationSummary(creationResult ?? { bytes: 0 }, createdParents);
        if (receipt.creation.createdDirectoriesOmitted) receipt.coverageComplete = false;
      } else if (creationResult) receipt.creation = creationSummary(creationResult, createdParents);
      const header = this.prepared?.header;
      return { ...receipt, mutationReceiptVersion: 3, operation: item.operation, target: header?.target ?? workspaceFilePath(request.workspaces, item.workspaceIndex, item.path, item.operation === 'copy'),
        destination: header?.destination, ok: receipt.status === 'succeeded' };
    } catch (error) {
      const publication = this.publication, changed = publication ? publication.outcome === 'unknown' ? 'unknown' : publication.outcome === 'committed' : 'unknown';
      return { mutationReceiptVersion: 3, operation: item.operation, target: this.prepared.header.target, destination: this.prepared.header.destination,
        ok: false, status: changed === 'unknown' ? 'state_unknown' : changed ? 'partial' : 'failed_no_change', stateChanged: changed, requiresVerification: true,
        stopInvocation: true, reason: boundedReason(String(error.message)), commit: publication ? { strategy: 'staged_replace', outcome: publication.outcome,
          fileSynced: publication.outcome === 'committed', directorySynced: false, retainedTemporary: publication.retainedTemporary,
          cleanupReason: boundedReason(String(error.message)) } : undefined };
    } finally {
      this.publication?.dispose(); this.publication = undefined; this.shared?.clear(); this.shared = undefined;
      this.prepared = undefined; this.request = undefined; this.item = undefined; this.control = undefined;
    }
  }
}

/** Caller sends this exact serialized response and meters its UTF-8 bytes once. */
export async function runFileMutationRequest(request, serializedRequest) {
  need(typeof serializedRequest === 'string' && Buffer.byteLength(serializedRequest) <= FILE_RPC_REQUEST_BYTES, 'Request exceeds its actual byte budget');
  const wireHash = createHash('sha256').update(serializedRequest).digest('hex');
  const reply = { version: 3, rpc: 'file-mutation-v3', id: request?.id, callId: request?.callId, requestHash: request?.requestHash,
    generation: request?.generation, itemCount: request?.itemCount, start: request?.start, phase: request?.phase, wireHash, ok: false, items: [] };
  try {
    await validateFileMutationEnvelope(request);
    for (let offset = 0; offset < request.items.length; offset++) {
      const item = request.items[offset], index = request.start + offset, control = request.control.prepared[offset];
      if (request.phase === 'prepare') reply.items.push(await prepareFileWorkerManifest(request, item, index, control.owned, prepareTextMutation));
      else if (request.phase === 'validate') {
        const prepared = await readFileWorkerManifest(request, item, index, control.manifest);
        reply.items.push({ index, validated: await revalidateFileWorkerManifest(request, item, prepared, request.control.preview === true) });
      } else reply.items.push({ index, readyHash: request.control.readyHash, intentId: request.control.intentId,
        receipt: await new WorkerItemExecution(request, item, index, control).run() });
    }
    reply.ok = true;
  } catch (error) { reply.error = boundedReason(error instanceof Error ? error.message : String(error)); reply.noEffects = request?.phase !== 'execute'; }
  const serialized = JSON.stringify(reply);
  if (Buffer.byteLength(serialized) <= FILE_RPC_REPLY_BYTES) return serialized;
  const failure = JSON.stringify({ version: 3, rpc: 'file-mutation-v3', id: typeof request?.id === 'string' && OWNER_ID.test(request.id) ? request.id : undefined,
    callId: typeof request?.callId === 'string' && request.callId.length <= 256 ? request.callId : undefined,
    requestHash: request?.requestHash, generation: request?.generation, itemCount: request?.itemCount, start: request?.start,
    phase: request?.phase, wireHash, ok: false, noEffects: request?.phase !== 'execute', error: 'Reply exceeds its actual byte budget; inspect before retrying any possible effect' });
  need(Buffer.byteLength(failure) <= FILE_RPC_REPLY_BYTES, 'Invalid request identity cannot form a bounded failure reply'); return failure;
}
