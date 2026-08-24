import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

const WORKSPACE_METADATA_ROOTS = [".git", ".super-pi"] as const;

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
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

  const violations: string[] = [];
  if (canonical === parse(canonical).root) violations.push("filesystem_root");
  if (canonical === workspace) violations.push("workspace_root");
  if (!isInside(workspace, canonical)) violations.push("workspace_escape");
  if (isInside(workspace, canonical)) {
    for (const name of WORKSPACE_METADATA_ROOTS) {
      const protectedRoot = resolve(workspace, name);
      if (canonical === protectedRoot || isInside(protectedRoot, canonical)) {
        violations.push(`workspace_${name.slice(1)}_root`);
      }
    }
  }
  violations.sort();
  return { canonicalTarget: canonical, violations };
}

export async function protectedMutationViolations(cwd: string, target: string): Promise<string[]> {
  return (await assessProtectedMutationPath(cwd, target)).violations;
}
