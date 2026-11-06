// Existing snapshot exclusions: VM commands may use these names, but they are never published.
const PRIVATE_NAMES = new Set(['.git', '.sp', '.artifacts', '.codegraph', 'node_modules']);
const PROTECTED_NAMES = new Set(['.git', '.sp', 'node_modules']);

export function isVmPrivateName(lowerName) { return PRIVATE_NAMES.has(lowerName); }
export function isProtectedWorkspaceName(lowerName) { return PROTECTED_NAMES.has(lowerName); }
export function isVmPrivatePath(name) {
  let start = 0;
  for (let index = 0; index <= name.length; index++) {
    if (index === name.length || name[index] === '/' || name[index] === '\\') {
      if (isVmPrivateName(name.slice(start, index).toLowerCase())) return true;
      start = index + 1;
    }
  }
  return false;
}
