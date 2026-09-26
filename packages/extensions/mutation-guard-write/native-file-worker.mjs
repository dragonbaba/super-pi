// Private fixed-operation worker. Never load a library/symbol/type supplied by a tool request.
import { parentPort } from "node:worker_threads";
import { existsSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync, renameSync } from "node:fs";
import { join, toNamespacedPath } from "node:path";
import { createHash } from "node:crypto";
import koffi from "koffi";

const MAX_SECURITY_BYTES = 64 * 1024;
const MAX_ATTRIBUTE_NAMES = 64 * 1024;
let bindings;
let activeHandles = 0, calls = 0, publicationAttempts = 0;

function loadBindings() {
  if (bindings) return bindings;
  if (process.arch !== "x64") throw new Error("Native staged commits are only validated for x64.");
  if (process.platform === "win32") {
    // kernel32 is an already-loaded Windows KnownDLL (before filesystem search).
    // Derive all other paths from the OS, never cwd or mutable SystemRoot.
    const kernel = koffi.load("kernel32.dll");
    const getDirectory = kernel.func("uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)");
    const directoryBytes = Buffer.alloc(32768 * 2), directoryLength = getDirectory(directoryBytes, 32768);
    if (!directoryLength || directoryLength >= 32768) throw new Error("Cannot obtain the OS system directory.");
    const directory = realpathSync(directoryBytes.toString("utf16le", 0, directoryLength * 2));
    const security = koffi.load(join(directory, "advapi32.dll"));
    bindings = { kernel, security,
      lastError: kernel.func("uint32_t __stdcall GetLastError(void)"),
      fileInfo: kernel.func("int __stdcall GetFileInformationByHandle(void *handle, void *info)"),
      open: kernel.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)"),
      close: kernel.func("int __stdcall CloseHandle(void *handle)"),
      currentProcess: kernel.func("void * __stdcall GetCurrentProcess(void)"),
      openToken: security.func("int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)"),
      tokenInfo: security.func("int __stdcall GetTokenInformation(void *token, int informationClass, void *information, uint32_t size, void *needed)"),
      sidLength: security.func("uint32_t __stdcall GetLengthSid(void *sid)"),
      copySid: security.func("int __stdcall CopySid(uint32_t size, void *destination, void *source)"),
      setFileInfo: kernel.func("int __stdcall SetFileInformationByHandle(void *handle, int informationClass, void *information, uint32_t size)"),
      getSecurity: security.func("int __stdcall GetKernelObjectSecurity(void *handle, uint32_t information, void *descriptor, uint32_t size, void *needed)"),
      setSecurity: security.func("uint32_t __stdcall SetSecurityInfo(void *handle, int objectType, uint32_t information, void *owner, void *group, void *dacl, void *sacl)"),
      replace: kernel.func("int __stdcall ReplaceFileW(str16 target, str16 replacement, void *backup, uint32_t flags, void *exclude, void *reserved)"),
      volumePath: kernel.func("int __stdcall GetVolumePathNameW(str16 path, void *volume, uint32_t length)"),
      driveType: kernel.func("uint32_t __stdcall GetDriveTypeW(str16 root)"),
      volumeInfo: kernel.func("int __stdcall GetVolumeInformationW(str16 root, void *label, uint32_t labelSize, void *serial, void *maxComponent, void *flags, void *filesystem, uint32_t filesystemSize)"),
    };
  } else if (process.platform === "linux") {
    const candidates = ["/lib/x86_64-linux-gnu/libc.so.6", "/usr/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/usr/lib64/libc.so.6"];
    const path = candidates.find(existsSync);
    if (!path) throw new Error("No supported fixed glibc path; musl is not validated.");
    const library = koffi.load(realpathSync(path));
    // Supported Linux ABI is x86_64/glibc: ssize_t is signed pointer-width.
    // Koffi provides intptr_t; ssize_t is not a built-in typedef.
    bindings = { library, list: library.func("intptr_t flistxattr(int fd, void *names, size_t size)"),
      get: library.func("intptr_t fgetxattr(int fd, str name, void *value, size_t size)") };
  } else throw new Error("Native staged commits are only validated for Windows/Linux x64.");
  return bindings;
}

function winError(b, operation, outcome) {
  // Read immediately, synchronously, in the SAME worker thread as the failed API.
  const code = b.lastError();
  const error = new Error(`${operation} failed (Win32 ${code}).`);
  error.nativeCode = code;
  if (outcome) error.commitOutcome = code === 1176 || code === 1177 ? "unknown" : "not_committed";
  throw error;
}

function descriptorParts(bytes) {
  if (bytes.length < 20 || !(bytes.readUInt16LE(2) & 0x8000)) throw new Error("Unsupported security descriptor layout.");
  function part(field, acl) {
    const offset = bytes.readUInt32LE(field);
    if (!offset) return null;
    if (offset < 20 || offset + 8 > bytes.length) throw new Error("Invalid descriptor component.");
    const length = acl ? bytes.readUInt16LE(offset + 2) : 8 + bytes[offset + 1] * 4;
    if (length < 8 || offset + length > bytes.length) throw new Error("Descriptor component exceeds bound.");
    return bytes.subarray(offset, offset + length);
  }
  return { owner: part(4, false), group: part(8, false), dacl: part(16, true), protected: Boolean(bytes.readUInt16LE(2) & 0x1000) };
}

function securityDescriptor(b, handle) {
  const needed = Buffer.alloc(4);
  const ok = b.getSecurity(handle, 7, null, 0, needed);
  if (!ok && b.lastError() !== 122) winError(b, "GetKernelObjectSecurity(size)");
  const size = needed.readUInt32LE();
  if (size < 20 || size > MAX_SECURITY_BYTES) throw new Error("Security descriptor exceeds supported bound.");
  const bytes = Buffer.alloc(size);
  if (!b.getSecurity(handle, 7, bytes, size, needed)) winError(b, "GetKernelObjectSecurity");
  return bytes;
}

function securityFingerprint(bytes) {
  const parts = descriptorParts(bytes), hash = createHash("sha256"), frame = Buffer.alloc(4);
  // Owner/group defaulted; DACL present/defaulted, auto-inherit requested,
  // auto-inherited and protected. SELF_RELATIVE is a storage representation.
  frame.writeUInt32LE(bytes.readUInt16LE(2) & 0x150f); hash.update(frame);
  for (const value of [parts.owner, parts.group, parts.dacl]) { frame.writeInt32LE(value?.length ?? -1); hash.update(frame); if (value) hash.update(value); }
  return hash.digest("hex");
}

function assignableWindowsOwner(b, descriptor) {
  // Read-only TOKEN_QUERY of our own process, no privilege adjustment. Restrict
  // staged copies to the default owner/group a newly created file will have.
  const tokenBytes = Buffer.alloc(8);
  if (!b.openToken(b.currentProcess(), 8, tokenBytes)) winError(b, "OpenProcessToken");
  const token = tokenBytes.readBigUInt64LE(); activeHandles++;
  let value, failure;
  try {
    const parts = descriptorParts(descriptor), needed = Buffer.alloc(4), info = Buffer.alloc(MAX_SECURITY_BYTES);
    function tokenSid(kind) {
      if (!b.tokenInfo(token, kind, info, info.length, needed)) winError(b, "GetTokenInformation");
      if (needed.readUInt32LE() < 8 || needed.readUInt32LE() > info.length) throw new Error("Token SID exceeds supported bound.");
      const pointer = info.readBigUInt64LE(), size = b.sidLength(pointer);
      if (size < 8 || size > 68) throw new Error("Unsupported token SID size.");
      const sid = Buffer.alloc(size);
      if (!b.copySid(size, sid, pointer)) winError(b, "CopySid");
      return sid;
    }
    value = Boolean(parts.owner?.equals(tokenSid(4)) && parts.group?.equals(tokenSid(5)));
  } catch (error) { failure = error; }
  if (b.close(token)) activeHandles--;
  else { const code = b.lastError(); if (failure) failure.message += `; secondary CloseHandle(token) failure ${code}`; else failure = new Error(`CloseHandle(token) failed (Win32 ${code}).`); }
  if (failure) throw failure;
  return value;
}

function windowsObject(b, handle, expected) {
  const bytes = Buffer.alloc(52);
  if (!b.fileInfo(handle, bytes)) winError(b, "GetFileInformationByHandle");
  const device = String(bytes.readUInt32LE(28));
  const inode = String((BigInt(bytes.readUInt32LE(44)) << 32n) | BigInt(bytes.readUInt32LE(48)));
  const attributes = bytes.readUInt32LE(0), links = bytes.readUInt32LE(40);
  if (device !== expected.device || inode !== expected.inode || attributes & (0x10 | 0x400)) throw new Error("[STALE_STATE] Native handle is not the prepared regular file.");
  return { attributes, links, creationTime: bytes.subarray(4, 12).toString("hex") };
}

function withWindowsHandle(b, input, access, action) {
  const handle = b.open(toNamespacedPath(input.path), access, 7, null, 3, 0x00200000, null);
  if (handle === 0xffffffffffffffffn || handle === -1n) winError(b, "CreateFileW(metadata)");
  activeHandles++;
  let value, failure;
  try { windowsObject(b, handle, input.expected); value = action(handle); }
  catch (error) { failure = error; }
  const closed = b.close(handle);
  if (closed) activeHandles--;
  else {
    const code = b.lastError();
    if (failure) failure.message += `; secondary CloseHandle failure ${code}`;
    else failure = new Error(`CloseHandle(metadata) failed (Win32 ${code}).`);
  }
  if (failure) throw failure;
  return value;
}

function windowsFilesystem(b, path) {
  const volume = Buffer.alloc(32768 * 2);
  if (!b.volumePath(toNamespacedPath(path), volume, 32768)) winError(b, "GetVolumePathNameW");
  const root = volume.toString("utf16le").split("\0", 1)[0];
  if (b.driveType(root) !== 3) return "non-local";
  const name = Buffer.alloc(64);
  if (!b.volumeInfo(root, null, 0, null, null, null, name, 32)) winError(b, "GetVolumeInformationW");
  return name.toString("utf16le").split("\0", 1)[0];
}

function inspectWindows(b, input) {
  // A CRT descriptor belongs to its CRT instance. Open a Win32-owned handle;
  // never pass Node's descriptor to another CRT's _get_osfhandle.
  return withWindowsHandle(b, input, 0x00020080, handle => { // READ_CONTROL | FILE_READ_ATTRIBUTES
    const object = windowsObject(b, handle, input.expected), security = securityDescriptor(b, handle);
    return { ...object, security: security.toString("base64"), securityFingerprint: securityFingerprint(security), filesystem: windowsFilesystem(b, input.path),
      ownerAssignable: input.capability ? assignableWindowsOwner(b, security) : undefined };
  });
}

function prepareWindows(b, input) {
  return withWindowsHandle(b, input, 0x000e0000, handle => { // READ_CONTROL | WRITE_DAC | WRITE_OWNER
    if (typeof input.security !== "string" || input.security.length > MAX_SECURITY_BYTES * 2) throw new Error("Metadata payload exceeds bound.");
    const security = Buffer.from(input.security, "base64"), parts = descriptorParts(security);
    const flags = (7 | (parts.protected ? 0x80000000 : 0x20000000)) >>> 0;
    const code = b.setSecurity(handle, 1, flags, parts.owner, parts.group, parts.dacl, null);
    if (code) { const error = new Error(`SetSecurityInfo failed (Win32 ${code}).`); error.nativeCode = code; throw error; }
    if (securityFingerprint(securityDescriptor(b, handle)) !== securityFingerprint(security)) throw new Error("Temporary owner/group/DACL verification failed.");
  });
}

function protectWindows(b, input) {
  return withWindowsHandle(b, input, 0x00060000, handle => { // READ_CONTROL | WRITE_DAC
    const owner = descriptorParts(securityDescriptor(b, handle)).owner;
    if (!owner) throw new Error("Cannot establish temporary owner for private DACL.");
    // ACL_REVISION, one ACCESS_ALLOWED_ACE for the new file's owner only.
    const acl = Buffer.alloc(16 + owner.length);
    acl[0] = 2; acl.writeUInt16LE(acl.length, 2); acl.writeUInt16LE(1, 4);
    acl.writeUInt16LE(8 + owner.length, 10); acl.writeUInt32LE(0x001f01ff, 12); owner.copy(acl, 16);
    const code = b.setSecurity(handle, 1, 0x80000004, null, null, acl, null);
    if (code) throw new Error(`SetSecurityInfo(private temporary) failed (Win32 ${code}).`);
    const actual = descriptorParts(securityDescriptor(b, handle));
    if (!actual.protected || !actual.dacl?.equals(acl)) throw new Error("Private temporary DACL verification failed.");
  });
}

function inspectLinux(b, input) {
  const names = Buffer.alloc(MAX_ATTRIBUTE_NAMES);
  const length = Number(b.list(input.fd, names, names.length));
  if (length < 0) { const error = new Error(`flistxattr failed (errno ${koffi.errno()}); absence is not established.`); throw error; }
  if (length > names.length) throw new Error("Extended attribute names exceed bound.");
  // Nonempty visible attributes select compatibility. Read actual values to
  // detect kernel-cleared capabilities/ACL changes after an in-place write.
  const values = createHash("sha256"), frame = Buffer.alloc(8); let start = 0, total = 0, writeClearsAttributes = false, defaultAcl = false;
  while (start < length) {
    const end = names.indexOf(0, start);
    if (end < start || end >= length) throw new Error("Invalid extended-attribute name list.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(names.subarray(start, end));
    if (name === "security.capability") writeClearsAttributes = true;
    if (name === "system.posix_acl_default") defaultAcl = true;
    const size = Number(b.get(input.fd, name, null, 0));
    if (size < 0) throw new Error(`fgetxattr(size) failed (errno ${koffi.errno()}); metadata absence is not established.`);
    total += size;
    if (total > 256 * 1024) throw new Error("Extended-attribute values exceed the 256 KiB inspection bound.");
    const value = Buffer.alloc(size);
    if (Number(b.get(input.fd, name, value, value.length)) !== size) throw new Error(`fgetxattr(value) failed or changed (errno ${koffi.errno()}).`);
    frame.writeUInt32LE(end - start, 0); frame.writeUInt32LE(size, 4);
    values.update(frame); values.update(names.subarray(start, end)); values.update(value); start = end + 1;
  }
  return { hasAttributes: length !== 0, writeClearsAttributes, defaultAcl, namesFingerprint: createHash("sha256").update(names.subarray(0, length)).digest("hex"), valuesFingerprint: values.digest("hex") };
}

function verifyPath(expected, metadata) {
  const info = lstatSync(expected.path, { bigint: true });
  if (info.isSymbolicLink() || info.isDirectory() !== expected.directory
    || (!info.isFile() && !info.isDirectory()) || realpathSync.native(expected.path) !== expected.canonical
    || String(info.dev) !== expected.device || String(info.ino) !== expected.inode || String(info.mode) !== expected.mode
    || (metadata && (String(info.size) !== expected.size || String(info.mtimeNs) !== expected.mtime
      || String(info.ctimeNs) !== expected.ctime || String(info.nlink) !== expected.links))) throw new Error("[STALE_STATE] Publication path identity changed.");
}

function verifyBytes(b, input, path, expected, size, hash, staged) {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || String(info.dev) !== expected.device || String(info.ino) !== expected.inode || info.nlink !== 1n) throw new Error("[STALE_STATE] Publication object changed.");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Unsupported publication size.");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - position), position);
      if (!count) break;
      position += count; digest.update(buffer.subarray(0, count));
    }
    if (position !== size || digest.digest("hex") !== hash) throw new Error("[STALE_STATE] Publication content changed.");
    if (process.platform === "linux") {
      const current = fstatSync(fd, { bigint: true }), expectedMetadata = input.metadata;
      if (String(current.mode) !== expectedMetadata.mode || String(current.uid) !== expectedMetadata.uid || String(current.gid) !== expectedMetadata.gid) throw new Error("[STALE_STATE] Publication mode/owner changed.");
      const attributes = inspectLinux(b, { fd });
      if (attributes.namesFingerprint !== input.original.namesFingerprint || attributes.valuesFingerprint !== input.original.valuesFingerprint) throw new Error("[STALE_STATE] Publication extended attributes changed.");
    } else {
      const current = inspectWindows(b, { path, expected });
      if (current.securityFingerprint !== input.original.securityFingerprint || current.links !== 1
        || (staged ? current.attributes & ~(0x20 | 0x80) : current.attributes !== input.original.attributes || current.creationTime !== input.original.creationTime)) throw new Error("[STALE_STATE] Publication Windows metadata changed.");
    }
  } finally { closeSync(fd); }
}

function replaceVerified(b, input) {
  try {
    const v = input.validation;
    verifyPath(v.parent, false); verifyPath(v.target, true);
    // Recheck after worker dispatch, with no async user callback in this scope.
    // Pathname APIs still are NOT cross-process CAS or locks.
    verifyBytes(b, input, input.target, v.target, Number(v.target.size), v.previousSha256, false);
    const stage = lstatSync(input.temporary, { bigint: true });
    if (stage.isSymbolicLink()) throw new Error("[STALE_STATE] Staged path became a link.");
    verifyBytes(b, input, input.temporary, v.temporary, v.candidateBytes, v.candidateSha256, true);
    verifyPath(v.parent, false); verifyPath(v.target, true);
  } catch (error) { error.commitOutcome = "not_committed"; throw error; }
  publicationAttempts++;
  if (process.platform === "win32") {
    if (!b.replace(toNamespacedPath(input.target), toNamespacedPath(input.temporary), null, 0, null, null)) winError(b, "ReplaceFileW", true);
  } else {
    try { renameSync(input.temporary, input.target); }
    catch (error) { error.commitOutcome = "not_committed"; throw error; }
  }
  return { committed: true };
}

function verifyInPlace(input) {
  // Final bounded observation after all main-thread async reads/callbacks.
  // The owning FileHandle remains alive until this request settles. This is
  // still not an OS CAS: another process can race a following write syscall.
  verifyPath(input.parent, false); verifyPath(input.target, true);
  const info = fstatSync(input.fd, { bigint: true }), expected = input.target;
  if (!info.isFile() || String(info.dev) !== expected.device || String(info.ino) !== expected.inode) throw new Error("[STALE_STATE] In-place handle changed.");
  const size = Number(expected.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Unsupported in-place size.");
  const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position <= size) {
    const count = readSync(input.fd, bytes, 0, Math.min(bytes.length, size + 1 - position), position);
    if (!count) break;
    position += count; hash.update(bytes.subarray(0, count));
  }
  if (position !== size || hash.digest("hex") !== input.previousSha256) throw new Error("[STALE_STATE] In-place content changed.");
  verifyPath(input.parent, false); verifyPath(input.target, true);
}

function execute(input) {
  let b;
  try { b = loadBindings(); }
  catch (error) { error.nativeUnavailable = true; throw error; }
  calls++;
  if (input.operation === "inspect") return process.platform === "win32" ? inspectWindows(b, input) : inspectLinux(b, input);
  if (process.platform === "win32" && input.operation === "protect") return protectWindows(b, input);
  if (process.platform === "win32" && input.operation === "prepare") return prepareWindows(b, input);
  if (process.platform === "win32" && input.operation === "remove") {
    return withWindowsHandle(b, input, 0x00010080, handle => { // DELETE | FILE_READ_ATTRIBUTES
      const information = Buffer.alloc(4); information.writeUInt32LE(1);
      // FileDispositionInfo marks this verified handle, never a subsequently swapped pathname.
      if (!b.setFileInfo(handle, 4, information, 4)) winError(b, "SetFileInformationByHandle(disposition)");
      return { removed: true };
    });
  }
  if (input.operation === "replace") return replaceVerified(b, input);
  if (input.operation === "verify_in_place") return verifyInPlace(input);
  if (input.operation === "stats") return { calls, activeHandles, publicationAttempts, platform: process.platform, arch: process.arch };
  throw new Error("Unsupported private native file operation.");
}

parentPort.on("message", input => {
  const started = performance.now();
  try { parentPort.postMessage({ id: input.id, value: execute(input), milliseconds: performance.now() - started }); }
  catch (error) { parentPort.postMessage({ id: input.id, error: { message: String(error.message).slice(0, 1000), nativeCode: error.nativeCode, commitOutcome: error.commitOutcome, nativeUnavailable: error.nativeUnavailable }, milliseconds: performance.now() - started }); }
});
