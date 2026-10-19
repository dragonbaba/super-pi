import assert from "node:assert/strict";
import test from "node:test";
import { assertFinalAuthorization, shellHookFixture } from "./codemode-recovery/shell-hook-fixture.ts";

const rows = [
  ["dynamic eval before background", 'eval "$X"; bash -c \'npm run dev &\'', "background"],
  ["arithmetic before background", "(( i++ )); bash -c 'npm run dev &'", "background"],
  ["dynamic shell before background", 'bash -c "$X"; bash -c \'npm run dev &\'', "background"],
  ["dynamic eval remains opaque", 'eval "$X"', "opaque"],
  ["dynamic shell remains opaque", 'bash -c "$X"', "opaque"],
  ["dynamic executable remains opaque", "$CMD build", "opaque"],
  ["assignment and literal script retain permission flow", "x=1; bash -c 'echo hi'", "opaque"],
  ["dynamic eval cannot hide protected root", 'eval "$X"; rm -rf .git', "protected_root"],
  ["dynamic eval cannot hide native routing", 'eval "$X"; powershell -Command "Write-Output ok"', "LAUNCHER_UNSUPPORTED"],
] as const;
for (const [name, command, expected] of rows) test(`PR7 ${name}`, async t => {
  for (const [mode, managed] of [["full-access", false], ["workspace-write", false], ["full-access", true], ["workspace-write", true]] as const) {
    const fixture = await shellHookFixture(t, mode, "active", managed), call = await fixture.authorize(command);
    const blocked = expected === "protected_root" || expected === "LAUNCHER_UNSUPPORTED" || expected === "background" && managed;
    if (blocked) {
      assert.equal(call.outcome?.block, true);
      assert.ok(call.outcome!.reason!.includes(expected === "background" ? "Blocked an unmanaged long-lived process" : expected));
      assert.equal(call.outcome?.finalAuthorization, undefined);
    } else assertFinalAuthorization(call);
    assert.equal(fixture.dialogs(), !blocked && mode === "workspace-write" ? 1 : 0);
  }
});
