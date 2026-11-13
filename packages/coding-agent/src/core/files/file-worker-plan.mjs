// Immutable, temporary MXC preparation inventories. The host uses only the
// manifest reader; source/destination filesystem observations run in the worker.
import { lstat } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { capturePathIdentity, captureTreeIdentity, sameIdentity, prepareTree, revalidateTree, hashIdentity } from './file-tree-core.mjs';
import { prepareFileCreation, verifyCreationAncestor, directoryKey } from './file-creation-core.mjs';
import { ManifestArtifactWriter, visitManifestArtifact, validateManifestArtifact } from './file-manifest-artifact.mjs';
import { workspaceFilePath, validFileIdentity } from './file-workspace-path.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const HEADER_FIELDS = new Set(['kind', 'ownerId', 'generation', 'callId', 'requestHash', 'index', 'itemCount', 'operation', 'inputHash', 'workspaceIndex', 'destinationWorkspaceIndex',
  'target', 'destination', 'source', 'sourceParent', 'destinationParent', 'destinationIdentity', 'recursive', 'overwrite', 'mode', 'moveStrategy', 'tree', 'text', 'creation']);
const TREE_FIELDS = new Set(['entries', 'files', 'directories', 'skippedLinks', 'bytes']);
const TEXT_FIELDS = new Set(['exists', 'target', 'identity', 'nextSha256', 'bytes', 'previousSha256', 'parent']);
const CREATION_FIELDS = new Set(['path', 'canonicalTarget', 'ancestor', 'directoryCount']);
const TREE_ROW_FIELDS = new Set(['kind', 'index', 'parent', 'identity']);
const DIRECTORY_ROW_FIELDS = new Set(['kind', 'index', 'path']);
function need(value, message) { if (!value) throw new Error('[FILE_WORKER_PLAN] ' + message); }
function fields(value, allowed) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Expected metadata object');
  for (const key of Object.keys(value)) need(allowed.has(key), 'Unexpected metadata field');
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function equalPath(a, b) { return directoryKey(a) === directoryKey(b); }
async function absent(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('[TARGET_APPEARED] Prepared destination or missing parent already exists');
}
function scopedIdentity(roots, index, identity, allowRoot, allowLink) {
  need(validFileIdentity(identity, allowLink), 'Invalid filesystem identity');
  workspaceFilePath(roots, index, identity.path, allowRoot);
  workspaceFilePath(roots, index, identity.canonical, allowRoot);
}

/** Visitor methods are reused for every row. No effects are permitted until the
 * complete file's fixed identity and SHA-256 have been accepted by the reader. */
export class FileWorkerManifest {
  constructor(request, item, index) {
    this.request = request; this.item = item; this.index = index; this.header = undefined;
    this.entries = []; this.directories = []; this.files = 0; this.directoryCount = 0; this.bytes = 0; this.linkFiles = 0;
  }
  onManifestRecord(record, row) {
    if (row === 0) { this.acceptHeader(record); return; }
    need(this.header, 'Manifest header is missing');
    if (record?.kind === 'tree') this.acceptTree(record);
    else if (record?.kind === 'directory') this.acceptDirectory(record);
    else throw new Error('[FILE_WORKER_PLAN] Unexpected inventory row');
  }
  acceptHeader(header) {
    fields(header, HEADER_FIELDS);
    const { request, item, index } = this;
    need(header.kind === 'file-plan-v3' && header.ownerId === request.id && header.generation === request.generation
      && header.callId === request.callId && header.requestHash === request.requestHash
      && header.index === index && header.itemCount === request.itemCount && header.operation === item.operation && header.inputHash === item.inputHash
      && header.workspaceIndex === item.workspaceIndex && header.destinationWorkspaceIndex === item.destinationWorkspaceIndex
      && header.recursive === item.recursive && header.overwrite === item.overwrite && header.mode === item.mode
      && typeof header.inputHash === 'string' && SHA256.test(header.inputHash), 'Manifest request, options or workspace binding changed');
    need(header.moveStrategy === (item.operation === 'move' ? 'copy_unlink_verified' : undefined), 'Invalid MXC move strategy');
    const allowRoot = item.operation === 'copy';
    const requested = workspaceFilePath(request.workspaces, item.workspaceIndex, item.path, allowRoot);
    need(typeof header.target === 'string', 'Missing canonical target');
    workspaceFilePath(request.workspaces, item.workspaceIndex, header.target, allowRoot);
    if (header.source) {
      scopedIdentity(request.workspaces, item.workspaceIndex, header.source, allowRoot, item.operation === 'delete');
      need(equalPath(header.source.path, requested) && equalPath(header.target, header.source.canonical), 'Source path does not match assigned target');
      need(validFileIdentity(header.sourceParent) && header.sourceParent.directory
        && equalPath(header.sourceParent.path, dirname(requested))
        && equalPath(header.sourceParent.canonical, dirname(header.source.canonical)), 'Source parent does not match its prepared object');
    }
    if (item.operation === 'copy' || item.operation === 'move') {
      const destination = workspaceFilePath(request.workspaces, item.destinationWorkspaceIndex, item.destination);
      need(typeof header.destination === 'string' && equalPath(header.destination, destination), 'Destination assignment changed');
      scopedIdentity(request.workspaces, item.destinationWorkspaceIndex, header.destinationParent, true, false);
      need(header.destinationParent.directory && equalPath(header.destinationParent.path, dirname(destination)), 'Invalid destination parent');
      if (header.destinationIdentity) {
        scopedIdentity(request.workspaces, item.destinationWorkspaceIndex, header.destinationIdentity, false, false);
        need(item.operation === 'copy' && item.overwrite === true && !header.source.directory && !header.destinationIdentity.directory
          && equalPath(header.destinationIdentity.path, destination), 'Invalid overwrite destination');
      }
    } else need(header.destination === undefined && header.destinationIdentity === undefined && header.destinationParent === undefined, 'Unexpected destination metadata');
    if (header.tree) {
      fields(header.tree, TREE_FIELDS);
      need(header.source && count(header.tree.entries) && header.tree.entries > 0 && count(header.tree.files) && count(header.tree.directories)
        && count(header.tree.bytes) && count(header.tree.skippedLinks), 'Invalid tree counters');
    }
    if (header.text) {
      fields(header.text, TEXT_FIELDS);
      need((item.operation === 'write' || item.operation === 'edit') && typeof header.text.exists === 'boolean'
        && typeof header.text.nextSha256 === 'string' && SHA256.test(header.text.nextSha256) && count(header.text.bytes)
        && equalPath(header.text.target, requested) && equalPath(header.target, requested), 'Invalid text preparation');
      if (header.text.exists) need(header.source && validFileIdentity(header.text.identity) && sameIdentity(header.source, header.text.identity)
        && validFileIdentity(header.text.parent) && sameIdentity(header.sourceParent, header.text.parent)
        && header.text.previousSha256 === item.snapshot && typeof item.snapshot === 'string' && SHA256.test(item.snapshot), 'Text preimage/snapshot changed');
      else need(item.operation === 'write' && item.snapshot === undefined && !header.source && header.creation, 'Invalid exclusive text creation');
    }
    if (header.creation) {
      fields(header.creation, CREATION_FIELDS);
      const creation = header.creation;
      scopedIdentity(request.workspaces, item.workspaceIndex, creation.ancestor, true, false);
      need(!header.source && header.text?.exists === false && creation.ancestor.directory && equalPath(creation.path, requested)
        && equalPath(creation.canonicalTarget, header.target) && count(creation.directoryCount), 'Invalid missing-parent preparation');
    }
    need(item.operation === 'write' || item.operation === 'edit' ? header.text && !header.tree : header.source && header.tree && !header.text, 'Missing operation inventory');
    this.header = header;
  }
  acceptTree(record) {
    fields(record, TREE_ROW_FIELDS);
    need(this.header.tree && record.index === this.entries.length && Number.isSafeInteger(record.parent)
      && (record.index === 0 ? record.parent === -1 : record.parent >= 0 && record.parent < record.index), 'Invalid tree order or parent');
    const identity = record.identity, header = this.header;
    scopedIdentity(this.request.workspaces, header.workspaceIndex, identity, header.operation === 'copy' && record.index === 0, header.operation === 'delete');
    if (record.index === 0) need(sameIdentity(identity, header.source) && identity.path === header.source.path, 'Tree root changed');
    else {
      const parent = this.entries[record.parent].identity;
      need(parent.directory && equalPath(dirname(identity.path), parent.path)
        && equalPath(identity.canonical, resolve(parent.canonical, basename(identity.path))), 'Tree child is outside its prepared parent');
    }
    if (identity.directory) this.directoryCount++;
    else if (record.index === 0 || !identity.symbolicLink) this.files++;
    else this.linkFiles++;
    if (!identity.directory && !identity.symbolicLink) this.bytes += Number(identity.size);
    need(count(this.bytes), 'Tree byte counters overflow');
    this.entries.push(Object.freeze({ parent: record.parent, identity: Object.freeze(identity) }));
  }
  acceptDirectory(record) {
    fields(record, DIRECTORY_ROW_FIELDS);
    const creation = this.header.creation;
    need(creation && record.index === this.directories.length && typeof record.path === 'string', 'Invalid creation directory order');
    workspaceFilePath(this.request.workspaces, this.header.workspaceIndex, record.path);
    const previous = this.directories.length ? this.directories[this.directories.length - 1] : creation.ancestor.path;
    need(equalPath(dirname(record.path), previous), 'Missing-parent chain changed'); this.directories.push(record.path);
  }
  finish() {
    const header = this.header;
    need(header && (header.tree ? this.entries.length === header.tree.entries && this.files === header.tree.files
      && this.directoryCount === header.tree.directories && this.bytes === header.tree.bytes : this.entries.length === 0), 'Tree inventory is incomplete');
    if (header.creation) need(this.directories.length === header.creation.directoryCount
      && equalPath(dirname(header.creation.path), this.directories.length ? this.directories[this.directories.length - 1] : header.creation.ancestor.path), 'Creation inventory is incomplete');
    else need(this.directories.length === 0, 'Unexpected creation inventory');
    for (const key of ['source', 'sourceParent', 'destinationParent', 'destinationIdentity', 'tree']) if (header[key]) Object.freeze(header[key]);
    if (header.text) {
      if (header.text.identity) Object.freeze(header.text.identity);
      if (header.text.parent) Object.freeze(header.text.parent);
      Object.freeze(header.text);
    }
    if (header.creation) { Object.freeze(header.creation.ancestor); Object.freeze(header.creation); }
    Object.freeze(header);
    return { header, tree: header.tree ? Object.freeze({ entries: Object.freeze(this.entries), files: this.files, directories: this.directoryCount,
      bytes: this.bytes, skippedLinks: header.tree.skippedLinks, unlinkFiles: this.files + this.linkFiles }) : undefined,
      creation: header.creation ? Object.freeze({ path: header.creation.path, canonicalTarget: header.creation.canonicalTarget,
        ancestor: Object.freeze(header.creation.ancestor), directories: Object.freeze(this.directories) }) : undefined };
  }
  dispose() { this.request = undefined; this.item = undefined; this.header = undefined; this.entries = []; this.directories = []; }
}

export async function readFileWorkerManifest(request, item, index, descriptor) {
  const name = request.id + '-' + index + '.manifest'; validateManifestArtifact(descriptor, name);
  const visitor = new FileWorkerManifest(request, item, index);
  try { await visitManifestArtifact(request.exchange, name, descriptor, visitor); return visitor.finish(); }
  finally { visitor.dispose(); }
}

export async function prepareFileWorkerManifest(request, item, index, owned, textPreparation) {
  need(owned?.name === request.id + '-' + index + '.manifest', 'Unexpected host-assigned manifest name');
  const rootIndex = item.workspaceIndex, target = workspaceFilePath(request.workspaces, rootIndex, item.path, item.operation === 'copy');
  const header = { kind: 'file-plan-v3', ownerId: request.id, generation: request.generation, callId: request.callId, requestHash: request.requestHash, index, itemCount: request.itemCount,
    operation: item.operation, inputHash: item.inputHash, workspaceIndex: rootIndex, destinationWorkspaceIndex: item.destinationWorkspaceIndex,
    target, recursive: item.recursive, overwrite: item.overwrite, mode: item.mode,
    moveStrategy: item.operation === 'move' ? 'copy_unlink_verified' : undefined };
  let tree, creation;
  if (item.operation === 'write' || item.operation === 'edit') {
    const text = header.text = textPreparation(request.workspaces[rootIndex], item.operation, item, request.maxWriteBytes);
    if (text.exists) {
      header.source = text.identity; header.sourceParent = await capturePathIdentity(dirname(target));
      text.previousSha256 = item.snapshot; text.parent = header.sourceParent;
    } else {
      creation = await prepareFileCreation(target, true, Infinity);
      header.creation = { path: creation.path, canonicalTarget: creation.canonicalTarget, ancestor: creation.ancestor, directoryCount: creation.directories.length };
      header.target = creation.canonicalTarget;
    }
  } else {
    need(item.operation === 'copy' || item.operation === 'delete' || item.operation === 'move', 'Invalid mutation operation');
    header.source = item.operation === 'delete' ? await captureTreeIdentity(target) : await capturePathIdentity(target);
    header.target = header.source.canonical; header.sourceParent = await capturePathIdentity(dirname(target));
    workspaceFilePath(request.workspaces, rootIndex, header.source.canonical, item.operation === 'copy');
    tree = await prepareTree(header.source, item.operation, item.recursive);
    header.tree = { entries: tree.entries.length, files: tree.files, directories: tree.directories, bytes: tree.bytes, skippedLinks: tree.skippedLinks };
    if (item.operation !== 'delete') {
      const destination = workspaceFilePath(request.workspaces, item.destinationWorkspaceIndex, item.destination);
      header.destinationParent = await capturePathIdentity(dirname(destination));
      need(header.destinationParent.directory, 'Destination parent is not a directory');
      header.destination = resolve(header.destinationParent.canonical, basename(destination));
      workspaceFilePath(request.workspaces, item.destinationWorkspaceIndex, header.destination);
      if (item.operation === 'copy' && item.overwrite === true && !header.source.directory) {
        try { header.destinationIdentity = await capturePathIdentity(destination); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await absent(destination); }
        need(!header.destinationIdentity?.directory, 'Directory overwrite/merge is unsupported');
      } else await absent(destination);
    }
  }
  const writer = await ManifestArtifactWriter.attach(request.exchange, owned);
  try {
    writer.append(header);
    if (tree) for (let entry = 0; entry < tree.entries.length; entry++) writer.append({ kind: 'tree', index: entry, parent: tree.entries[entry].parent, identity: tree.entries[entry].identity });
    if (creation) for (let entry = 0; entry < creation.directories.length; entry++) writer.append({ kind: 'directory', index: entry, path: creation.directories[entry] });
    const manifest = await writer.finish();
    return { index, manifest };
  } finally { await writer.dispose(); }
}

export async function revalidateFileWorkerManifest(request, item, prepared, preview = false, sharedDirectories) {
  const { header, tree, creation } = prepared;
  workspaceFilePath(request.workspaces, item.workspaceIndex, header.target, item.operation === 'copy');
  if (header.sourceParent) need(sameIdentity(header.sourceParent, await capturePathIdentity(header.sourceParent.path), false), 'Prepared source parent changed');
  if (header.source) need(sameIdentity(header.source, item.operation === 'delete' ? await captureTreeIdentity(header.source.path) : await capturePathIdentity(header.source.path)), 'Prepared source changed');
  if (header.destination) {
    workspaceFilePath(request.workspaces, item.destinationWorkspaceIndex, header.destination);
    need(sameIdentity(header.destinationParent, await capturePathIdentity(header.destinationParent.path), false), 'Prepared destination parent changed');
    if (header.destinationIdentity) need(sameIdentity(header.destinationIdentity, await capturePathIdentity(header.destination)), 'Prepared overwrite destination changed');
    else await absent(header.destination);
  }
  if (tree) await revalidateTree(tree);
  if (creation) {
    await verifyCreationAncestor(creation); await absent(creation.path);
    for (const path of creation.directories) {
      const shared = sharedDirectories?.get(directoryKey(path));
      if (shared) need(sameIdentity(shared, await capturePathIdentity(path), false), 'Shared created parent changed');
      else await absent(path);
    }
  }
  if (header.text?.exists) need(await hashIdentity(header.source) === header.text.previousSha256, 'Prepared text preimage changed');
  if (!preview && header.destinationIdentity) return { sourceSha256: await hashIdentity(header.source), previousSha256: await hashIdentity(header.destinationIdentity) };
  return {};
}

const PARENT_HEADER_FIELDS = new Set(['kind', 'ownerId', 'callId', 'generation', 'requestHash', 'index', 'target']);
const PARENT_ROW_FIELDS = new Set(['kind', 'directoryIndex', 'path', 'identity', 'status']);
function parentManifestName(request, index, kind) {
  return request.id + '-' + ((kind === 'shared' ? 2 : 1) * request.itemCount + index) + '.manifest';
}
/** Parent inventories keep deep/shared creation facts out of RPC envelopes.
 * They are temporary controls and never a second persistent result journal. */
export async function writeFileParentManifest(request, index, creation, owned, kind, values) {
  need((kind === 'shared' || kind === 'created') && owned.name === parentManifestName(request, index, kind), 'Unexpected parent artifact assignment');
  const writer = await ManifestArtifactWriter.attach(request.exchange, owned);
  try {
    writer.append({ kind: 'file-' + kind + '-parents-v3', ownerId: request.id, callId: request.callId, generation: request.generation,
      requestHash: request.requestHash, index, target: creation.canonicalTarget });
    if (kind === 'shared') {
      for (let directoryIndex = 0; directoryIndex < creation.directories.length; directoryIndex++) {
        const path = creation.directories[directoryIndex], identity = values.get(directoryKey(path));
        if (identity) writer.append({ kind: 'parent', directoryIndex, path, identity, status: 'created' });
      }
    } else {
      let directoryIndex = 0;
      for (const entry of values) {
        while (directoryIndex < creation.directories.length && !equalPath(creation.directories[directoryIndex], entry.path)) directoryIndex++;
        need(directoryIndex < creation.directories.length, 'Created parent is outside its immutable creation plan');
        writer.append({ kind: 'parent', directoryIndex, path: entry.path, identity: entry.identity, status: entry.status }); directoryIndex++;
      }
    }
    return await writer.finish();
  } finally { await writer.dispose(); }
}
class ParentManifestReader {
  constructor(request, index, creation, kind) {
    this.request = request; this.index = index; this.creation = creation; this.kind = kind; this.header = false; this.previous = -1;
    this.shared = new Map(); this.created = [];
  }
  onManifestRecord(record, row) {
    const request = this.request;
    if (row === 0) {
      fields(record, PARENT_HEADER_FIELDS);
      need(record.kind === 'file-' + this.kind + '-parents-v3' && record.ownerId === request.id && record.callId === request.callId
        && record.generation === request.generation && record.requestHash === request.requestHash && record.index === this.index
        && record.target === this.creation.canonicalTarget, 'Parent artifact belongs to another preparation'); this.header = true; return;
    }
    fields(record, PARENT_ROW_FIELDS);
    need(this.header && record.kind === 'parent' && Number.isSafeInteger(record.directoryIndex) && record.directoryIndex > this.previous
      && record.directoryIndex < this.creation.directories.length && equalPath(record.path, this.creation.directories[record.directoryIndex])
      && (record.status === 'created' || record.status === 'retained'), 'Invalid parent inventory order, path or state');
    if (record.identity) {
      need(validFileIdentity(record.identity) && record.identity.directory && equalPath(record.identity.path, record.path)
        && equalPath(record.identity.canonical, record.path), 'Invalid created/shared parent identity');
    }
    if (this.kind === 'shared') {
      need(record.status === 'created' && record.identity, 'Shared parent lacks its pinned identity');
      this.shared.set(directoryKey(record.path), Object.freeze(record.identity));
    } else this.created.push({ path: record.path, identity: record.identity && Object.freeze(record.identity), status: record.status });
    this.previous = record.directoryIndex;
  }
  take() { need(this.header, 'Missing parent artifact header'); const result = { shared: this.shared, created: this.created }; this.shared = undefined; this.created = undefined; return result; }
  dispose() { this.shared?.clear(); this.shared = undefined; this.created = undefined; this.request = undefined; this.creation = undefined; }
}
export async function readFileParentManifest(request, index, creation, kind, descriptor) {
  const name = parentManifestName(request, index, kind); validateManifestArtifact(descriptor, name);
  const visitor = new ParentManifestReader(request, index, creation, kind);
  try { await visitManifestArtifact(request.exchange, name, descriptor, visitor); return visitor.take(); }
  finally { visitor.dispose(); }
}
