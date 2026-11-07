import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { inspectNativeShellMutations } from "../packages/coding-agent/src/core/shell-policy/native-mutations.ts";

const cwd = resolve("/work/proj");

function scan(tool: "bash" | "powershell", command: string) {
  const result = inspectNativeShellMutations(tool, { command }, cwd, 1);
  return result && { targets: result.targets.map(target => `${target.kind}:${target.target}`).sort(), uncertain: result.uncertain };
}

test("a PowerShell location change makes later targets uncertain, like Bash cd", () => {
  // `Set-Location sub` moved the working directory, so `x.txt` is not `<cwd>/x.txt`; the host asks.
  assert.equal(scan("powershell", "Set-Location sub; Remove-Item x.txt")?.uncertain, true);
  assert.equal(scan("powershell", "Pop-Location; Remove-Item x.txt")?.uncertain, true);
  // A target before the change and a read after it keep their old results.
  assert.deepEqual(scan("powershell", "Remove-Item x.txt; Set-Location sub"), { targets: [`delete:${resolve(cwd, "x.txt")}`], uncertain: false });
  assert.equal(scan("powershell", "Set-Location -Path sub; Get-ChildItem"), undefined);
});

test("git -C, worktree remove, rsync and tar extraction name the directory they change", () => {
  assert.deepEqual(scan("bash", "git -C sub clean -fdx"), { targets: [`write:${resolve(cwd, "sub/.git")}`], uncertain: false });
  assert.deepEqual(scan("bash", "git worktree remove --force ../wt"),
    { targets: [`delete:${resolve(cwd, "../wt")}`, `write:${resolve(cwd, ".git")}`], uncertain: false });
  assert.deepEqual(scan("bash", "rsync -a --delete src/ dest/"), { targets: [`delete:${resolve(cwd, "dest")}`], uncertain: false });
  assert.deepEqual(scan("bash", "rsync -a src/ ../outside/b"), { targets: [`write:${resolve(cwd, "../outside/b")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar -C out -xf a.tar"), { targets: [`write:${resolve(cwd, "out")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar xf a.tar"), { targets: [`write:${cwd}`], uncertain: false });
  // Reads, remote destinations and archive creation change nothing here.
  for (const command of ["git -C sub status", "rsync -a dist/ user@host:/srv/www", "tar -czf out.tgz dist"]) assert.equal(scan("bash", command), undefined, command);
});
