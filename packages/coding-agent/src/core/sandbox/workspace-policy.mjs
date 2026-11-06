// Existing snapshot exclusions: VM commands may use these names, but they are never published.
const PRIVATE_NAMES = new Set(['.git', '.sp', '.artifacts', '.codegraph', 'node_modules']);
const PROTECTED_NAMES = new Set(['.git', '.sp', 'node_modules']);
const DEFAULT_PRIVATE_DIRECTORIES = Object.freeze(['target', '.venv', '__pycache__']);
const MAX_PRIVATE_DIRECTORIES = 64;

// Configuration boundary, once per backend/request, never per filesystem entry.
export function parseSandboxPrivateDirectories(value) {
  if (value === undefined || value === DEFAULT_PRIVATE_DIRECTORIES) return DEFAULT_PRIVATE_DIRECTORIES;
  if (!Array.isArray(value) || value.length > MAX_PRIVATE_DIRECTORIES) throw new Error('Invalid sandboxPrivateDirectories; expected at most 64 relative directory names or paths');
  const output = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.length || raw.length >= 4096 || raw.includes('\0') || raw.includes(':') || raw.includes('*') || raw.includes('?'))
      throw new Error('Invalid sandboxPrivateDirectories entry; use a relative directory name or path without wildcards');
    let name = raw.replaceAll('\\', '/').toLowerCase();
    if (name.startsWith('./')) name = name.slice(2);
    if (name.endsWith('/')) name = name.slice(0, -1);
    for (const part of name.split('/')) if (!part || part === '.' || part === '..')
      throw new Error('Invalid sandboxPrivateDirectories entry; absolute paths and parent traversal are not supported');
    output.push(name);
  }
  return Object.freeze(output);
}

function privateDirectoryMatches(relative, leaf, directories) {
  for (let index = 0; index < directories.length; index++) {
    const entry = directories[index];
    if (entry.includes('/') ? entry === relative : entry === leaf) return true;
  }
  return false;
}
export function isVmPrivateDirectory(name, directories = DEFAULT_PRIVATE_DIRECTORIES) {
  const normalized = name.replaceAll('\\', '/').toLowerCase();
  return privateDirectoryMatches(normalized, normalized.slice(normalized.lastIndexOf('/') + 1), directories);
}

export function isVmPrivateName(lowerName) { return PRIVATE_NAMES.has(lowerName); }
export function isProtectedWorkspaceName(lowerName) { return PROTECTED_NAMES.has(lowerName); }
export function isVmPrivatePath(name, directories = DEFAULT_PRIVATE_DIRECTORIES) {
  name = name.replaceAll('\\', '/').toLowerCase();
  let start = 0;
  for (let index = 0; index <= name.length; index++) {
    if (index === name.length || name[index] === '/') {
      const component = name.slice(start, index);
      if (isVmPrivateName(component) || index < name.length && privateDirectoryMatches(name.slice(0, index), component, directories)) return true;
      start = index + 1;
    }
  }
  return false;
}
