import assert from "node:assert/strict";
import test from "node:test";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { MAX_ANALYSIS_BYTES, MAX_ANALYSIS_ENTRIES, ShellAnalysisOwner } from "../packages/extensions/resource-lifecycle-guard/shell-analysis.ts";
import { shellAnalysisCounters } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
import { shellHookFixture, assertFinalAuthorization } from "./codemode-recovery/shell-hook-fixture.ts";

for (const command of ["export PATH=/usr/bin:$PATH; node -v", "source .venv/bin/activate && python --version", "(cd sub && make)", "echo $((UNRESOLVED_VALUE))", '"$FFMPEG" -version']) {
  test(`unknown state without an identified mutation follows permission mode: ${command}`, async t => {
    const high = inspectHighRiskBashMutation({ command }, process.cwd());
    assert.notEqual(high?.mutationDetected, true);
    assert.notEqual(high?.unverifiableScope, true);
    assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
    for (const mode of ["full-access", "workspace-write"] as const) {
      const fixture = await shellHookFixture(t, mode);
      assertFinalAuthorization(await fixture.authorize(command));
      assert.equal(fixture.dialogs(), mode === "full-access" ? 0 : 1);
    }
  });
}

test("standalone arithmetic retains main's lifecycle refusal even without visible substitution", async t => {
  for (const command of ["((PATH=0)); cat", "(( 1+1 ))", "(( x ))"]) {
    for (const mode of ["full-access", "workspace-write"] as const) {
      const fixture = await shellHookFixture(t, mode), { outcome } = await fixture.authorize(command);
      assert.equal(outcome?.block, true); assert.equal(outcome?.finalAuthorization, undefined);
      assert.match(outcome?.reason ?? "", /\[SHELL_UNINSPECTABLE\]/); assert.equal(fixture.dialogs(), 0);
    }
  }
});

for (const command of ['rm -rf "$X"', 'rm "$X"', 'printf x > "$X"', "source missing; rm -rf target", "(cd sub && make); printf x > target", "cd sub; touch target", "export PATH=/tmp; rm -rf target", 'sort -o "$X"', 'sort --output="$X"', 'find . -fprint "$X"', "(cd sub); sort -o target", "(cd sub); find . -fprintf target '%p'"]) {
  test(`identified mutation with unknown target or cwd cannot be approved: ${command}`, async t => {
    for (const mode of ["full-access", "workspace-write"] as const) {
      const fixture = await shellHookFixture(t, mode);
      const { outcome } = await fixture.authorize(command);
      assert.equal(outcome?.block, true, command);
      assert.equal(outcome?.finalAuthorization, undefined);
      assert.equal(fixture.dialogs(), 0);
    }
  });
}

test("one authorization reuses actual scanners across preflight, mutation and permission", () => {
  const command = "printf '%s' \"$(git rev-parse HEAD)\"", cwd = process.cwd();
  const owner = new ShellAnalysisOwner(command, cwd, 7);
  const before = { ...shellAnalysisCounters };
  try {
    owner.assertCurrent(command, cwd, 7);
    assert.equal(inspectBashResourceLifecycle({ command }, false, owner), undefined);
    inspectHighRiskBashMutation({ command }, cwd, "bash", owner);
    inspectBashPermissionScope({ command }, cwd, owner);
    assert.equal(owner.size, 2);
    assert.equal(owner.misses, 2);
    assert.equal(owner.hits, 4);
    assert.equal(shellAnalysisCounters.prepareCalls - before.prepareCalls, 2);
    assert.equal(shellAnalysisCounters.substitutionCalls - before.substitutionCalls, 2);
    const bytes = 2 * (command.length + "git rev-parse HEAD".length);
    assert.equal(shellAnalysisCounters.prepareInputBytes - before.prepareInputBytes, bytes);
    assert.equal(shellAnalysisCounters.substitutionInputBytes - before.substitutionInputBytes, bytes);
  } finally { owner.release(); }
  assert.equal(owner.size, 0);
  assert.equal(owner.retainedBytes, 0);
  assert.throws(() => owner.get(command), /released/);
});

test("command, cwd and permission generation changes invalidate every retained analysis", () => {
  for (const [command, cwd, generation] of [["printf changed", "cwd", 1], ["printf ok", "other", 1], ["printf ok", "cwd", 2]] as const) {
    const owner = new ShellAnalysisOwner("printf ok", "cwd", 1);
    owner.get("printf ok");
    assert.throws(() => owner.assertCurrent(command, cwd, generation), /SHELL_ANALYSIS_CHANGED/);
    assert.equal(owner.size, 0);
    assert.equal(owner.retainedBytes, 0);
    const fresh = new ShellAnalysisOwner(command, cwd, generation);
    const before = shellAnalysisCounters.prepareCalls;
    try { fresh.get(command); assert.equal(shellAnalysisCounters.prepareCalls, before + 1); }
    finally { fresh.release(); }
  }
});

test("authorization analysis capacity is bounded and overflow never skips inspection", () => {
  const owner = new ShellAnalysisOwner("root", "cwd", 0);
  try {
    for (let i = 0; i <= MAX_ANALYSIS_ENTRIES; i++) owner.get(`printf ${i}`);
    assert.equal(owner.size, MAX_ANALYSIS_ENTRIES);
    assert.equal(owner.overflows, 1);
    const before = shellAnalysisCounters.prepareCalls;
    owner.get("x".repeat(MAX_ANALYSIS_BYTES));
    assert.equal(shellAnalysisCounters.prepareCalls, before + 1);
    assert.ok(owner.retainedBytes <= MAX_ANALYSIS_BYTES);
  } finally { owner.release(); }
  assert.equal(owner.size, 0);
  assert.equal(owner.retainedBytes, 0);
});

test("bounded heredoc data cannot hide visible lifecycle violations or create fake ones", () => {
  assert.equal(inspectBashResourceLifecycle({ command: "cat > f <<'EOF'\nnohup node server.js &\nEOF" }), undefined);
  for (const command of ["export PATH=/tmp; npm run dev &", "cat <<EOF\n$(nohup node server.js)\nEOF", "cat <<'EOF'\ndata\nEOF\nnohup node server.js"]) {
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /Blocked an unmanaged long-lived process/);
  }
});

test("masked multiline heredoc keeps service launches at following boundaries visible", () => {
  const data = `cat > out <<'EOF'\n${"literal data & $HOME\n".repeat(512)}EOF`;
  assert.equal(inspectBashResourceLifecycle({ command: data }), undefined);
  for (const suffix of ["\n  systemctl start daemon", "\r\n\t sudo service daemon start", "; pm2 serve ./site"]) {
    assert.match(inspectBashResourceLifecycle({ command: data + "\n" + suffix }) ?? "", /Blocked an unmanaged long-lived process/);
  }
});

test("each executable heredoc keeps its own consumer and cannot borrow an earlier cwd", async t => {
  const detached = "cat <<A; bash <<'B'\ndata\nA\nnohup node server.js\nB";
  assert.match(inspectBashResourceLifecycle({ command: detached }) ?? "", /Blocked an unmanaged long-lived process/);
  for (const command of ["bash <<'EOF'\nrm \"$X\"\nEOF", "cat <<A; bash <<'B'\ndata\nA\nrm \"$X\"\nB", "cd sub && bash <<'EOF'\ntouch target\nEOF", "cd sub && printf ready\nbash <<'EOF'\nrm -rf target\nEOF"]) {
    for (const mode of ["full-access", "workspace-write"] as const) {
      const fixture = await shellHookFixture(t, mode);
      const { outcome } = await fixture.authorize(command);
      assert.equal(outcome?.block, true, command);
      assert.equal(outcome?.finalAuthorization, undefined);
      assert.equal(fixture.dialogs(), 0);
    }
  }
});
