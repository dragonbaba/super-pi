// Exact controlled runtime dependencies. Build packaging and MXC creation consume the same list.
export const NATIVE_FILE_RUNTIME_ASSETS = Object.freeze([
  'native-file-worker.mjs', 'native-file-regex.mjs', 'file-operation-limits.mjs', 'file-tree-core.mjs',
  'file-manifest-artifact.mjs', 'mxc-file-publication.mjs', 'file-runtime-assets.mjs', 'file-creation-core.mjs', 'file-creation-core.d.mts',
  'file-worker-plan.mjs', 'file-worker-plan.d.mts', 'file-workspace-path.mjs', 'file-workspace-path.d.mts',
  'file-operation-limits.d.mts', 'file-tree-core.d.mts', 'file-manifest-artifact.d.mts',
  'mxc-file-publication.d.mts', 'file-runtime-assets.d.mts',
]);
export const MXC_FILE_RUNTIME_ASSETS = Object.freeze([
  Object.freeze(['./mxc-file-entry.mjs', 'core/sandbox/worker.mjs']),
  Object.freeze(['./mxc-file-worker.mjs', 'core/sandbox/mxc-file-worker.mjs']),
  Object.freeze(['./mxc-file-mutation-worker.mjs', 'core/sandbox/mxc-file-mutation-worker.mjs']),
  Object.freeze(['./mxc-file-observation-worker.mjs', 'core/sandbox/mxc-file-observation-worker.mjs']),
  Object.freeze(['./mxc-file-limits.mjs', 'core/sandbox/mxc-file-limits.mjs']),
  Object.freeze(['../../utils/image-signature.mjs', 'utils/image-signature.mjs']),
  Object.freeze(['../files/file-operation-limits.mjs', 'core/files/file-operation-limits.mjs']),
  Object.freeze(['../files/file-tree-core.mjs', 'core/files/file-tree-core.mjs']),
  Object.freeze(['../files/file-manifest-artifact.mjs', 'core/files/file-manifest-artifact.mjs']),
  Object.freeze(['../files/mxc-file-publication.mjs', 'core/files/mxc-file-publication.mjs']),
  Object.freeze(['../files/file-creation-core.mjs', 'core/files/file-creation-core.mjs']),
  Object.freeze(['../files/file-worker-plan.mjs', 'core/files/file-worker-plan.mjs']),
  Object.freeze(['../files/file-workspace-path.mjs', 'core/files/file-workspace-path.mjs']),
]);
export const MXC_FILE_WORKER_PATH = 'core/sandbox/worker.mjs';
