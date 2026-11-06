import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { inspectNativeShellMutations } from "../packages/coding-agent/src/core/shell-policy/native-mutations.ts";
import { shellAnalysisOwnership } from "../packages/coding-agent/src/core/shell-policy/shell-analysis.ts";
import { DIALECT_CMD, DIALECT_POWERSHELL, fillWindowsSegment, lexWindowsScript, windowsLexerCounters, type SegmentWords } from "../packages/coding-agent/src/core/shell-policy/syntax/windows.ts";

const B = String.raw;
const cwd = resolve("/work/proj");
const outside = (name: string) => resolve(cwd, "../outside", name);

function scan(tool: "bash" | "powershell", command: string) {
  const result = inspectNativeShellMutations(tool, { command }, cwd, 1);
  return result && { targets: result.targets.map(target => `${target.kind}:${target.target}`).sort(), uncertain: result.uncertain };
}

function segments(source: string, dialect: number): string[][] {
  const table = lexWindowsScript(source, dialect), words: SegmentWords = [], out: string[][] = [];
  for (let segment = 0; segment < table.segmentCount; segment++) { fillWindowsSegment(table, segment, words); out.push([...words]); }
  return out;
}

test("PowerShell and cmd tokens follow their own quoting, escapes and separators", () => {
  assert.deepEqual(segments(B`Remove-Item 'it''s\x' -Recurse; Get-Process 2>&1 > $null | Out-File ..\o\a.txt`, DIALECT_POWERSHELL), [
    ["Remove-Item", B`it's\x`, "-Recurse"], ["Get-Process", ">&", "1", ">", "/dev/null"], ["Out-File", B`..\o\a.txt`],
  ]);
  assert.deepEqual(segments("Set-Content \"a`\"b\" x && Remove-Item a` b.txt `\n  c.txt # note\n<# x #> & 'C:\\x.exe' a", DIALECT_POWERSHELL), [
    ["Set-Content", "a\"b", "x"], ["Remove-Item", "a b.txt", "c.txt"], [B`C:\x.exe`, "a"],
  ]);
  assert.deepEqual(segments("Set-Content -Path @'\n..\\h.txt\n'@ x", DIALECT_POWERSHELL), [["Set-Content", "-Path", B`..\h.txt`, "x"]]);
  assert.deepEqual(segments(B`@del ^"q.txt^" a.txt,..\x & echo x > nul 2>&1 && rd /s /q "a b"`, DIALECT_CMD), [
    ["del", "\"q.txt\"", "a.txt", B`..\x`], ["echo", "x", ">", "/dev/null", ">&", "1"], ["rd", "/s", "/q", "a b"],
  ]);
  const nested = lexWindowsScript(`Remove-Item $(Join-Path .. "z$(1)")`, DIALECT_POWERSHELL);
  assert.equal(nested.nestedCount, 1);
  assert.equal(nested.source.slice(nested.nestedStarts[0], nested.nestedEnds[0]), `Join-Path .. "z$(1)"`);
  assert.equal(lexWindowsScript("Remove-Item 'open", DIALECT_POWERSHELL).unterminated, true);
});

test("native PowerShell authorization reads quoting, here-strings, comments and null redirection as PowerShell does", () => {
  assert.deepEqual(scan("powershell", B`Remove-Item '../outside/it''s.txt'`), { targets: [`delete:${outside("it's.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", "Remove-Item `\n  ../outside/cont.txt"), { targets: [`delete:${outside("cont.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", "Set-Content -Path @'\n../outside/h.txt\n'@ x"), { targets: [`write:${outside("h.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", "Set-Content x.txt $(Get-Date); Remove-Item ../outside/q.txt"),
    { targets: [`delete:${outside("q.txt")}`, `write:${resolve(cwd, "x.txt")}`], uncertain: false });
  assert.equal(scan("powershell", "Get-Process > $null"), undefined);
  assert.equal(scan("powershell", "# Remove-Item ../outside/c\nGet-ChildItem"), undefined);
  assert.equal(scan("powershell", "Remove-Item $(Join-Path .. outside)")?.uncertain, true);
  // A PowerShell script inside Bash is read once, as PowerShell: no Bash-spelled duplicate target.
  assert.deepEqual(scan("bash", "pwsh -c 'Remove-Item ../outside/b.txt'"), { targets: [`delete:${outside("b.txt")}`], uncertain: false });
});

test("native authorization keeps Windows separators and cmd syntax without respelling", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(scan("powershell", "Remove-Item ..\\outside\\a` b.txt"), { targets: [`delete:${outside("a b.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", B`pwsh -NoProfile -Command "Remove-Item ..\outside\np.txt"`), { targets: [`delete:${outside("np.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", B`cmd /c "@del ..\outside\at.txt"`), { targets: [`delete:${outside("at.txt")}`], uncertain: false });
  assert.deepEqual(scan("powershell", B`cmd /c "del a.txt,..\outside\comma.txt"`),
    { targets: [`delete:${outside("comma.txt")}`, `delete:${resolve(cwd, "a.txt")}`], uncertain: false });
  assert.deepEqual(scan("bash", B`cmd /c 'rd /s /q ..\outside\x'`), { targets: [`delete:${outside("x")}`], uncertain: false });
  assert.deepEqual(scan("powershell", B`Remove-Item ~\x.txt`), { targets: [`delete:${resolve(homedir(), "x.txt")}`], uncertain: false });
});

test("each PowerShell or cmd source is tokenized once per authorization and released afterwards", () => {
  const lexes = windowsLexerCounters.lexes, owners = shellAnalysisOwnership.liveOwners, entries = shellAnalysisOwnership.liveEntries, bytes = shellAnalysisOwnership.liveBytes;
  // Both scanners read the root PowerShell script, the nested cmd script and the $(...) body.
  scan("powershell", `Remove-Item ../outside/a.txt; cmd /c "del b.txt"; Set-Content $(Get-Date) x`);
  assert.equal(windowsLexerCounters.lexes - lexes, 3);
  assert.equal(shellAnalysisOwnership.liveOwners, owners);
  assert.equal(shellAnalysisOwnership.liveEntries, entries);
  assert.equal(shellAnalysisOwnership.liveBytes, bytes);
});

test("PowerShell and cmd lexers allocate no callbacks, literals or temporary containers", () => {
  const allowed = new Set(["charCodeAt", "indexOf", "slice", "charAt", "pushToken", "endSegment", "pushNested", "segmentStart", "isNaN"]);
  for (const file of ["powershell.ts", "cmd.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(`packages/coding-agent/src/core/shell-policy/syntax/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
    let functions = 0;
    function audit(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
        || ts.isRegularExpressionLiteral(node) || ts.isSpreadElement(node) || ts.isTemplateExpression(node), false, `${file}: ${node.getText(source)}`);
      if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "ShellTokenTable", `${file}: ${node.getText(source)}`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(allowed.has(node.expression.name.text), `${file}: ${node.getText(source)}`);
      ts.forEachChild(node, audit);
    }
    for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.body) { functions++; ts.forEachChild(statement.body, audit); }
    assert.ok(functions >= 8, file);
  }
});
