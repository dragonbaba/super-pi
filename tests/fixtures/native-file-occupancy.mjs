// Test-only Windows handle owner: keeps READ/WRITE sharing, refuses DELETE sharing.
import koffi from "koffi";
import { toNamespacedPath } from "node:path";
const kernel = koffi.load("kernel32.dll");
const open = kernel.func("void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)");
const close = kernel.func("int __stdcall CloseHandle(void *)");
const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
const handle = open(toNamespacedPath(process.argv[2]), 0x80000000, 3, null, 3, 0, null);
if (handle === -1n || handle === 0xffffffffffffffffn) throw new Error(`fixture CreateFileW: ${lastError()}`);
let closed = false;
function release() { if (!closed) { closed = true; if (!close(handle)) process.exitCode = 1; } if (process.connected) process.disconnect(); }
process.on("message", release);
process.on("disconnect", release);
process.send({ ready: true });
