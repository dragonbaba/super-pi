# Independent CodeMode batch calls

## Problem and change

An ordinary child failure inside fail-fast `Promise.all` can end the script and cancel unrelated pending work. Standard Promise semantics remain correct and unchanged; callers need an explicit independent-work interface.

`batch([{tool,args,review?},...])` calls the ordinary owner `callTool` bridge for each item with `allowFailure:true`. Ordinary failures return per-item results while other independent calls complete. The summary contains completion/failure counts and only failed items' index, tool, result reference and concise failure reason. Original results remain available to the script. Completed items are never automatically retried. Shell completion still requires checking the real exit code/application status.

Each item retains normal authorization, scheduling and bridge call accounting. `review:true` forwards the item's usual risk review. Cancellation, uncertain/verification-required outcomes and observation failures remain fatal; the helper does not catch them into successful continuation. Descriptor-shape validation covers only the helper API; no command parsing, path precheck, executable probing, allowlist or new limit is added. Dependent operations remain separate awaited steps.

## Verification

Production fixtures cover a failing ordinary item between two successful items, a delayed last item that is not aborted, persistence without replay, fatal uncertainty with no store commit, user cancellation, empty/malformed descriptors, review metadata and immutable dispatch identity, and the unchanged 256-call bridge budget. A real native missing-read + Node command fixture verifies that the read failure cannot cancel the independent command; its counter remains one and exit/capture facts remain successful.

Local `npm run check`, all 12 offline package builds and the full suite passed: **6,421 passed, 117 skipped, 0 failed across 470 units**. This includes the existing all-provider request-prefix matrix and ordinary Promise/cancellation controls. Validation is offline; no live provider/MCP/MXC execution is claimed.

This change touches explicit batch setup and VM startup only, not provider-delta, tool-progress, rendering, terminal-frame or large-result processing paths. No hot-path benchmark or performance improvement is claimed. No callback is created per item: the VM owns one named async item function and one batch function, with per-call promises/results released on completion or VM teardown. Existing runtime/cancellation, source gates and provider-prefix matrix remain applicable.

Rerun:

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/codemode-independent-batch.test.ts tests/codemode-partial-results.test.ts tests/codemode-runtime.test.ts tests/codemode-hot-paths.test.ts tests/codemode-session.test.ts
npm test -- --keep-going
```
