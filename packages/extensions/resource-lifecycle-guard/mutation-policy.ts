import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { HighRiskMutationScan } from "./core.ts";
import { LEADING_PATH_SEPARATOR_PATTERN } from "./regex.ts";

const WORKSPACE_METADATA_ROOTS = [".git", ".sp"] as const;

export async function protectedRootViolations(
  scan: Pick<HighRiskMutationScan, "targets" | "workspaceWide"> & { moveDestinations?: readonly string[] },
  cwd: string,
): Promise<string[]> {
  // Callers provide actual destructive operands, excluding opaque cwd and writes.
  let workspace: string;
  try {
    workspace = await realpath(resolve(cwd));
  } catch {
    return [];
  }

  const violations = new Set<string>();
  // Only known catastrophic roots are unapprovable. Uncertainty belongs to UI.
  if (scan.workspaceWide) violations.add("workspace_root");
  const protectedRoots = [["workspace_root", workspace], ["home_root", homedir()],
    ...WORKSPACE_METADATA_ROOTS.map(name => [`workspace_${name.slice(1)}_root`, resolve(workspace, name)])];
  for (const root of protectedRoots) {
    try { root[1] = await canonicalizeProspectivePath(root[1]); } catch { /* No known canonical root. */ }
  }
  const targetCount = scan.targets.length;
  for (let index = 0; index < targetCount + (scan.moveDestinations?.length ?? 0); index++) {
    const destination = index >= targetCount;
    const target = destination ? scan.moveDestinations![index - targetCount]! : scan.targets[index]!;
    let canonical: string;
    try {
      canonical = await canonicalizeProspectivePath(target);
    } catch {
      continue;
    }
    // Ordinary mv into an existing directory adds a child; it does not replace that root.
    if (destination) {
      try { if ((await stat(canonical)).isDirectory()) continue; } catch { /* Not an existing directory. */ }
    }
    if (canonical === parse(canonical).root) {
      violations.add("filesystem_root");
      continue;
    }
    // A target containing a protected root destroys it; a child file does not.
    for (const [name, root] of protectedRoots) if (isInside(canonical, root)) violations.add(name);
  }
  return [...violations].sort();
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let probe = resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalParent = await realpath(probe);
      return resolve(canonicalParent, ...suffix);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(probe.slice(parent.length).replace(LEADING_PATH_SEPARATOR_PATTERN, ""));
      probe = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
