import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

const WORKSPACE_METADATA_ROOTS = [".git", ".sp"] as const;

/** Resolve protection roots independently: the metadata root may itself be a junction. */
export async function canonicalWorkspaceMetadata(workspaces: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const workspace of workspaces) for (const name of WORKSPACE_METADATA_ROOTS) {
    roots.push(await canonicalizeProspectivePath(resolve(workspace, name)));
  }
  return roots;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}

export async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  let probe = resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalParent = await realpath(probe);
      return resolve(canonicalParent, ...suffix);
    } catch (error) {
      // A component that is a regular file (ENOTDIR) means the path cannot exist yet either.
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(probe.slice(parent.length).replaceAll("/", "").replaceAll("\\", ""));
      probe = parent;
    }
  }
}

export interface ProtectedMutationAssessment {
  canonicalTarget?: string;
  violations: string[];
}

/** Apply the same protected-root boundary used by high-risk Bash mutations. */
export async function assessProtectedMutationPath(cwd: string, target: string): Promise<ProtectedMutationAssessment> {
  let workspace: string;
  let canonical: string;
  try {
    workspace = await realpath(resolve(cwd));
  } catch {
    return { violations: ["unverifiable_workspace"] };
  }
  try {
    canonical = await canonicalizeProspectivePath(target);
  } catch {
    return { violations: ["unverifiable_target"] };
  }

  const workspaces = [workspace];
  return assessCanonicalMutationPath(workspaces, canonical, await canonicalWorkspaceMetadata(workspaces));
}

/** Inputs have already been resolved against disk, including every workspace root. */
export function assessCanonicalMutationPath(workspaces: readonly string[], canonical: string, metadata?: readonly string[]): ProtectedMutationAssessment {
  const violations: string[] = [];
  if (canonical === parse(canonical).root) violations.push("filesystem_root");
  let contained = false;
  for (let index = 0; index < workspaces.length; index++) {
    const workspace = workspaces[index]!;
    if (canonical === workspace) violations.push("workspace_root");
    if (isInside(workspace, canonical)) contained = true;
    for (let slot = 0; slot < WORKSPACE_METADATA_ROOTS.length; slot++) {
      const name = WORKSPACE_METADATA_ROOTS[slot]!;
      const protectedRoot = metadata?.[index * WORKSPACE_METADATA_ROOTS.length + slot] ?? resolve(workspace, name);
      if (canonical === protectedRoot || isInside(protectedRoot, canonical)) {
        violations.push(`workspace_${name.slice(1)}_root`);
      }
    }
  }
  if (!contained) violations.push("workspace_escape");
  violations.sort();
  return { canonicalTarget: canonical, violations };
}

export async function protectedMutationViolations(cwd: string, target: string): Promise<string[]> {
  return (await assessProtectedMutationPath(cwd, target)).violations;
}
