import { decodeCmdWord, lexCmd } from "./cmd.ts";
import { decodePowerShellWord, lexPowerShell } from "./powershell.ts";
import { DIALECT_POWERSHELL, fillSegmentWords, type SegmentWords, type ShellTokenTable } from "./token-table.ts";

export { DIALECT_CMD, DIALECT_POWERSHELL, type SegmentWords, ShellTokenTable } from "./token-table.ts";

/** Number of PowerShell and cmd tokenizations, for the parse-once evidence. */
export const windowsLexerCounters = { lexes: 0 };

export function lexWindowsScript(source: string, dialect: number): ShellTokenTable {
  windowsLexerCounters.lexes++;
  return dialect === DIALECT_POWERSHELL ? lexPowerShell(source) : lexCmd(source);
}

export function windowsWordText(table: ShellTokenTable, index: number): string {
  const start = table.starts[index]!, end = table.ends[index]!;
  return table.dialect === DIALECT_POWERSHELL ? decodePowerShellWord(table.source, start, end) : decodeCmdWord(table.source, start, end);
}

/** Refill a scanner's reusable word buffer with one segment of a PowerShell or cmd table. */
export function fillWindowsSegment(table: ShellTokenTable, segment: number, words: SegmentWords): void {
  fillSegmentWords(table, segment, words, windowsWordText);
}
