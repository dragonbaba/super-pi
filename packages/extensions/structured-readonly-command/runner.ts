import { spawn } from "node:child_process";

const FORCE_KILL_DELAY_MS = 2_000;

export interface BoundedCommandResult {
  output: string;
  code: number;
  killed: boolean;
  outputTruncated: boolean;
  retainedBytes: number;
  totalBytes: number;
  totalLines: number;
}

export interface BoundedCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) {
    if (byte === 0x0A) count++;
  }
  return count;
}

export async function executeBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  if (options.signal?.aborted) {
    return {
      output: "",
      code: 1,
      killed: true,
      outputTruncated: false,
      retainedBytes: 0,
      totalBytes: 0,
      totalLines: 0,
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    let newlineCount = 0;
    let lastByte: number | undefined;
    let killed = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    const kill = () => {
      if (killed || settled) return;
      killed = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
    };

    const onData = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      totalBytes += chunk.byteLength;
      newlineCount += countNewlines(chunk);
      if (chunk.byteLength > 0) lastByte = chunk[chunk.byteLength - 1];
      const remaining = options.maxBytes - retainedBytes;
      if (remaining <= 0) return;
      const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(retained);
      retainedBytes += retained.byteLength;
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      options.signal?.removeEventListener("abort", kill);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        output: Buffer.concat(chunks, retainedBytes).toString("utf8"),
        code: code ?? 1,
        killed,
        outputTruncated: totalBytes > retainedBytes,
        retainedBytes,
        totalBytes,
        totalLines: totalBytes === 0 ? 0 : newlineCount + (lastByte === 0x0A ? 0 : 1),
      });
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", finish);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    timeout = setTimeout(kill, options.timeoutMs);
  });
}
