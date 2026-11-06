import assert from "node:assert/strict";
import test from "node:test";
import { inspectPowerShellPermissionScope } from "../packages/coding-agent/src/core/shell-policy/permission-powershell.ts";
import { findNonReadOnlyShellSegment, readOnlyShellCounters } from "../packages/coding-agent/src/core/shell-policy/readonly-command.ts";
import { ShellAnalysisOwner } from "../packages/coding-agent/src/core/shell-policy/shell-analysis.ts";
import { windowsLexerCounters } from "../packages/coding-agent/src/core/shell-policy/syntax/windows.ts";
import { isSafeCommand } from "../packages/plan-mode/src/tool-policy.ts";

test("Bash: listed readers joined by lists and pipes are read-only; the first other segment is reported as written", () => {
  for (const command of [
    "ls -la", "git status && git log --oneline -5", "rg -n foo src | head -20", "cat a.txt; wc -l b.txt\nls",
    "grep -i todo *.ts 2>/dev/null", "cd sub && git diff --stat 2>&1 | tail -3", "find . -name '*.ts' -type f",
    "git branch --list 'feat/*'", "sed -n 1,20p notes.md", "sort < input.txt", "git rev-parse HEAD",
  ]) assert.equal(findNonReadOnlyShellSegment("bash", command), undefined, command);
  for (const [command, blocked] of [
    ["ls && rm -rf dist", "rm -rf dist"], ["echo hi > out.txt", "echo hi > out.txt"], ["cat \"$FILE\"", "cat \"$FILE\""],
    ["echo $(rm x)", "echo $(rm x)"], ["PAGER=less git log", "PAGER=less git log"], ["ls; (cd x && ls)", "cd x"], ["sleep 1 &", "sleep 1"],
    ["find . -name x -delete", "find . -name x -delete"], ["sort -o out.txt in.txt", "sort -o out.txt in.txt"], ["git branch topic", "git branch topic"],
    ["sed -i s/a/b/ f", "sed -i s/a/b/ f"], ["cat <<EOF\nx\nEOF", "cat <<EOF"], ["git describe", "git describe"],
  ]) assert.equal(findNonReadOnlyShellSegment("bash", command), blocked, command);
  assert.equal(findNonReadOnlyShellSegment("bash", "echo 'open"), "echo 'open");
  assert.equal(findNonReadOnlyShellSegment("bash", "  "), "(empty command)");
  // Plan mode's opt-in subcommands widen the list only for the named ones.
  assert.equal(findNonReadOnlyShellSegment("bash", "git describe --tags", { git: ["describe"] }), undefined);
  assert.equal(isSafeCommand("gh pr view 1 --json title"), false);
  assert.equal(isSafeCommand("gh pr view 1 --json title", { gh: ["pr view"] }), true);
});

test("PowerShell: file readers, formatters and listed programs are read-only; code, providers and writes are not", () => {
  for (const command of [
    "Get-ChildItem -Recurse *.ts | Select-Object -First 5", "Get-Content a.txt 2>&1 | Select-String TODO", "git status; rg foo",
    "Get-ChildItem > $null", "cd src; ls", "Get-ChildItem C:\\work\\proj",
  ]) assert.equal(findNonReadOnlyShellSegment("powershell", command), undefined, command);
  for (const [command, blocked] of [
    ["Get-ChildItem; Remove-Item x", "Remove-Item x"], ["Get-Content $env:FILE", "Get-Content $env:FILE"], ["Get-Item (Join-Path a b)", "Get-Item"],
    ["Get-ChildItem | ForEach-Object { Remove-Item $_ }", "ForEach-Object { Remove-Item $_ }"], ["Get-Content x > out.txt", "Get-Content x > out.txt"],
    ["Get-ChildItem env:", "Get-ChildItem env:"],
  ]) assert.equal(findNonReadOnlyShellSegment("powershell", command), blocked, command);
  // A subexpression body is a script of its own; the whole command is reported.
  assert.equal(findNonReadOnlyShellSegment("powershell", "Write-Output $(Remove-Item x)"), "Write-Output $(Remove-Item x)");
});

test("the PowerShell permission scope and the read-only judgment share one table per authorization", () => {
  const command = "git status; Get-ChildItem -Recurse | Select-Object -First 3", owner = new ShellAnalysisOwner(command, process.cwd(), 1);
  const lexes = windowsLexerCounters.lexes, judgments = readOnlyShellCounters.judgments;
  try {
    assert.equal(inspectPowerShellPermissionScope({ command }, process.cwd(), owner)?.kind, "read-only");
    assert.equal(findNonReadOnlyShellSegment("powershell", command, undefined, owner), undefined);
  } finally { owner.release(); }
  assert.equal(readOnlyShellCounters.judgments - judgments, 2);
  assert.equal(windowsLexerCounters.lexes - lexes, 1);
  assert.equal(owner.size, 0);
});
