export type FastCommandAction = "toggle" | "on" | "off" | "invalid";

export function parseFastCommand(args: string): FastCommandAction {
  const value = args.trim().toLowerCase();
  if (!value) return "toggle";
  if (value === "on") return "on";
  if (value === "off") return "off";
  return "invalid";
}

export function resolveFastEnabled(current: boolean, action: FastCommandAction): boolean {
  if (action === "on") return true;
  if (action === "off") return false;
  return !current;
}
