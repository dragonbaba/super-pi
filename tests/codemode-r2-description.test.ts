import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_DESCRIPTION } from "../packages/coding-agent/src/core/codemode-constants.ts";

test("instructions explain native failure handling, batching, display limits and script-local refs", () => {
  for (const term of ["allowFailure:true", "tool_call", "Promise.allSettled", "PARTIAL", "Single calls remain valid", "current script", "evicted:true", "recovery unavailable", "5 MiB", "Do not re-run completed mutations"]) {
    assert.ok(CODEMODE_DESCRIPTION.includes(term), term);
  }
});
