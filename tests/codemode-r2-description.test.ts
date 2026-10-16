import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_DESCRIPTION } from "../packages/coding-agent/src/core/codemode-constants.ts";

test("R2.5 instructions explain explicit failure handling, display limits and script-local refs", () => {
  for (const term of ["allowFailure:true", "tool_call", "handled count", "current script", "evicted:true", "recovery unavailable", "5 MiB", "Do not re-run completed mutations"]) {
    assert.ok(CODEMODE_DESCRIPTION.includes(term), term);
  }
});
