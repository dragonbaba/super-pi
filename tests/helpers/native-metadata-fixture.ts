import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Explicit supported staged-test precondition, applied only to a recorded synthetic file. */
export async function protectWindowsFixture(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await execute(process.execPath, [fileURLToPath(new URL("../fixtures/native-protected-dacl.mjs", import.meta.url)), path], { windowsHide: true });
}
