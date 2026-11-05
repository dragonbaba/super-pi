/** Bounded operation facts. Unknown source remains opaque unless an effect is recognized. */
export type ShellEffectKind = "delete" | "delete-contents" | "write" | "create" | "copy" | "move" | "git-clean" | "git-reset";
export interface ShellEffect { kind: ShellEffectKind; path: string; destination?: string; }
export interface ShellMutationScan {
  effects: ShellEffect[];
  recognized: boolean;
  uncertain: boolean;
}
export const MAX_SHELL_EFFECTS = 16;
export const MAX_SHELL_SOURCE_CHARS = 128 * 1024;
export const MAX_SHELL_SEGMENTS = 64;
export const MAX_SHELL_DEPTH = 4;

/** A named component may be a symlink: lexical `name/..` cannot prove its filesystem target. */
export function hasUnresolvedParentPath(path: string): boolean {
  let start = 0, named = false;
  for (let index = 0; index <= path.length; index++) {
    const code = path.charCodeAt(index);
    if (index < path.length && code !== 47 && code !== 92) continue;
    const length = index - start;
    if (length === 2 && path.charCodeAt(start) === 46 && path.charCodeAt(start + 1) === 46) {
      if (named) return true;
    } else if (length > 0 && !(length === 1 && path.charCodeAt(start) === 46)) named = true;
    start = index + 1;
  }
  return false;
}

export function addShellEffect(scan: ShellMutationScan, kind: ShellEffectKind, path: string | undefined, destination?: string): void {
  scan.recognized = true;
  if (path === undefined || (kind === "copy" || kind === "move") && destination === undefined) {
    scan.uncertain = true;
    // Unknown source basenames do not hide a known protected/overwritten destination.
    if ((kind === "copy" || kind === "move") && destination !== undefined) addShellEffect(scan, "write", destination);
    return;
  }
  for (const effect of scan.effects) if (effect.kind === kind && effect.path === path && effect.destination === destination) return;
  if (scan.effects.length >= MAX_SHELL_EFFECTS) { scan.uncertain = true; return; }
  scan.effects.push({ kind, path, destination });
}
