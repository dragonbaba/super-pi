/** One literal, standalone, single-quoted heredoc. Command bytes are unchanged
 * during execution; this view is only for the existing lifecycle/permission checks.
 * The 12 KiB bound also fits the installed Windows MSYS paired-backslash bridge.
 */
export const MAX_BOUND_SHELL_INPUT_BYTES = 12 * 1024;
export function boundedShellInput(command: string): { consumer: "cat" | "node"; kind: "data" | "code"; analysisCommand: string } | undefined {
  if (!command.includes("<<") || command.includes("\r") || command.includes("\0") || Buffer.byteLength(command, "utf8") > MAX_BOUND_SHELL_INPUT_BYTES) return undefined;
  const header = /^(cat|node)[ \t]+<<'([A-Za-z_][A-Za-z_0-9]{0,31})'[ \t]*\n/u.exec(command);
  if (!header) return undefined;
  const delimiter = header[2]!, ending = command.endsWith("\n") ? `${delimiter}\n` : delimiter;
  if (!command.endsWith(ending)) return undefined;
  const body = command.slice(header[0].length, command.length - ending.length);
  if (body && !body.endsWith("\n") || body.startsWith(`${delimiter}\n`) || body.includes(`\n${delimiter}\n`)) return undefined;
  const consumer = header[1] as "cat" | "node";
  // Source consumers go through exactly the same script checks as an explicit
  // node -e request. Quoted data is still a separately classified opaque input.
  return { consumer, kind: consumer === "node" ? "code" : "data",
    analysisCommand: consumer === "node" ? `node -e '${body.replaceAll("'", "'\"'\"'")}'` : "cat" };
}
