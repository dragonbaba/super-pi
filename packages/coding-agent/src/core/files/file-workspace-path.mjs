import { resolve, relative, isAbsolute, sep } from 'node:path';
import { FILE_RESULT_PAYLOAD_BYTES } from './file-operation-limits.mjs';

const IDENTITY_FIELDS = new Set(['path', 'canonical', 'device', 'inode', 'size', 'mtime', 'ctime', 'mode', 'links', 'directory', 'symbolicLink']);
const IDENTITY_PATH_FIELDS = ['path', 'canonical'];
const IDENTITY_NUMBER_FIELDS = ['device', 'inode', 'size', 'mode', 'links'];
const UNSIGNED = /^[0-9]{1,32}$/, SIGNED = /^-?[0-9]{1,32}$/;
const WINDOWS_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$|[:]|[. ]$/i;
function need(value, message) { if (!value) throw new Error('[FILE_WORKSPACE_PATH] ' + message); }
export function containsWorkspacePath(root, candidate) {
  const part = relative(root, candidate);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
/** Internal paths are host assignments after public schema validation. Canonical
 * expansion has the metadata-record budget, rather than a second public cap. */
export function workspaceFilePath(roots, index, name, allowRoot = false) {
  need(Number.isSafeInteger(index) && index >= 0 && index < roots.length, 'Unknown host-assigned workspace identity');
  need(typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= FILE_RESULT_PAYLOAD_BYTES && !name.includes('\0'), 'Invalid assigned path');
  const root = roots[index], target = resolve(root, name), part = relative(root, target);
  need(containsWorkspacePath(root, target) && (allowRoot || part !== ''), 'Assigned path leaves its workspace or addresses a protected root');
  for (const component of part.split(sep)) {
    const protectedName = process.platform === 'win32' ? component.toLowerCase() : component;
    need(protectedName !== '.git' && protectedName !== '.sp', 'Protected .git/.sp path');
    if (process.platform === 'win32') need(!WINDOWS_COMPONENT.test(component), 'Ambiguous Windows path component');
  }
  return target;
}
export function validFileIdentity(value, allowLink = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== (value.symbolicLink === true ? 11 : 10)) return false;
  for (const key of keys) if (!IDENTITY_FIELDS.has(key)) return false;
  for (const key of IDENTITY_PATH_FIELDS) if (typeof value[key] !== 'string' || !isAbsolute(value[key])
    || value[key].includes('\0') || Buffer.byteLength(value[key]) > FILE_RESULT_PAYLOAD_BYTES) return false;
  for (const key of IDENTITY_NUMBER_FIELDS) if (typeof value[key] !== 'string' || !UNSIGNED.test(value[key])) return false;
  if (typeof value.mtime !== 'string' || !SIGNED.test(value.mtime) || typeof value.ctime !== 'string' || !SIGNED.test(value.ctime)
    || typeof value.directory !== 'boolean' || value.symbolicLink !== undefined && (!allowLink || value.symbolicLink !== true || value.directory)
    || !Number.isSafeInteger(Number(value.size)) || BigInt(value.links) < 1n) return false;
  return true;
}
