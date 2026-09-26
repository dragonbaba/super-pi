// Test-only legacy descriptor constructor. Production never uses obsolete SetFileSecurityW.
import assert from "node:assert/strict";
import koffi from "koffi";
import { join, toNamespacedPath } from "node:path";
const kernel = koffi.load("kernel32.dll"), directory = Buffer.alloc(65536);
const getDirectory = kernel.func("uint32_t __stdcall GetSystemDirectoryW(void *, uint32_t)");
const length = getDirectory(directory, 32768); assert.ok(length > 0 && length < 32768);
const security = koffi.load(join(directory.toString("utf16le", 0, length * 2), "advapi32.dll"));
const setLegacy = security.func("int __stdcall SetFileSecurityW(str16, uint32_t, void *)");
const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
const bytes = Buffer.from(process.argv[3], "base64"), acl = bytes.readUInt32LE(16), count = bytes.readUInt16LE(acl + 4);
bytes.writeUInt16LE(bytes.readUInt16LE(2) & ~0x1400, 2);
for (let i = 0, offset = acl + 8; i < count; i++) { bytes[offset + 1] &= ~0x10; offset += bytes.readUInt16LE(offset + 2); }
if (!setLegacy(toNamespacedPath(process.argv[2]), 4, bytes)) throw new Error(`legacy fixture: Win32 ${lastError()}`);
