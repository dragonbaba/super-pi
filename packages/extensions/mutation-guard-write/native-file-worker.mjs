// Private fixed-operation worker. Never load a library/symbol/type supplied by a tool request.
import { parentPort } from "node:worker_threads";
import { existsSync, realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync, renameSync, fchmodSync, fchownSync, fsyncSync } from "node:fs";
import { dirname, join, toNamespacedPath } from "node:path";
import { createHash } from "node:crypto";
import koffi from "koffi";
import { LINUX_MOUNT_ID_PATTERN } from "./native-file-regex.mjs";

const MAX_SECURITY_BYTES = 64 * 1024;
const MAX_ATTRIBUTE_NAMES = 64 * 1024;
const CAPABILITY_ATTRIBUTE_NAME = Buffer.from("security.capability\0");
const IMA_ATTRIBUTE_NAME = Buffer.from("security.ima\0");
const EVM_ATTRIBUTE_NAME = Buffer.from("security.evm\0");
const DEFAULT_ACL_ATTRIBUTE_NAME = Buffer.from("system.posix_acl_default\0");
let bindings;
let activeHandles = 0, activeDescriptors = 0, calls = 0, publicationAttempts = 0;

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
    koffi.struct("SP_FILE_SECURITY_ATTRIBUTES", { length: "uint32_t", descriptor: "void *", inherit: "int32_t" });
    bindings = { kernel, security,
      lastError: kernel.func("uint32_t __stdcall GetLastError(void)"),
      fileInfo: kernel.func("int __stdcall GetFileInformationByHandle(void *handle, void *info)"),
      open: kernel.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t sharing, SP_FILE_SECURITY_ATTRIBUTES *security, uint32_t disposition, uint32_t flags, void *templateFile)"),
      close: kernel.func("int __stdcall CloseHandle(void *handle)"),
      currentProcess: kernel.func("void * __stdcall GetCurrentProcess(void)"),
      openToken: security.func("int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)"),
      tokenInfo: security.func("int __stdcall GetTokenInformation(void *token, int informationClass, void *information, uint32_t size, void *needed)"),
      sidLength: security.func("uint32_t __stdcall GetLengthSid(void *sid)"),
      copySid: security.func("int __stdcall CopySid(uint32_t size, void *destination, void *source)"),
      setFileInfo: kernel.func("int __stdcall SetFileInformationByHandle(void *handle, int informationClass, void *information, uint32_t size)"),
      getSecurity: security.func("int __stdcall GetKernelObjectSecurity(void *handle, uint32_t information, void *descriptor, uint32_t size, void *needed)"),
      setSecurity: security.func("uint32_t __stdcall SetSecurityInfo(void *handle, int objectType, uint32_t information, void *owner, void *group, void *dacl, void *sacl)"),
      inheritSecurity: security.func("int __stdcall CreatePrivateObjectSecurityEx(void *parent, void *creator, void *result, void *objectType, int container, uint32_t flags, void *token, void *mapping)"),
      readPrivateSecurity: security.func("int __stdcall GetPrivateObjectSecurity(void *descriptor, uint32_t information, void *result, uint32_t size, void *needed)"),
      destroyPrivateSecurity: security.func("int __stdcall DestroyPrivateObjectSecurity(void *descriptor)"),
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
      get: library.func("intptr_t fgetxattr(int fd, const void *name, void *value, size_t size)"),
      ioctl: library.func("int ioctl(int fd, unsigned long request, ...)") };
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

function descriptorPart(bytes, field, acl) {
    const offset = bytes.readUInt32LE(field);
    if (!offset) return null;
    if (offset < 20 || offset + 8 > bytes.length) throw new Error("Invalid descriptor component.");
    const length = acl ? bytes.readUInt16LE(offset + 2) : 8 + bytes[offset + 1] * 4;
    if (length < 8 || offset + length > bytes.length) throw new Error("Descriptor component exceeds bound.");
    return bytes.subarray(offset, offset + length);
}

function descriptorParts(bytes) {
  if (bytes.length < 20 || !(bytes.readUInt16LE(2) & 0x8000)) throw new Error("Unsupported security descriptor layout.");
  return { owner: descriptorPart(bytes, 4, false), group: descriptorPart(bytes, 8, false), dacl: descriptorPart(bytes, 16, true), protected: Boolean(bytes.readUInt16LE(2) & 0x1000) };
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
    value = Boolean(parts.owner?.equals(tokenSid(b, token, info, needed, 4)) && parts.group?.equals(tokenSid(b, token, info, needed, 5)));
  } catch (error) { failure = error; }
  if (b.close(token)) activeHandles--;
  else { const code = b.lastError(); if (failure) failure.message += `; secondary CloseHandle(token) failure ${code}`; else failure = new Error(`CloseHandle(token) failed (Win32 ${code}).`); }
  if (failure) throw failure;
  return value;
}

function tokenSid(b, token, info, needed, kind) {
  if (!b.tokenInfo(token, kind, info, info.length, needed)) winError(b, "GetTokenInformation");
  if (needed.readUInt32LE() < 8 || needed.readUInt32LE() > info.length) throw new Error("Token SID exceeds supported bound.");
  const pointer = info.readBigUInt64LE(), size = b.sidLength(pointer);
  if (size < 8 || size > 68) throw new Error("Unsupported token SID size.");
  const sid = Buffer.alloc(size);
  if (!b.copySid(size, sid, pointer)) winError(b, "CopySid");
  return sid;
}

function reproduceWindowsInheritance(b, input, handle) {
  const parent = securityDescriptor(b, handle), creator = Buffer.from(input.security, "base64");
  const tokenBytes = Buffer.alloc(8), result = Buffer.alloc(8), mapping = Buffer.alloc(16);
  // FILE_GENERIC_READ, WRITE, EXECUTE and ALL_ACCESS. The API computes
  // inheritance in memory; no candidate file or privilege override is involved.
  mapping.writeUInt32LE(0x120089, 0); mapping.writeUInt32LE(0x120116, 4);
  mapping.writeUInt32LE(0x1200a0, 8); mapping.writeUInt32LE(0x1f01ff, 12);
  if (!b.openToken(b.currentProcess(), 8, tokenBytes)) winError(b, "OpenProcessToken(inheritance)");
  const token = tokenBytes.readBigUInt64LE(); activeHandles++;
  let allocated = false, value, failure;
  try {
    // SEF_DACL_AUTO_INHERIT only: retain owner and privilege checks.
    if (!b.inheritSecurity(parent, creator, result, null, 0, 1, token, mapping)) winError(b, "CreatePrivateObjectSecurityEx");
    allocated = true; activeDescriptors++;
    const pointer = result.readBigUInt64LE(), needed = Buffer.alloc(4);
    if (!b.readPrivateSecurity(pointer, 7, null, 0, needed) && b.lastError() !== 122) winError(b, "GetPrivateObjectSecurity(size)");
    const length = needed.readUInt32LE();
    if (length < 20 || length > MAX_SECURITY_BYTES) throw new Error("Inherited security descriptor exceeds bound.");
    const bytes = Buffer.alloc(length);
    if (!b.readPrivateSecurity(pointer, 7, bytes, bytes.length, needed)) winError(b, "GetPrivateObjectSecurity");
    value = securityFingerprint(bytes) === securityFingerprint(creator);
  } catch (error) { failure = error; }
  if (allocated) {
    if (b.destroyPrivateSecurity(result)) activeDescriptors--;
    else { const code = b.lastError(); failure ??= new Error(`DestroyPrivateObjectSecurity failed (Win32 ${code}).`); }
  }
  if (b.close(token)) activeHandles--;
  else { const code = b.lastError(); failure ??= new Error(`CloseHandle(inheritance token) failed (Win32 ${code}).`); }
  if (failure) throw failure;
  return value;
}

function windowsObject(b, handle, expected, directory = false) {
  const bytes = Buffer.alloc(52);
  if (!b.fileInfo(handle, bytes)) winError(b, "GetFileInformationByHandle");
  const device = String(bytes.readUInt32LE(28));
  const inode = String((BigInt(bytes.readUInt32LE(44)) << 32n) | BigInt(bytes.readUInt32LE(48)));
  const attributes = bytes.readUInt32LE(0), links = bytes.readUInt32LE(40);
  if (expected && (device !== expected.device || inode !== expected.inode) || attributes & 0x400 || Boolean(attributes & 0x10) !== directory) throw new Error("[STALE_STATE] Native handle is not the prepared file/directory object.");
  return { device, inode, attributes, links, creationTime: bytes.subarray(4, 12).toString("hex") };
}

function privateWindowsAcl(user) {
  // ACL_REVISION, one ACCESS_ALLOWED_ACE for the process user only.
  const acl = Buffer.alloc(16 + user.length);
  acl[0] = 2; acl.writeUInt16LE(acl.length, 2); acl.writeUInt16LE(1, 4);
  acl.writeUInt16LE(8 + user.length, 10); acl.writeUInt32LE(0x001f01ff, 12); user.copy(acl, 16);
  return acl;
}

function createPrivateWindows(b, input) {
  const tokenBytes = Buffer.alloc(8);
  if (!b.openToken(b.currentProcess(), 8, tokenBytes)) winError(b, "OpenProcessToken(create)");
  const token = tokenBytes.readBigUInt64LE(); activeHandles++;
  let user, failure;
  try { user = tokenSid(b, token, Buffer.alloc(MAX_SECURITY_BYTES), Buffer.alloc(4), 1); }
  catch (error) { failure = error; }
  if (b.close(token)) activeHandles--;
  else { const code = b.lastError(); failure ??= new Error(`CloseHandle(create token) failed (Win32 ${code}).`); }
  if (failure) throw failure;
  const acl = privateWindowsAcl(user), descriptor = Buffer.alloc(20 + acl.length);
  descriptor[0] = 1; descriptor.writeUInt16LE(0x9004, 2); // SELF_RELATIVE | DACL_PROTECTED | DACL_PRESENT
  descriptor.writeUInt32LE(20, 16); acl.copy(descriptor, 20);
  // Fixed x64 SECURITY_ATTRIBUTES: sizeof=24, pointer aligned at 8. Koffi
  // retains descriptor/argument buffers for this synchronous worker call.
  const security = { length: 24, descriptor, inherit: 0 };
  const handle = b.open(toNamespacedPath(input.path), 0xc0010000, 0, security, 1, 0x80, null); // CREATE_NEW, no inherited handle
  if (handle === 0xffffffffffffffffn || handle === -1n) winError(b, "CreateFileW(private candidate)");
  activeHandles++;
  const result = { created: true };
  try {
    const object = windowsObject(b, handle);
    result.device = object.device; result.inode = object.inode;
    const actual = descriptorParts(securityDescriptor(b, handle));
    if (!actual.protected || !actual.dacl?.equals(acl)) throw new Error("Creation-time private DACL verification failed.");
  } catch (error) { result.failure = String(error.message).slice(0, 400); }
  if (b.close(handle)) activeHandles--;
  else { const code = b.lastError(); result.failure = `${result.failure ?? ""}; CloseHandle(private candidate) failed (Win32 ${code}).`; }
  // Once CREATE_NEW succeeds, keep the creation fact even if inspection/close
  // fails. Main-thread cleanup must not mistake this for zero side effects.
  return result;
}

function withWindowsHandle(b, input, access, action, directory = false) {
  const handle = b.open(toNamespacedPath(input.path), access, 7, null, 3, directory ? 0x02200000 : 0x00200000, null);
  if (handle === 0xffffffffffffffffn || handle === -1n) winError(b, "CreateFileW(metadata)");
  activeHandles++;
  let value, failure;
  try { windowsObject(b, handle, input.expected, directory); value = action(b, input, handle); }
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
  // fs.access(W_OK) ignores Windows ACLs. Capability selection must obtain
  // FILE_WRITE_DATA on the prepared object before creating any candidate.
  const observed = withWindowsHandle(b, input, input.capability ? 0x00020082 : 0x00020080, inspectWindowsHandle);
  if (input.capability) {
    // ReplaceFileW also opens the candidate with GENERIC_WRITE. It receives the
    // target DACL, so probe the full union on that DACL before creation. Only an
    // explicit access denial selects compatibility; other failures propagate.
    try { withWindowsHandle(b, input, 0xc0110000, observeWindowsReplacementAccess); observed.replacementAccess = true; }
    catch (error) { if (error.nativeCode !== 5) throw error; observed.replacementAccess = false; }
    // FILE_ADD_FILE on the already existing canonical parent, without creating
    // a probe file. Directory handles require BACKUP_SEMANTICS; no token
    // privilege is enabled or adjusted. Other failures do not select fallback.
    const path = dirname(input.path), info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("[STALE_STATE] Candidate parent is not an ordinary directory.");
    const parent = { path, expected: { device: String(info.dev), inode: String(info.ino) } };
    try { withWindowsHandle(b, parent, 2, observeWindowsReplacementAccess, true); observed.parentCreationAccess = true; }
    catch (error) { if (error.nativeCode !== 5) throw error; observed.parentCreationAccess = false; }
    const control = Buffer.from(observed.security, "base64").readUInt16LE(2);
    observed.inheritanceReproducible = Boolean(control & 0x1000);
    if (!(control & 0x1000) && control & 0x400 && observed.ownerAssignable) {
      parent.security = observed.security;
      try { observed.inheritanceReproducible = withWindowsHandle(b, parent, 0x20080, reproduceWindowsInheritance, true); }
      catch (error) { if (error.nativeCode !== 5) throw error; observed.inheritanceReproducible = false; }
    }
  }
  return observed;
}
function observeWindowsReplacementAccess() { return true; }
function inspectWindowsHandle(b, input, handle) {
    const object = windowsObject(b, handle, input.expected), security = securityDescriptor(b, handle);
    return { ...object, security: security.toString("base64"), securityFingerprint: securityFingerprint(security), filesystem: windowsFilesystem(b, input.path),
      ownerAssignable: input.capability ? assignableWindowsOwner(b, security) : undefined };
}

function prepareWindows(b, input) {
  return withWindowsHandle(b, input, 0x000e0100, prepareWindowsHandle); // READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_WRITE_ATTRIBUTES
}
function prepareWindowsHandle(b, input, handle) {
    if (typeof input.security !== "string" || input.security.length > MAX_SECURITY_BYTES * 2) throw new Error("Metadata payload exceeds bound.");
    const security = Buffer.from(input.security, "base64"), parts = descriptorParts(security);
    const flags = (7 | (parts.protected ? 0x80000000 : 0x20000000)) >>> 0;
    const code = b.setSecurity(handle, 1, flags, parts.owner, parts.group, parts.dacl, null);
    if (code) { const error = new Error(`SetSecurityInfo failed (Win32 ${code}).`); error.nativeCode = code; throw error; }
    if (securityFingerprint(securityDescriptor(b, handle)) !== securityFingerprint(security)) throw new Error("Temporary owner/group/DACL verification failed.");
    setWindowsAttributes(b, input, handle);
}
function setWindowsAttributes(b, input, handle) {
    if (input.attributes !== 0x20 && input.attributes !== 0x80) throw new Error("Unsupported replacement attributes.");
    // FILE_BASIC_INFO x64: four 64-bit timestamps (zero = unchanged), DWORD
    // attributes at byte 32, eight-byte struct alignment. Set after all writes.
    const basic = Buffer.alloc(40); basic.writeUInt32LE(input.attributes, 32);
    if (!b.setFileInfo(handle, 0, basic, basic.length)) winError(b, "SetFileInformationByHandle(attributes)");
    if (windowsObject(b, handle, input.expected).attributes !== input.attributes) throw new Error("Temporary attributes verification failed.");
}

function protectWindows(b, input) {
  return withWindowsHandle(b, input, 0x00060000, protectWindowsHandle); // READ_CONTROL | WRITE_DAC
}
function protectWindowsHandle(b, input, handle) {
    const owner = descriptorParts(securityDescriptor(b, handle)).owner;
    if (!owner) throw new Error("Cannot establish temporary owner for private DACL.");
    // ACL_REVISION, one ACCESS_ALLOWED_ACE for the new file's owner only.
    const acl = privateWindowsAcl(owner);
    const code = b.setSecurity(handle, 1, 0x80000004, null, null, acl, null);
    if (code) throw new Error(`SetSecurityInfo(private temporary) failed (Win32 ${code}).`);
    const actual = descriptorParts(securityDescriptor(b, handle));
    if (!actual.protected || !actual.dacl?.equals(acl)) throw new Error("Private temporary DACL verification failed.");
}

function linuxFileFlags(b, fd) {
  // Linux x86_64 UAPI: GETFLAGS encodes sizeof(long), but writes an int.
  // fsxattr is 28 bytes. Only fixed requests and an owned output buffer enter FFI.
  const flags = Buffer.alloc(8), extended = Buffer.alloc(28);
  if (b.ioctl(fd, 0x80086601, "void *", flags) !== 0) {
    const code = koffi.errno();
    throw new Error(`[UNSUPPORTED_COMMIT] FS_IOC_GETFLAGS failed (errno ${code}); file flags are unknown.`);
  }
  if (b.ioctl(fd, 0x801c581f, "void *", extended) !== 0) {
    const code = koffi.errno();
    throw new Error(`[UNSUPPORTED_COMMIT] FS_IOC_FSGETXATTR failed (errno ${code}); extended file flags are unknown.`);
  }
  const inodeFlags = flags.readUInt32LE(0), xflags = extended.readUInt32LE(0);
  const extentSize = extended.readUInt32LE(4), projectId = extended.readUInt32LE(12), cowExtentSize = extended.readUInt32LE(16);
  // nextents describes physical allocation, not a preservation promise.
  return { inodeFlags, xflags, extentSize, projectId, cowExtentSize,
    fileFlagsFingerprint: `${inodeFlags}:${xflags}:${extentSize}:${projectId}:${cowExtentSize}` };
}

function compareAttributeNames(left, right) { return Buffer.compare(left.name, right.name); }

function inspectLinux(b, input) {
  const names = Buffer.alloc(MAX_ATTRIBUTE_NAMES);
  const length = Number(b.list(input.fd, names, names.length));
  if (length < 0) { const error = new Error(`flistxattr failed (errno ${koffi.errno()}); absence is not established.`); throw error; }
  if (length > names.length) throw new Error("Extended attribute names exceed bound.");
  // Nonempty visible attributes select compatibility. Read actual values to
  // detect kernel-cleared capabilities/ACL changes after an in-place write.
  const attributes = [], values = createHash("sha256"), nameHash = createHash("sha256"), frame = Buffer.alloc(8);
  let start = 0, total = 0, writeClearsAttributes = false, defaultAcl = false;
  while (start < length) {
    const end = names.indexOf(0, start);
    if (end <= start || end >= length) throw new Error("Invalid extended-attribute name list.");
    const name = names.subarray(start, end + 1); // Preserve arbitrary name bytes, including its NUL terminator.
    if (name.equals(CAPABILITY_ATTRIBUTE_NAME) || name.equals(IMA_ATTRIBUTE_NAME) || name.equals(EVM_ATTRIBUTE_NAME)) writeClearsAttributes = true;
    if (name.equals(DEFAULT_ACL_ATTRIBUTE_NAME)) defaultAcl = true;
    const size = Number(b.get(input.fd, name, null, 0));
    if (size < 0) throw new Error(`fgetxattr(size) failed (errno ${koffi.errno()}); metadata absence is not established.`);
    total += size;
    if (total > 256 * 1024) throw new Error("Extended-attribute values exceed the 256 KiB inspection bound.");
    const value = Buffer.alloc(size);
    if (Number(b.get(input.fd, name, value, value.length)) !== size) throw new Error(`fgetxattr(value) failed or changed (errno ${koffi.errno()}).`);
    attributes.push({ name, value }); start = end + 1;
  }
  // flistxattr ordering is unspecified. Keep raw bytes (including non-UTF8
  // names), sort once in this bounded worker inspection, then hash framed data.
  attributes.sort(compareAttributeNames);
  let previous;
  for (const attribute of attributes) {
    if (previous && previous.equals(attribute.name)) throw new Error("Duplicate extended-attribute name.");
    const name = attribute.name.subarray(0, attribute.name.length - 1);
    frame.writeUInt32LE(name.length, 0); frame.writeUInt32LE(attribute.value.length, 4);
    nameHash.update(frame.subarray(0, 4)); nameHash.update(name);
    values.update(frame); values.update(name); values.update(attribute.value); previous = attribute.name;
  }
  return { ...linuxFileFlags(b, input.fd), hasAttributes: length !== 0, writeClearsAttributes, defaultAcl, mountId: linuxMountId(input.fd), namesFingerprint: nameHash.digest("hex"), valuesFingerprint: values.digest("hex") };
}

function linuxMountId(fd) {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Invalid owned metadata descriptor.");
  const info = openSync(`/proc/self/fdinfo/${fd}`, "r"), bytes = Buffer.alloc(4097);
  try {
    let length = 0;
    while (length < bytes.length) { const count = readSync(info, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > 4096) throw new Error("Owned descriptor information exceeds 4 KiB.");
    const match = LINUX_MOUNT_ID_PATTERN.exec(bytes.toString("utf8", 0, length));
    if (!match) throw new Error("[UNSUPPORTED_COMMIT] Mount identity is unavailable; it is not assumed equal to the parent mount.");
    return match[1];
  } finally { closeSync(info); }
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
      if (staged ? (current.mode & 0o7777n) !== 0o600n || current.uid !== BigInt(process.geteuid())
        : String(current.mode) !== expectedMetadata.mode || String(current.uid) !== expectedMetadata.uid || String(current.gid) !== expectedMetadata.gid) throw new Error("[STALE_STATE] Publication mode/owner changed.");
      const attributes = inspectLinux(b, { fd });
      if (attributes.namesFingerprint !== input.original.namesFingerprint || attributes.valuesFingerprint !== input.original.valuesFingerprint
        || attributes.fileFlagsFingerprint !== input.original.fileFlagsFingerprint) throw new Error("[STALE_STATE] Publication extended attributes/file flags changed.");
    } else {
      const current = inspectWindows(b, { path, expected, capability: !staged });
      if (staged) {
        const parts = descriptorParts(Buffer.from(current.security, "base64"));
        const original = descriptorParts(Buffer.from(input.original.security, "base64"));
        if (!parts.protected || !parts.owner?.equals(original.owner) || !parts.dacl?.equals(privateWindowsAcl(parts.owner))
          || current.links !== 1 || current.attributes !== 0x20 && current.attributes !== 0x80) throw new Error("[STALE_STATE] Publication Windows private metadata changed.");
      } else if (current.securityFingerprint !== input.original.securityFingerprint || current.links !== 1
        || current.attributes !== input.original.attributes || current.creationTime !== input.original.creationTime
        || !current.inheritanceReproducible || !current.replacementAccess || !current.parentCreationAccess) throw new Error("[STALE_STATE] Publication Windows metadata changed.");
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
    // No await, cancellation callback or main-thread gate after permissions
    // become public. Metadata installation and publication share this worker call.
    try { prepareWindows(b, { path: input.temporary, expected: input.validation.temporary, security: input.original.security, attributes: input.original.attributes }); }
    catch (error) { error.commitOutcome = "not_committed"; throw error; }
    if (!b.replace(toNamespacedPath(input.target), toNamespacedPath(input.temporary), null, 0, null, null)) winError(b, "ReplaceFileW", true);
    // ReplaceFileW may set ARCHIVE even when the prepared candidate was NORMAL.
    // Restore only on the verified published object. Failure after publication
    // reports the known publication, with incomplete metadata verification.
    // The candidate name was consumed; it must not be reported as retained.
    try { withWindowsHandle(b, { path: input.target, expected: input.validation.temporary, attributes: input.original.attributes }, 0x180, setWindowsAttributes); }
    catch (error) { error.commitOutcome = "committed"; throw error; }
  } else {
    try {
      const fd = openSync(input.temporary, "r+");
      try {
        const info = fstatSync(fd, { bigint: true }), expected = input.validation.temporary;
        if (!info.isFile() || info.nlink !== 1n || String(info.dev) !== expected.device || String(info.ino) !== expected.inode
          || (info.mode & 0o7777n) !== 0o600n) throw new Error("[STALE_STATE] Private candidate changed before publication metadata.");
        const uid = Number(input.metadata.uid), gid = Number(input.metadata.gid);
        if (info.uid !== BigInt(uid) || info.gid !== BigInt(gid)) fchownSync(fd, uid, gid);
        fchmodSync(fd, Number(input.metadata.mode) & 0o777); fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(input.temporary, input.target);
    }
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
  if (process.platform === "win32" && input.operation === "create_private") return createPrivateWindows(b, input);
  if (input.operation === "inspect") return process.platform === "win32" ? inspectWindows(b, input) : inspectLinux(b, input);
  if (process.platform === "win32" && input.operation === "protect") return protectWindows(b, input);
  if (process.platform === "win32" && input.operation === "prepare") return prepareWindows(b, input);
  if (process.platform === "win32" && input.operation === "restore_attributes") return withWindowsHandle(b, input, 0x180, setWindowsAttributes);
  if (process.platform === "win32" && input.operation === "remove") return withWindowsHandle(b, input, 0x00010080, removeWindowsHandle);
  if (input.operation === "replace") return replaceVerified(b, input);
  if (input.operation === "verify_in_place") return verifyInPlace(input);
  if (input.operation === "stats") return { calls, activeHandles, activeDescriptors, publicationAttempts, platform: process.platform, arch: process.arch };
  throw new Error("Unsupported private native file operation.");
}

function removeWindowsHandle(b, _input, handle) {
  const information = Buffer.alloc(4); information.writeUInt32LE(1);
  // FileDispositionInfo marks this verified handle, never a subsequently swapped pathname.
  if (!b.setFileInfo(handle, 4, information, 4)) winError(b, "SetFileInformationByHandle(disposition)");
  return { removed: true };
}

function onMessage(input) {
  const started = performance.now();
  try { parentPort.postMessage({ id: input.id, value: execute(input), milliseconds: performance.now() - started }); }
  catch (error) { parentPort.postMessage({ id: input.id, error: { message: String(error.message).slice(0, 1000), nativeCode: error.nativeCode, commitOutcome: error.commitOutcome, nativeUnavailable: error.nativeUnavailable }, milliseconds: performance.now() - started }); }
}
parentPort.on("message", onMessage);
