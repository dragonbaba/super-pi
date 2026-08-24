import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MAX_REPORT_BYTES } from "./core.ts";

const REPORT_FILE_NAME = "tool-errors-report.md";
const MAX_DIRECT_CLIPBOARD_CHARS = 100_000;

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function writeProjectErrorReport(cwd: string, configDirectoryName: string, report: string): Promise<string> {
  if (Buffer.byteLength(report, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("Refusing to write an error report that exceeds the total report byte limit.");
  }
  const projectRoot = await realpath(resolve(cwd));
  const reportDirectory = join(projectRoot, configDirectoryName);
  await mkdir(reportDirectory, { recursive: true });

  const directoryInfo = await lstat(reportDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Refusing to write the report because ${configDirectoryName} is not a regular project directory.`);
  }

  const canonicalDirectory = await realpath(reportDirectory);
  if (!isInside(projectRoot, canonicalDirectory)) {
    throw new Error("Refusing to write the report outside the current project.");
  }

  const target = join(canonicalDirectory, REPORT_FILE_NAME);
  const temporary = join(canonicalDirectory, `.${REPORT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, report, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export async function deliverErrorReport(
  cwd: string,
  configDirectoryName: string,
  report: string,
  preferClipboard: boolean,
  copy: (text: string) => Promise<void>,
): Promise<{ destination: "clipboard" } | { destination: "file"; path: string }> {
  if (Buffer.byteLength(report, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("Refusing to deliver an error report that exceeds the total report byte limit.");
  }
  if (preferClipboard && report.length <= MAX_DIRECT_CLIPBOARD_CHARS) {
    try {
      await copy(report);
      return { destination: "clipboard" };
    } catch {
      // Fall back to a bounded project-local report file.
    }
  }
  return { destination: "file", path: await writeProjectErrorReport(cwd, configDirectoryName, report) };
}
