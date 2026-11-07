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
  // With -C the repository directory is the target (a linked worktree's `.git` is a pointer file that is not written).
  assert.deepEqual(scan("bash", "git -C sub clean -fdx"), { targets: [`write:${resolve(cwd, "sub")}`], uncertain: false });
  assert.deepEqual(scan("bash", "git worktree remove --force ../wt"),
    { targets: [`delete:${resolve(cwd, "../wt")}`, `write:${resolve(cwd, ".git")}`], uncertain: false });
  // `--delete` removes files inside the destination, not the directory (like `find -delete`): a `contents` target, never a root refusal.
  assert.deepEqual(scan("bash", "rsync -a --delete src/ dest/"), { targets: [`contents:${resolve(cwd, "dest")}`], uncertain: false });
  assert.deepEqual(scan("bash", "rsync -a --delete --exclude=.git ../build/ ."), { targets: [`contents:${cwd}`], uncertain: false });
  assert.deepEqual(scan("bash", "rsync -a src/ ../outside/b"), { targets: [`write:${resolve(cwd, "../outside/b")}`], uncertain: false });
  assert.deepEqual(scan("bash", "rsync -a src/ ../outside/ --max-delete 100"), { targets: [`write:${resolve(cwd, "../outside")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar -C out -xf a.tar"), { targets: [`write:${resolve(cwd, "out")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar xf a.tar"), { targets: [`write:${cwd}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar -xf a.tar -C../outside"), { targets: [`write:${resolve(cwd, "../outside")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar -xf a.tar -C out -C nested"), { targets: [`write:${resolve(cwd, "out/nested")}`], uncertain: false });
  assert.deepEqual(scan("bash", "git branch -D old"), { targets: [`write:${resolve(cwd, ".git")}`], uncertain: false });
  // Short options are read as tar reads them: `C` takes the next word inside a cluster, old-style letters take words in order.
  assert.deepEqual(scan("bash", "tar -xC ../outside -f a.tar"), { targets: [`write:${resolve(cwd, "../outside")}`], uncertain: false });
  assert.deepEqual(scan("bash", "tar xfC a.tar out"), { targets: [`write:${resolve(cwd, "out")}`], uncertain: false });
  // A bare worktree name may be a registered identifier elsewhere: the deleted directory is unknown, so the host asks.
  assert.deepEqual(scan("bash", "git worktree remove wt"), { targets: [`write:${resolve(cwd, ".git")}`], uncertain: true });
  // Reads, remote destinations and archive creation change nothing here.
  for (const command of ["tar -tfexample.tar", "git -C sub status", "git --no-pager branch --show-current", "git -C sub branch --show-current", "tar -xOf package.tgz package/package.json", "rsync -a dist/ user@host:/srv/www", "tar -czf out.tgz dist", "rsync -an --delete ../build/ .", "rsync -a --dry-run --delete src/ dest/"]) assert.equal(scan("bash", command), undefined, command);
});
