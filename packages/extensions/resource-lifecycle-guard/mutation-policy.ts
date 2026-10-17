import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { LEADING_PATH_SEPARATOR_PATTERN } from "./regex.ts";

const WORKSPACE_METADATA_ROOTS = [".git", ".sp"] as const;

export async function protectedRootViolations(
  scan: { targets: readonly string[]; moveDestinations?: readonly string[]; findDeleteScopes?: readonly string[] },
  cwd: string,
  additionalWorkspaces: readonly { canonicalPath: string }[] = [],
): Promise<string[]> {
  // Operand deletion and find's content scope retain their existing scan evidence.
  let workspace: string;
  try {
    workspace = await realpath(resolve(cwd));
  } catch {
    return [];
  }

  const violations = new Set<string>();
  // Only known catastrophic roots are unapprovable. Uncertainty belongs to UI.
  const protectedRoots = [["workspace_root", workspace], ["home_root", homedir()],
    ...WORKSPACE_METADATA_ROOTS.map(name => [`workspace_${name.slice(1)}_root`, resolve(workspace, name)])];
  for (const grant of additionalWorkspaces) {
    protectedRoots.push(["workspace_root", grant.canonicalPath]);
    for (const name of WORKSPACE_METADATA_ROOTS) protectedRoots.push([`workspace_${name.slice(1)}_root`, resolve(grant.canonicalPath, name)]);
  }
  for (const root of protectedRoots) {
    try { root[1] = await canonicalizeProspectivePath(root[1]); } catch { /* No known canonical root. */ }
  }
  const targetCount = scan.targets.length;
  const operandCount = targetCount + (scan.moveDestinations?.length ?? 0);
  for (let index = 0; index < operandCount + (scan.findDeleteScopes?.length ?? 0); index++) {
    const findScope = index >= operandCount;
    const destination = index >= targetCount && !findScope;
    const target = findScope ? scan.findDeleteScopes![index - operandCount]!
      : destination ? scan.moveDestinations![index - targetCount]! : scan.targets[index]!;
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
    for (const [name, root] of protectedRoots) {
      // find at a workspace is ordinary high risk; HOME ancestors and metadata
      // scopes (including descendants) remain catastrophic content deletions.
      const protectedTarget = findScope
        ? name === "home_root" ? isInside(canonical, root) : name !== "workspace_root" && isInside(root, canonical)
        : isInside(canonical, root);
      if (protectedTarget) violations.add(name);
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
