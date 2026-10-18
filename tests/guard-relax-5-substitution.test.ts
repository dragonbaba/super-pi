import assert from "node:assert/strict";
import test from "node:test";
import { assertFinalAuthorization, shellHookFixture } from "./codemode-recovery/shell-hook-fixture.ts";

const rows = [
  ["command substitution deletion", "echo $(rm -rf .git)", "protected_root"],
  ["function substitution deletion", "echo ${ rm -rf .git; }", "protected_root"],
  ["expanded heredoc deletion", "cat <<EOF\n$(rm -rf .git)\nEOF", "protected_root"],
  ["dynamic deletion target", "rm -rf $(mktemp -d)", "once"],
  ["readonly arithmetic and nested substitution", "echo $((1+2)) $(echo $((3+4)))", "allow"],
  ["bounded opaque substitution", "echo " + Array(17).fill("$(date)").join(" "), "opaque"],
  ["quoted subscript text is data", "grep -n 'items[$(i)]' src/a.js", "allow"],
  ["managed lifecycle still rejects detached substitution", "echo $(nohup node server.js &)", "lifecycle"],
  ["CR body retains managed lifecycle refusal", "bash <<'EOF'\nnpm run dev &\r\nEOF", "lifecycle"],
  ["unclosed substitution cannot hide a managed launch", "bash <<'EOF'\nnpm run dev &\nEOF\necho $(date", "lifecycle"],
  ["CR body without managed tasks uses permissions", "bash <<'EOF'\nnpm run dev &\r\nEOF", "opaque", false],
  ["unclosed substitution without managed tasks uses permissions", "bash <<'EOF'\nnpm run dev &\nEOF\necho $(date", "opaque", false],
  ["a nonblocking recursive result cannot hide a later segment", "bash -c 'echo $(date'; bash -c 'npm run dev &'", "lifecycle"],
] as const;
for (const [name, command, expected, managedTasks = true] of rows) test(`PR5 ${name}`, async t => {
  for (const mode of ["full-access", "workspace-write"] as const) {
    const fixture = await shellHookFixture(t, mode, undefined, managedTasks), ui = fixture.runner.getUIContext();
    fixture.runner.setUIContext({ ...ui, select: async (title, choices, context) => {
      if (expected === "once") assert.deepEqual(choices, ["仅允许本次", "拒绝并填写理由", "拒绝"]);
      return ui.select(title, choices, context);
    } }, "tui");
    const call = await fixture.authorize(command);
    if (expected === "protected_root" || expected === "lifecycle") {
      assert.equal(call.outcome?.block, true);
      assert.match(call.outcome!.reason!, expected === "protected_root" ? /protected_root/ : /Blocked an unmanaged long-lived process/);
      assert.equal(call.outcome?.finalAuthorization, undefined);
    } else assertFinalAuthorization(call);
    assert.equal(fixture.dialogs(), expected === "once" || expected === "opaque" && mode === "workspace-write" ? 1 : 0);
  }
});
