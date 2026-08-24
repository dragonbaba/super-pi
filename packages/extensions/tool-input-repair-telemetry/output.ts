import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_DIRECT_CLIPBOARD_CHARS = 100_000;

export async function deliverRepairReport(
  cwd: string,
  configDirectoryName: string,
  report: string,
  format: "markdown" | "json",
  preferClipboard: boolean,
  copy: (text: string) => Promise<void>,
): Promise<{ destination: "clipboard" } | { destination: "file"; path: string }> {
  if (preferClipboard && report.length <= MAX_DIRECT_CLIPBOARD_CHARS) {
    try {
      await copy(report);
      return { destination: "clipboard" };
    } catch {
      // Fall through to one bounded project-local report file per format.
    }
  }
  return {
    destination: "file",
    path: await writeProjectRepairReport(cwd, configDirectoryName, report, format),
  };
}

async function writeProjectRepairReport(
  cwd: string,
  configDirectoryName: string,
  report: string,
  format: "markdown" | "json",
): Promise<string> {
  const projectRoot = await realpath(resolve(cwd));
  const reportDirectory = join(projectRoot, configDirectoryName);
  await mkdir(reportDirectory, { recursive: true });
  const directoryInfo = await lstat(reportDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Refusing to write the report because ${configDirectoryName} is not a regular project directory.`);
  }
  const canonicalDirectory = await realpath(reportDirectory);
  if (!isInside(projectRoot, canonicalDirectory)) throw new Error("Refusing to write the report outside the current project.");

  const fileName = `tool-repairs-report.${format === "json" ? "json" : "md"}`;
  const target = join(canonicalDirectory, fileName);
  const temporary = join(canonicalDirectory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, report, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
