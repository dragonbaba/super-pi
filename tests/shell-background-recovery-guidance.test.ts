import assert from "node:assert/strict";
import test from "node:test";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";

test("lifecycle refusal preserves matcher prefix and names managed background prerequisites", () => {
  for (const command of ["npm run dev &", "nohup node server.js", "docker run -d alpine"]) {
    const reason = inspectBashResourceLifecycle({ command })!;
    assert.ok(reason.startsWith("Blocked an unmanaged long-lived process"));
    assert.match(reason, /background: true/);
    assert.match(reason, /explicit cwd/);
    assert.match(reason, /TUI\/RPC/);
    assert.match(reason, /tasks tool/);
    assert.match(reason, /command itself foreground/);
    assert.match(reason, /Otherwise use foreground/);
  }
});
