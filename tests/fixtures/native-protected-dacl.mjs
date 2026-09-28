// Synthetic staged-capability fixture; supports the same UTF-16 long paths as production.
import assert from "node:assert/strict";
import koffi from "koffi";
import { join, toNamespacedPath } from "node:path";
const kernel = koffi.load("kernel32.dll"), directory = Buffer.alloc(65536);
const getDirectory = kernel.func("uint32_t __stdcall GetSystemDirectoryW(void *, uint32_t)");
const length = getDirectory(directory, 32768); assert.ok(length > 0 && length < 32768);
const security = koffi.load(join(directory.toString("utf16le", 0, length * 2), "advapi32.dll"));
const open = kernel.func("void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)");
const close = kernel.func("int __stdcall CloseHandle(void *)"), lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
const get = security.func("int __stdcall GetKernelObjectSecurity(void *, uint32_t, void *, uint32_t, void *)");
const set = security.func("uint32_t __stdcall SetSecurityInfo(void *, int, uint32_t, void *, void *, void *, void *)");
const handle = open(toNamespacedPath(process.argv[2]), 0x60000, 7, null, 3, 0x200000, null);
if (handle === -1n || handle === 0xffffffffffffffffn) throw new Error(`fixture open: ${lastError()}`);
try {
  const bytes = Buffer.alloc(65536), needed = Buffer.alloc(4);
  if (!get(handle, 4, bytes, bytes.length, needed)) throw new Error(`fixture security: ${lastError()}`);
  const offset = bytes.readUInt32LE(16); assert.ok(offset >= 20 && offset + 8 < needed.readUInt32LE());
  const code = set(handle, 1, 0x80000004, null, null, bytes.subarray(offset), null);
  assert.equal(code, 0);
} finally { assert.ok(close(handle), `fixture close: ${lastError()}`); }
