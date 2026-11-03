// Acceptance-only, synchronous Windows x64/NTFS calls. No worker or child process.
// Each returned handle is written into its owner's pre-registered slot before any
// post-open validation. No raw pointer or caller read buffer survives a call.
import koffi from "koffi";

const WINDOWS_EPOCH = 116444736000000000n;
const INVALID = 0xffffffffffffffffn;
let bindings;
function need(ok, message) { if (!ok) throw new Error(message); }
function load() {
    need(process.platform === "win32" && process.arch === "x64", "source Windows x64 required");
    if (bindings) return bindings;
    // Both names are fixed Windows KnownDLLs already loaded into this process.
    const kernel = koffi.load("kernel32.dll"), native = koffi.load("ntdll.dll");
    const unicode = koffi.struct("SP_SOURCE_UNICODE", { Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
    const object = koffi.struct("SP_SOURCE_OBJECT", { Length: "uint32_t", RootDirectory: "void *",
        ObjectName: "SP_SOURCE_UNICODE *", Attributes: "uint32_t", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
    need(koffi.sizeof(unicode) === 16 && koffi.offsetof(unicode, "Buffer") === 8
        && koffi.sizeof(object) === 48 && koffi.offsetof(object, "RootDirectory") === 8
        && koffi.offsetof(object, "ObjectName") === 16 && koffi.offsetof(object, "Attributes") === 24
        && koffi.offsetof(object, "SecurityDescriptor") === 32 && koffi.offsetof(object, "SecurityQualityOfService") === 40,
    "source unsupported native layout");
    bindings = {
        open: native.func("int32_t __stdcall NtCreateFile(void *out, uint32_t access, SP_SOURCE_OBJECT *attributes, void *status, void *allocation, uint32_t fileAttributes, uint32_t sharing, uint32_t disposition, uint32_t options, void *ea, uint32_t eaLength)"),
        error: kernel.func("uint32_t __stdcall GetLastError(void)"),
        type: kernel.func("uint32_t __stdcall GetFileType(void *handle)"),
        info: kernel.func("int32_t __stdcall GetFileInformationByHandle(void *handle, void *info)"),
        extended: kernel.func("int32_t __stdcall GetFileInformationByHandleEx(void *handle, int32_t kind, void *info, uint32_t size)"),
        path: kernel.func("uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, void *buffer, uint32_t size, uint32_t flags)"),
        volume: kernel.func("int32_t __stdcall GetVolumeInformationByHandleW(void *handle, void *label, uint32_t labelSize, void *serial, void *component, void *flags, void *filesystem, uint32_t filesystemSize)"),
        drive: kernel.func("int32_t __stdcall GetVolumeNameForVolumeMountPointW(str16 root, void *name, uint32_t size)"),
        read: kernel.func("int32_t __stdcall ReadFile(void *handle, void *buffer, uint32_t length, void *count, void *overlapped)"),
        close: kernel.func("int32_t __stdcall CloseHandle(void *handle)"),
    };
    return bindings;
}

// This factory only binds functions. The first native filesystem operation occurs
// in volumeForDrive/open. The owning reader, including failed initialization, must
// keep this object until all known handles have settled.
export class WindowsSourceNative {
    #api; #scratch; #calls = 0; #closeCalls = 0; #closeErrorCalls = 0; #reads = 0; #bytes = 0; #disposed = false;
    #allocated = 0; #cleared = 0;
    constructor() {
        this.#api = load();
        this.#scratch = { out: Buffer.alloc(8), status: Buffer.alloc(16), name: Buffer.alloc(1024),
            info: Buffer.alloc(52), basic: Buffer.alloc(40), standard: Buffer.alloc(24), tag: Buffer.alloc(8),
            path: Buffer.alloc(1024), filesystem: Buffer.alloc(64), count: Buffer.alloc(4) };
        for (const bytes of Object.values(this.#scratch)) this.#allocated += bytes.length;
    }
    #call(name, ...args) {
        need(!this.#disposed && this.#calls < 8191, "source native call budget"); this.#calls++;
        return this.#api[name](...args);
    }
    #error(operation, cleanup = false) {
        // GetLastError is obtained synchronously on the same thread immediately
        // after failure; error retrieval is counted, never blocked by the budget.
        if (cleanup) this.#closeErrorCalls++; else this.#calls++;
        const code = this.#api.error();
        const error = new Error(`${operation}: Win32 ${code}`); error.nativeCode = code; return error;
    }
    #check(ok, operation) { if (!ok) throw this.#error(operation); }
    #clear() { for (const bytes of Object.values(this.#scratch)) bytes.fill(0); }
    volumeForDrive(drive) {
        need(/^[A-Z]:\\$/.test(drive), "source drive root");
        try {
            this.#check(this.#call("drive", drive, this.#scratch.path, 512), "GetVolumeNameForVolumeMountPointW");
            let end = 0;
            while (end < this.#scratch.path.length && this.#scratch.path.readUInt16LE(end) !== 0) end += 2;
            need(end > 0 && end < this.#scratch.path.length, "source volume path length");
            return this.#scratch.path.toString("utf16le", 0, end);
        } finally { this.#clear(); }
    }
    open(slot, parent, name, kind) {
        const b = this.#scratch;
        need(typeof name === "string" && name.length > 0 && name.length <= 500, "source native name length");
        b.name.write(name, "utf16le");
        const attributes = { Length: 48, RootDirectory: parent ?? null,
            ObjectName: { Length: name.length * 2, MaximumLength: name.length * 2 + 2, Buffer: b.name },
            Attributes: 0, SecurityDescriptor: null, SecurityQualityOfService: null };
        try {
            // Exact name lookup; FILE_OPEN; SHARE_READ only. No DIRECTORY option:
            // its documented compatibility list excludes OPEN_REPARSE_POINT.
            // The owner validates the opened object before descending or reading.
            need(kind === "directory" || kind === "read" || kind === "metadata", "source open kind");
            const access = kind === "directory" ? 0x1000a0 : kind === "read" ? 0x100081 : 0x100080;
            const status = this.#call("open", b.out, access,
                attributes, b.status, null, 0, 1, 1, 0x200020, null, 0);
            const handle = b.out.readBigUInt64LE();
            if (handle !== 0n && handle !== INVALID) slot.handle = handle;
            slot.status = status; slot.information = b.status.readBigUInt64LE(8);
            slot.closeable = status === 0 && slot.handle !== undefined;
            if (status === (0xc0000034 | 0) && slot.handle === undefined) return false;
            if (status !== 0) {
                const error = new Error(`NtCreateFile: NTSTATUS ${status >>> 0}`); error.nativeStatus = status; throw error;
            }
            need(slot.handle !== undefined && b.status.readInt32LE(0) === 0 && slot.information === 1n,
                "source unexpected open result");
            return true;
        } finally { this.#clear(); }
    }
    #path(handle, flags) {
        const buffer = this.#scratch.path;
        const length = this.#call("path", handle, buffer, 512, flags);
        if (length === 0) throw this.#error("GetFinalPathNameByHandleW");
        need(length < 512, "source final path budget");
        const result = buffer.toString("utf16le", 0, length * 2); buffer.fill(0); return result;
    }
    inspect(handle) {
        const b = this.#scratch;
        try {
            need(this.#call("type", handle) === 1, "source not a disk file");
            this.#check(this.#call("info", handle, b.info), "GetFileInformationByHandle");
            this.#check(this.#call("extended", handle, 0, b.basic, 40), "FileBasicInfo");
            this.#check(this.#call("extended", handle, 1, b.standard, 24), "FileStandardInfo");
            this.#check(this.#call("extended", handle, 9, b.tag, 8), "FileAttributeTagInfo");
            this.#check(this.#call("volume", handle, null, 0, null, null, null, b.filesystem, 32), "GetVolumeInformationByHandleW");
            need(b.filesystem.toString("utf16le", 0, 10) === "NTFS\0", "source NTFS required");
            const attributes = b.info.readUInt32LE(0), directory = Boolean(attributes & 0x10);
            need(attributes === b.basic.readUInt32LE(32) && attributes === b.tag.readUInt32LE(0)
                && directory === Boolean(b.standard[21]) && b.standard[20] === 0,
            "source inconsistent metadata");
            const size = (BigInt(b.info.readUInt32LE(32)) << 32n) | BigInt(b.info.readUInt32LE(36));
            const nlink = b.info.readUInt32LE(40);
            need(nlink === b.standard.readUInt32LE(16) && (directory || size === b.standard.readBigInt64LE(8)),
                "source inconsistent length/links");
            const dev = BigInt(b.info.readUInt32LE(28));
            const ino = (BigInt(b.info.readUInt32LE(44)) << 32n) | BigInt(b.info.readUInt32LE(48));
            const write = b.basic.readBigInt64LE(16), change = b.basic.readBigInt64LE(24);
            need(ino > 0n && write >= WINDOWS_EPOCH && change >= WINDOWS_EPOCH
                && b.info.readBigUInt64LE(20) === write, "source identity/time range");
            return { kind: directory ? "directory" : "file", attributes, reparseTag: b.tag.readUInt32LE(4), nlink,
                identity: { dev, ino, size, mtimeNs: (write - WINDOWS_EPOCH) * 100n, ctimeNs: (change - WINDOWS_EPOCH) * 100n },
                guidPath: this.#path(handle, 1), dosPath: this.#path(handle, 0) };
        } finally { this.#clear(); }
    }
    read(handle, bytes, offset, length) {
        need(Buffer.isBuffer(bytes) && Number.isInteger(offset) && Number.isInteger(length)
            && offset >= 0 && length > 0 && offset + length <= bytes.length, "source read slice");
        need(this.#reads < 4096 && this.#bytes + length <= 16384, "source native read budget");
        this.#reads++;
        try {
            // The synchronous handle maintains its own file position. The view is
            // borrowed solely until ReadFile returns, including a short read.
            const ok = this.#call("read", handle, bytes.subarray(offset, offset + length), length, this.#scratch.count, null);
            const error = ok ? undefined : this.#error("ReadFile");
            const count = this.#scratch.count.readUInt32LE(); this.#bytes += count;
            if (!ok) throw error;
            need(count > 0 && count <= length, "source short/invalid read"); return count;
        } finally { this.#scratch.count.fill(0); }
    }
    close(handle) {
        need(!this.#disposed, "source native disposed"); this.#closeCalls++;
        // Cleanup and its error retrieval cannot be denied by a business budget.
        if (!this.#api.close(handle)) throw this.#error("CloseHandle", true); return true;
    }
    get diagnostics() { return { calls: this.#calls, closeCalls: this.#closeCalls, closeErrorCalls: this.#closeErrorCalls, readCalls: this.#reads,
        readBytes: this.#bytes, allocatedScratch: this.#allocated, releasedScratch: this.#cleared,
        retainedScratch: this.#disposed ? 0 : this.#allocated, retainedBindings: !this.#disposed }; }
    dispose() {
        if (this.#disposed) return;
        this.#clear(); this.#cleared = this.#allocated; this.#scratch = undefined; this.#api = undefined; this.#disposed = true;
    }
}
