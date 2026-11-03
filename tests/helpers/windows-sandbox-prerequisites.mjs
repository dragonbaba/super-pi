import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { POWERSHELL7_PATH, POWERSHELL7_SHA256 } from "../../scripts/acceptance/windows-sandbox-volume.mjs";

export const WINDOWS_PATH_TEST_OPTIONS = Object.freeze({
  skip: process.platform === "win32" ? false : "Requires Windows drive/NTFS path semantics",
});

// These historical native checks explicitly pin a reviewed local toolchain.
// Model regressions stay automatic; a different hosted compiler is not that toolchain.
function pinnedToolchainOptions() {
  if (process.platform !== "win32") return { skip: "Requires the reviewed Windows sandbox toolchain" };
  const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  for (const [file, expected] of [[compiler, "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3"],
    [POWERSHELL7_PATH, POWERSHELL7_SHA256]]) {
    if (!fs.existsSync(file)) return { skip: "Pinned sandbox toolchain is not installed: " + file };
    if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected)
      return { skip: "Installed tool differs from the reviewed sandbox pin: " + file };
  }
  // A fresh checkout does not contain this ignored output parent.
  fs.mkdirSync(fileURLToPath(new URL("../../.artifacts", import.meta.url)), { recursive: true });
  return { skip: false };
}
export const PINNED_SANDBOX_TEST_OPTIONS = Object.freeze(pinnedToolchainOptions());
