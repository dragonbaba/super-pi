import { createHash } from "node:crypto";
import { assertSandboxTaskRequest, SANDBOX_TASK_LIMITS, type SandboxTaskRequest } from "./task-request.ts";

/** Data layout only: a package is not a permission or a live capture lease. */
export const TASK_PACKAGE_LIMITS = Object.freeze({
  headerBytes: 16, metadataBytes: 32768, inputBytes: SANDBOX_TASK_LIMITS.inputBytes,
  packageBytes: 16 + 32768 + SANDBOX_TASK_LIMITS.inputBytes,
  runnerBytes: 65536,
  resultHeaderBytes: 128,
  resultBytes: 128 + SANDBOX_TASK_LIMITS.stdoutBytes + SANDBOX_TASK_LIMITS.stderrBytes,
});
export const TASK_PACKAGE_MAGIC = "SPTASK01";
export const TASK_RESULT_MAGIC = "SPRES001";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("[SANDBOX_TASK_PACKAGE] " + reason);
}
export interface TaskPackageInput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
/**
 * One bounded binary carrier. The publication owner must obtain inputs from its
 * original WindowsWorkspaceInputCapture; these descriptors alone prove nothing.
 *
 * Header: magic[8], total:u32, metadata:u32.
 * Metadata: task UUID[36], snapshot UUID[36], timeout:u32, command length:u32,
 * cwd length:u8, input count:u8, write count:u8, reserved:u8=0; cwd ASCII,
 * command UTF16LE->Base64 ASCII; input rows (path length:u8, path ASCII,
 * bytes:u32, SHA256[32]); write rows (path length:u8, path ASCII, op:u8:
 * 1=add,2=modify). Payload follows in input order. All integers little endian.
 * No host paths, credentials, read-revision IDs or authority fields are encoded.
 */
export class TaskPackageBuilder {
  #buffer?: Buffer;
  #inputs: { bytes: number; sha256: string }[] = [];
  #next = 0;
  #offset = 0;
  #state = "new";
  #allocated = 0;
  #cleared = 0;
  #transferred = 0;
  #copied = 0;
  #commandScratch = 0;
  #commandCleared = 0;
  constructor(request: SandboxTaskRequest, taskId: string, snapshotId: string, inputs: readonly TaskPackageInput[]) {
    let commandBytes: Buffer | undefined;
    try {
      assertSandboxTaskRequest(request);
      need(typeof taskId === "string" && typeof snapshotId === "string" && UUID.test(taskId) && UUID.test(snapshotId), "Task association.");
      need(Array.isArray(inputs) && inputs.length === request.inputs.length, "Selected input count.");
      let inputBytes = 0, rowsBytes = 0;
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index]!;
        const size = input.bytes, sha = input.sha256, name = input.path;
        need(name === request.inputs[index]!.path && Number.isSafeInteger(size) && size >= 0
          && size <= SANDBOX_TASK_LIMITS.inputFileBytes && typeof sha === "string" && SHA.test(sha), "Input descriptor.");
        inputBytes += size; rowsBytes += 1 + name.length + 4 + 32;
        this.#inputs.push({ bytes: size, sha256: sha });
      }
      need(inputBytes <= TASK_PACKAGE_LIMITS.inputBytes, "Input byte limit.");
      for (const write of request.writes) rowsBytes += 1 + write.path.length + 1;
      commandBytes = Buffer.from(request.command, "utf16le");
      this.#commandScratch = commandBytes.length;
      const encoded = commandBytes.toString("base64");
      const metadataBytes = 84 + request.cwd.length + encoded.length + rowsBytes;
      need(metadataBytes <= TASK_PACKAGE_LIMITS.metadataBytes, "Metadata byte limit.");
      const total = TASK_PACKAGE_LIMITS.headerBytes + metadataBytes + inputBytes;
      need(total <= TASK_PACKAGE_LIMITS.packageBytes, "Package byte limit.");
      const buffer = this.#buffer = Buffer.alloc(total); this.#allocated = total;
      let at = 0;
      at += buffer.write(TASK_PACKAGE_MAGIC, at, "ascii");
      buffer.writeUInt32LE(total, at); at += 4;
      buffer.writeUInt32LE(metadataBytes, at); at += 4;
      at += buffer.write(taskId, at, "ascii"); at += buffer.write(snapshotId, at, "ascii");
      buffer.writeUInt32LE(request.timeoutMs, at); at += 4;
      buffer.writeUInt32LE(encoded.length, at); at += 4;
      buffer[at++] = request.cwd.length; buffer[at++] = inputs.length; buffer[at++] = request.writes.length;
      buffer[at++] = 0;
      at += buffer.write(request.cwd, at, "ascii"); at += buffer.write(encoded, at, "ascii");
      for (let index = 0; index < inputs.length; index++) {
        const name = request.inputs[index]!.path, input = this.#inputs[index]!;
        buffer[at++] = name.length; at += buffer.write(name, at, "ascii");
        buffer.writeUInt32LE(input.bytes, at); at += 4;
        need(buffer.write(input.sha256, at, 32, "hex") === 32, "Input hash encoding."); at += 32;
      }
      for (const write of request.writes) {
        buffer[at++] = write.path.length; at += buffer.write(write.path, at, "ascii");
        buffer[at++] = write.operation === "add" ? 1 : 2;
      }
      need(at === TASK_PACKAGE_LIMITS.headerBytes + metadataBytes, "Metadata layout.");
      this.#offset = at; this.#state = "assembling";
    } catch (error) { this.dispose(); throw error; }
    finally {
      if (commandBytes) { commandBytes.fill(0); this.#commandCleared += commandBytes.length; commandBytes = undefined; }
    }
  }
  /** Borrows one original delivered copy synchronously. The caller clears it. */
  append(index: number, bytes: Buffer): void {
    try {
      need(this.#state === "assembling" && this.#buffer && index === this.#next && index < this.#inputs.length,
        "One ordered append per input.");
      const input = this.#inputs[index]!;
      need(Buffer.isBuffer(bytes) && bytes.length === input.bytes
        && createHash("sha256").update(bytes).digest("hex") === input.sha256, "Delivered input changed.");
      need(bytes.copy(this.#buffer, this.#offset) === bytes.length, "Input copy.");
      this.#offset += bytes.length; this.#copied += bytes.length; this.#next++;
    } catch (error) { this.dispose(); throw error; }
  }
  /** Exactly one ownership transfer. The recipient clears the returned buffer. */
  finish(): Buffer {
    try {
      need(this.#state === "assembling" && this.#buffer && this.#next === this.#inputs.length
        && this.#offset === this.#buffer.length, "Incomplete or repeated transfer.");
      const buffer = this.#buffer;
      this.#buffer = undefined; this.#transferred = buffer.length; this.#state = "transferred";
      this.#inputs.length = 0; this.#offset = 0;
      return buffer;
    } catch (error) { this.dispose(); throw error; }
  }
  dispose(): void {
    if (this.#buffer) { this.#buffer.fill(0); this.#cleared += this.#buffer.length; this.#buffer = undefined; }
    this.#inputs.length = 0; this.#offset = 0;
    if (this.#state !== "transferred") this.#state = "disposed";
  }
  get diagnostics() {
    return { state: this.#state, allocatedBytes: this.#allocated, clearedBytes: this.#cleared,
      transferredBytes: this.#transferred, copiedInputBytes: this.#copied, appendedInputs: this.#next,
      retainedBytes: this.#buffer?.length ?? 0, retainedInputRows: this.#inputs.length,
      commandScratchBytes: this.#commandScratch, commandClearedBytes: this.#commandCleared };
  }
}
