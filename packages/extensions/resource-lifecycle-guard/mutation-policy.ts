import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { HighRiskMutationScan } from "./core.ts";
import { LEADING_PATH_SEPARATOR_PATTERN } from "./regex.ts";

const WORKSPACE_METADATA_ROOTS = [".git", ".super-pi"] as const;

export async function protectedRootViolations(
  scan: HighRiskMutationScan,
  cwd: string,
): Promise<string[]> {
  let workspace: string;
  try {
    workspace = await realpath(resolve(cwd));
  } catch {
    return ["unverifiable_workspace"];
  }

  const violations = new Set<string>();
  // Workspace-wide mutations necessarily include the protected workspace root.
  // A recognized mutation whose target cannot be statically bounded could also
  // resolve to workspace metadata or an escape, so it fails closed before UI.
  if (scan.workspaceWide) violations.add("workspace_root");
  if (scan.unverifiableScope) violations.add("unverifiable_dynamic_scope");
  for (const target of scan.targets) {
    let canonical: string;
    try {
      canonical = await canonicalizeProspectivePath(target);
    } catch {
      violations.add("unverifiable_target");
      continue;
    }
    if (canonical === parse(canonical).root) {
      violations.add("filesystem_root");
      continue;
    }
    if (canonical === workspace) {
      violations.add("workspace_root");
      continue;
    }
    if (!isInside(workspace, canonical)) {
      violations.add("workspace_escape");
      continue;
    }
    for (const name of WORKSPACE_METADATA_ROOTS) {
      const protectedRoot = resolve(workspace, name);
      if (canonical === protectedRoot || isInside(protectedRoot, canonical)) {
        violations.add(`workspace_${name.slice(1)}_root`);
      }
    }
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
