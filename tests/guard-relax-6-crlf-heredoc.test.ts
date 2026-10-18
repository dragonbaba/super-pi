import assert from "node:assert/strict";
import test from "node:test";
import { prepareShellAnalysis } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
import { assertFinalAuthorization, shellHookFixture } from "./codemode-recovery/shell-hook-fixture.ts";

const rows = [
  ["protected root in CRLF body", "bash <<'EOF'\r\nrm -rf .git\r\nEOF\r\n", "protected_root"],
  ["protected root after CRLF delimiter", "cat <<'EOF'\r\nhi\r\nEOF\r\nrm -rf .git\r\n", "protected_root"],
  ["background launch in CRLF body", "bash <<'EOF'\r\nnpm run dev &\r\nEOF\r\n", "background"],
  ["background launch after CRLF delimiter", "cat <<'EOF'\r\nhi\r\nEOF\r\nnpm run dev &\r\n", "background"],
  ["high-risk CRLF body needs one-time approval", "bash <<'EOF'\r\nrm -rf node_modules\r\nEOF\r\n", "once"],
  ["LF declaration with CRLF delimiter", "cat <<'EOF'\nhi\nEOF\r\nnpm run dev &\n", "background"],
  ["batch-file body remains data", "cat > run.bat <<'EOF'\r\nstart server & echo ok\r\nEOF\r\n", "once"],
  ["LF commit-message substitution is unchanged", "git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"", "opaque"],
] as const;
for (const [name, command, expected] of rows) test(`PR6 ${name}`, async t => {
  if (command.includes("\r")) {
    const view = prepareShellAnalysis(command);
    assert.equal(view.uncertain, true);
    assert.equal(view.hereDocuments?.length, 1, "CR must not discard the bounded body");
  }
  for (const [mode, managed] of [["full-access", false], ["workspace-write", false], ["full-access", true], ["workspace-write", true]] as const) {
    const fixture = await shellHookFixture(t, mode, undefined, managed), ui = fixture.runner.getUIContext();
    fixture.runner.setUIContext({ ...ui, select: async (title, choices, context) => {
      if (expected === "once") assert.deepEqual(choices, ["仅允许本次", "拒绝并填写理由", "拒绝"]);
      return ui.select(title, choices, context);
    } }, "tui");
    const call = await fixture.authorize(command);
    const blocked = expected === "protected_root" || expected === "background" && managed;
    if (blocked) {
      assert.equal(call.outcome?.block, true);
      assert.match(call.outcome!.reason!, expected === "protected_root" ? /protected_root/ : /Blocked an unmanaged long-lived process/);
      assert.equal(call.outcome?.finalAuthorization, undefined);
    } else assertFinalAuthorization(call);
    assert.equal(fixture.dialogs(), !blocked && (expected === "once" || mode === "workspace-write") ? 1 : 0);
  }
});
