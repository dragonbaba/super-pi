import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { assertFinalAuthorization, shellHookFixture } from "./codemode-recovery/shell-hook-fixture.ts";

test("PR4 representative heredoc language-presence acceptance", async t => {
  const doc = (header: string, body: string, delimiter = "'EOF'") => `${header} <<${delimiter}\n${body}\nEOF`;
  type Result = "deny" | "lifecycle" | "once" | "allow";
  const rows: readonly (readonly [string, Result])[] = [
    [doc("bash", "rm -rf .git"), "deny"], [doc("sh -s", "rm -rf .git"), "deny"],
    ["cat <<'EOF' | bash\nrm -rf .git\nEOF", "deny"],
    [doc("python3 -", "shutil.rmtree('.git')"), "deny"],
    [doc("node", "fs.rmSync('.git',{recursive:true})"), "deny"],
    ["exec 3<<'EOF'\nrm -rf .git\nEOF\nbash /dev/fd/3", "deny"],
    ["bash /dev/fd/3 3<<'EOF'\nrm -rf .git\nEOF", "deny"],
    [doc("f() { bash; }; f", "rm -rf .git"), "deny"],
    [doc("source /dev/stdin", "rm -rf .git"), "deny"],
    [doc("bash", "rm -rf .git\r"), "deny"],
    [doc("bash", "rm -rf $BUILD_DIR"), "once"],
    [doc("cd .. && bash", "rm -rf __workspace_name__"), "once"],
    [doc("bash", "npm test"), "allow"], [doc("bash", "rm -rf node_modules"), "allow"],
    [doc("bash", "echo $HOME", "EOF"), "allow"], [doc("python3 -", "print(1)"), "allow"],
    [doc("cat > notes.md", "rm -rf .git"), "allow"],
    [doc("cat > notes.md", "rm -rf $BUILD_DIR"), "allow"],
    [doc("git commit -F -", "fix: rm -rf ~ handling"), "allow"],
    [doc("tee out.txt", "ordinary data"), "allow"],
    [doc("bash", "npm run dev &"), "lifecycle"],
    ["cat <<'EOF' | bash\nnohup node s.js &\nEOF", "lifecycle"],
    [doc("cat > notes.md", "npm run dev &"), "allow"],
    ["cat <<'EOF' > a.sh\nrm -rf .git\nEOF\nbash a.sh", "deny"],
    // Transform decoding is an accepted boundary (#161).
    ["base64 -d <<'EOF' | bash\ncm0gLXJmIC5naXQK\nEOF", "allow"],
  ];
  for (const [command, expected] of rows) for (const mode of ["full-access", "workspace-write"] as const) {
    const fixture = await shellHookFixture(t, mode, undefined, true);
    const ui = fixture.runner.getUIContext();
    fixture.runner.setUIContext({ ...ui, select: async (title, choices, context) => {
      if (expected === "once") assert.deepEqual(choices, ["仅允许本次", "拒绝并填写理由", "拒绝"]);
      return ui.select(title, choices, context);
    } }, "tui");
    const call = await fixture.authorize(command.replace("__workspace_name__", basename(fixture.cwd))), label = `${mode}: ${command}`;
    if (expected === "deny" || expected === "lifecycle") {
      assert.equal(call.outcome?.block, true, label);
      assert.equal(call.outcome?.finalAuthorization, undefined, label);
      assert.match(call.outcome!.reason!, expected === "deny" ? /protected_root/ : /Blocked an unmanaged long-lived process/);
    } else assertFinalAuthorization(call);
    assert.equal(fixture.dialogs(), expected === "once" || expected === "allow" && mode === "workspace-write" ? 1 : 0, label);
  }
});
