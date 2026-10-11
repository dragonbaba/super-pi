import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Each query gets an isolated lazy binding owner. Only named native functions
// are faulted; all successful operations and rollback target real owned files.
for (const fault of ["unavailable", "token", "token-close", "security-read", "security-mismatch", "file-info", "transfer", "identity", "inherited-handle", "delete", "close"] as const) {
  test(`private Windows output fails closed and rolls back its exact handle: ${fault}`, { skip: process.platform !== "win32" }, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), "pi-native-output-test-")), path = join(root, "private.log");
    const koffi = createRequire(import.meta.url)("koffi"), load = koffi.load;
    let transferredFd: number | undefined, creates = 0, deleteAttempts = 0, nativeFileClosed = 0, transferAttempts = 0;
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true }); });
    t.mock.method(koffi, "load", function(libraryPath: string | null) {
      if (fault === "unavailable") throw new Error("fixture native unavailable");
      const library = load(libraryPath);
      return { ...library, func(...definitions: any[]) {
        const fn = Reflect.apply(library.func, library, definitions) as (...args: any[]) => any, name = definitions.join(" ");
        if (name.includes("GetLastError")) return () => 5;
        if (name.includes("OpenProcessToken") && fault === "token") return () => 0;
        if (name.includes("CreateFileW")) return (...args: any[]) => {
          creates++;
          // Security is supplied BEFORE the OS makes the file visible.
          const descriptor = args[3].descriptor as Buffer;
          assert.equal(descriptor.readUInt16LE(2) & 0x9004, 0x9004);
          assert.notEqual(descriptor.readUInt32LE(4), 0);
          assert.equal(descriptor.readUInt16LE(descriptor.readUInt32LE(16) + 4), 1);
          assert.equal(args[3].inherit, 0); assert.equal(args[4], 1);
          return fn(...args);
        };
        if (name.includes("GetKernelObjectSecurity")) return (...args: any[]) => {
          if (fault === "security-read") return 0;
          const result = fn(...args);
          if (["security-mismatch", "delete", "close"].includes(fault)) args[2].writeUInt16LE(0x8004, 2);
          return result;
        };
        if (name.includes("GetFileInformationByHandle") && fault === "file-info") return () => 0;
        if (name.includes("uv_open_osfhandle")) return (...args: any[]) => {
          transferAttempts++;
          if (fault === "transfer") return -1;
          transferredFd = fn(...args); return transferredFd;
        };
        if (name.includes("GetHandleInformation") && fault === "inherited-handle") return (...args: any[]) => {
          const result = fn(...args); args[1].writeUInt32LE(1); return result;
        };
        if (name.includes("SetFileInformationByHandle")) return (...args: any[]) => {
          deleteAttempts++; assert.equal(args[1], 4); assert.equal(args[2][0], 1);
          if (fault === "delete") return 0;
          return fn(...args);
        };
        if (name.includes("CloseHandle")) return (...args: any[]) => {
          const result = fn(...args);
          if (creates) nativeFileClosed++;
          // Actually release the test handle, then simulate an unconfirmed close.
          if (fault === "token-close" || fault === "close" && creates > 0) return 0;
          return result;
        };
        return fn;
      } };
    });
    const stat = fs.fstatSync;
    if (fault === "identity") t.mock.method(fs, "fstatSync", (fd: number, options: any) => {
      const result = stat(fd, options);
      return fd === transferredFd ? { ...result, ino: -1n } : result;
    });
    syncBuiltinESMExports();
    const module = await import(`../packages/coding-agent/src/utils/windows-private-output.ts?failure=${fault}`);
    assert.throws(() => module.openWindowsPrivateOutput(path), (error: any) => {
      if (fault === "delete" || fault === "close") { assert.equal(error.fullOutputPath, path); assert.ok(error.cause); }
      return true;
    });
    assert.equal(creates, ["unavailable", "token", "token-close"].includes(fault) ? 0 : 1);
    assert.equal(deleteAttempts, creates);
    if (transferredFd !== undefined) assert.throws(() => stat(transferredFd!), { code: "EBADF" });
    if (creates && transferredFd === undefined) assert.equal(nativeFileClosed, 1);
    assert.equal(fs.existsSync(path), fault === "delete");
    if (fault === "delete") assert.equal(fs.statSync(path).size, 0, "no output before verification");
    const counters = module.windowsPrivateOutputDiagnostics();
    assert.equal(counters.nativeHandles, fault === "close" ? 1 : 0);
    assert.equal(counters.tokenHandles, fault === "token-close" ? 1 : 0);
    assert.equal(counters.transfers, 0);
    if (fault === "security-mismatch") assert.equal(transferAttempts, 0);
  });
}

test("private Windows output rejects NUL and alternate stream paths before native creation", { skip: process.platform !== "win32" }, async () => {
  const module = await import(new URL("../packages/coding-agent/src/utils/windows-private-output.ts?invalid-paths", import.meta.url).href);
  for (const path of ["C:\\fixture\0.log", "C:\\fixture.log:stream"]) assert.throws(() => module.openWindowsPrivateOutput(path), { code: "EINVAL" });
  assert.equal(module.windowsPrivateOutputDiagnostics().loaded, false);
});
