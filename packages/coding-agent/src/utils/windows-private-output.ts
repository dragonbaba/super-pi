import { closeSync, fstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, toNamespacedPath, win32 } from "node:path";

const moduleRequire = createRequire(import.meta.url);
const MAX_SECURITY_BYTES = 64 * 1024;
let nativeHandles = 0, tokenHandles = 0, opens = 0, transfers = 0, rejectedCreates = 0;

function winError(native: Bindings, operation: string, path?: string): NodeJS.ErrnoException & { nativeCode: number } {
	// GetLastError must be read on the same thread immediately after the failed call.
	const nativeCode = native.lastError();
	const code = nativeCode === 80 || nativeCode === 183 ? "EEXIST"
		: nativeCode === 2 || nativeCode === 3 ? "ENOENT" : nativeCode === 5 ? "EACCES"
			: nativeCode === 112 ? "ENOSPC" : "EIO";
	return Object.assign(new Error(`${operation} failed (Win32 ${nativeCode})${path ? `: ${path}` : ""}`), { code, nativeCode, path });
}

function loadBindings() {
	if (process.platform !== "win32" || process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error("Private Windows output requires a 64-bit Windows runtime.");
	}
	// Lazy first-spill setup. No extension dependency, process launch or per-write IPC.
	const koffi = moduleRequire("koffi") as typeof import("koffi");
	const kernel = koffi.load("kernel32.dll"); // Windows KnownDLL
	const getDirectory = kernel.func("uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)");
	const directoryBytes = Buffer.alloc(32768 * 2), length = getDirectory(directoryBytes, 32768);
	if (!length || length >= 32768) throw new Error("Cannot obtain Windows system directory.");
	const directory = realpathSync(directoryBytes.toString("utf16le", 0, length * 2));
	// Fixed OS-derived library paths, never cwd, PATH or environment SystemRoot.
	const security = koffi.load(join(directory, "advapi32.dll"));
	// The OS ucrtbase.dll may have a DIFFERENT fd table from Node's static CRT.
	// Use the current Node runtime's public libuv conversion, without reopening.
	const runtime = koffi.load(null);
	const attributes = koffi.struct({ length: "uint32_t", descriptor: "void *", inherit: "int32_t" });
	return {
		open: kernel.func("__stdcall", "CreateFileW", "void *", ["str16", "uint32_t", "uint32_t", koffi.pointer(attributes), "uint32_t", "uint32_t", "void *"]),
		lastError: kernel.func("uint32_t __stdcall GetLastError(void)"),
		close: kernel.func("int __stdcall CloseHandle(void *handle)"),
		currentProcess: kernel.func("void * __stdcall GetCurrentProcess(void)"),
		fileInfo: kernel.func("int __stdcall GetFileInformationByHandle(void *handle, void *info)"),
		getSecurity: security.func("int __stdcall GetKernelObjectSecurity(void *handle, uint32_t information, void *descriptor, uint32_t size, void *needed)"),
		openToken: security.func("int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)"),
		tokenInfo: security.func("int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, void *needed)"),
		sidLength: security.func("uint32_t __stdcall GetLengthSid(void *sid)"),
		copySid: security.func("int __stdcall CopySid(uint32_t size, void *destination, void *source)"),
		deleteFile: kernel.func("int __stdcall SetFileInformationByHandle(void *handle, int kind, void *info, uint32_t size)"),
		toFd: runtime.func("int uv_open_osfhandle(intptr_t handle)"),
		handleInfo: kernel.func("int __stdcall GetHandleInformation(void *handle, void *flags)"),
	};
}
type Bindings = ReturnType<typeof loadBindings>;
let bindings: Bindings | undefined;
let descriptor: Buffer | undefined;

function processUser(native: Bindings): Buffer {
	const tokenBytes = Buffer.alloc(8);
	if (!native.openToken(native.currentProcess(), 8, tokenBytes)) throw winError(native, "OpenProcessToken");
	const token = tokenBytes.readBigUInt64LE(); tokenHandles++;
	let user: Buffer | undefined, failure: unknown;
	try {
		const info = Buffer.alloc(256), needed = Buffer.alloc(4);
		if (!native.tokenInfo(token, 1, info, info.length, needed)) throw winError(native, "GetTokenInformation(TokenUser)");
		if (needed.readUInt32LE() < 8 || needed.readUInt32LE() > info.length) throw new Error("Invalid TokenUser length.");
		const pointer = info.readBigUInt64LE(), size = native.sidLength(pointer);
		if (size < 8 || size > 68) throw new Error("Invalid process user SID length.");
		user = Buffer.alloc(size);
		if (!native.copySid(size, user, pointer)) throw winError(native, "CopySid");
	} catch (error) { failure = error; }
	if (native.close(token)) tokenHandles--;
	else failure = new Error("Private output token close failed.", { cause: failure ?? winError(native, "CloseHandle(token)") });
	if (failure) throw failure;
	return user!;
}

function privateDescriptor(native: Bindings): Buffer {
	const user = processUser(native);
	const aclSize = 16 + user.length, bytes = Buffer.alloc(20 + aclSize + user.length);
	bytes[0] = 1;
	bytes.writeUInt16LE(0x9004, 2); // SELF_RELATIVE | DACL_PROTECTED | DACL_PRESENT
	bytes.writeUInt32LE(20 + aclSize, 4); // Explicit current-user owner, not token default Administrators.
	bytes.writeUInt32LE(20, 16);
	bytes[20] = 2; bytes.writeUInt16LE(aclSize, 22); bytes.writeUInt16LE(1, 24);
	bytes.writeUInt16LE(8 + user.length, 30); bytes.writeUInt32LE(0x1f01ff, 32);
	user.copy(bytes, 36); user.copy(bytes, 20 + aclSize);
	return bytes;
}

function descriptorPart(bytes: Buffer, offsetField: number, acl: boolean): Buffer {
	const offset = bytes.readUInt32LE(offsetField);
	if (offset < 20 || offset + 8 > bytes.length) throw new Error("Invalid output security descriptor offset.");
	const length = acl ? bytes.readUInt16LE(offset + 2) : 8 + bytes[offset + 1] * 4;
	if (length < 8 || offset + length > bytes.length) throw new Error("Invalid output security descriptor length.");
	return bytes.subarray(offset, offset + length);
}

/** Exclusive creation with a protected current-user DACL, before any bytes are written.
 * The returned CRT descriptor is owned by Node fs / its WriteStream. Cold spill boundary only.
 */
export function openWindowsPrivateOutput(path: string): number {
	if (path.includes("\0") || win32.basename(path).includes(":")) throw Object.assign(new Error("Invalid private output file path."), { code: "EINVAL" });
	const native = bindings ??= loadBindings();
	const privateSecurity = descriptor ??= privateDescriptor(native);
	opens++;
	const handle = native.open(toNamespacedPath(path), 0x40030000, 7,
		{ length: 24, descriptor: privateSecurity, inherit: 0 }, 1, 0x80, null); // WRITE | READ_CONTROL | DELETE, CREATE_NEW
	if (handle === -1n || handle === 0xffffffffffffffffn) { rejectedCreates++; throw winError(native, "CreateFileW(private output)", path); }
	nativeHandles++;
	let fd: number | undefined;
	try {
		const needed = Buffer.alloc(4);
		let actual = Buffer.alloc(256);
		if (!native.getSecurity(handle, 5, actual, actual.length, needed)) {
			const error = winError(native, "GetKernelObjectSecurity", path);
			const size = needed.readUInt32LE();
			if (error.nativeCode !== 122 || size < 20 || size > MAX_SECURITY_BYTES) throw error;
			actual = Buffer.alloc(size);
			if (!native.getSecurity(handle, 5, actual, actual.length, needed)) throw winError(native, "GetKernelObjectSecurity", path);
		}
		const size = needed.readUInt32LE();
		if (size < 20 || size > actual.length) throw new Error("Invalid output security descriptor size.");
		actual = actual.subarray(0, size);
		if ((actual.readUInt16LE(2) & 0x9004) !== 0x9004
			|| !descriptorPart(actual, 4, false).equals(descriptorPart(privateSecurity, 4, false))
			|| !descriptorPart(actual, 16, true).equals(descriptorPart(privateSecurity, 16, true))) {
			throw new Error("Creation-time private output owner/DACL verification failed.");
		}
		const identity = Buffer.alloc(52);
		if (!native.fileInfo(handle, identity)) throw winError(native, "GetFileInformationByHandle", path);
		if (identity.readUInt32LE(0) & 0x410) throw new Error("Output handle must be a regular non-reparse file.");
		const opened: number = native.toFd(handle);
		if (opened < 0) throw Object.assign(new Error("Cannot transfer private output handle to a CRT descriptor."), { code: "EMFILE" });
		fd = opened;
		const flags = Buffer.alloc(4);
		if (!native.handleInfo(handle, flags)) throw winError(native, "GetHandleInformation", path);
		if (flags.readUInt32LE() & 1) throw new Error("Private output handle must not be inherited.");
		// Verify the exact same object is visible to Node before handing it over.
		const info = fstatSync(fd, { bigint: true });
		const inode = BigInt(identity.readUInt32LE(44)) << 32n | BigInt(identity.readUInt32LE(48));
		if (info.dev !== BigInt(identity.readUInt32LE(28)) || info.ino !== inode) throw new Error("Node/private output descriptor identity mismatch.");
		nativeHandles--; transfers++;
		return fd;
	} catch (error) {
		// Roll back the exact still-open created object, never an attacker-swappable path.
		let cleanup: Error | undefined;
		if (!native.deleteFile(handle, 4, Buffer.from([1]), 1)) cleanup = winError(native, "SetFileInformationByHandle(delete)", path);
		let closed = false;
		try { if (fd === undefined) closed = Boolean(native.close(handle)); else { closeSync(fd); closed = true; } }
		catch (error) { cleanup ??= error instanceof Error ? error : new Error(String(error)); }
		if (closed) nativeHandles--; else cleanup ??= new Error("Private output handle close was not confirmed.");
		if (cleanup) throw Object.assign(new Error(`Private output creation failed; cleanup not confirmed at ${path}: ${cleanup.message}`, { cause: error }), { fullOutputPath: path });
		throw error;
	}
}

/** Explicit diagnostics only; no output strings, handles or caller references retained. */
export function windowsPrivateOutputDiagnostics() {
	return { loaded: bindings !== undefined, descriptorBytes: descriptor?.length ?? 0, nativeHandles, tokenHandles, opens, transfers, rejectedCreates };
}
