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

export function addShellEffect(scan: ShellMutationScan, kind: ShellEffectKind, path: string | undefined, destination?: string): void {
  scan.recognized = true;
  if (path === undefined || (kind === "copy" || kind === "move") && destination === undefined) { scan.uncertain = true; return; }
  for (const effect of scan.effects) if (effect.kind === kind && effect.path === path && effect.destination === destination) return;
  if (scan.effects.length >= MAX_SHELL_EFFECTS) { scan.uncertain = true; return; }
  scan.effects.push({ kind, path, destination });
}
