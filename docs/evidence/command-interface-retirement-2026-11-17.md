# Command interface retirement

## Problem and change

The redundant `structured_readonly_command` frontend imposed its own rg/Git executable list, argument classifier and file-existence prechecks before normal execution. Missing roots therefore failed before spawning, and the wrapper's generic error path obscured the actual execution distinction. Adding more command validation would amplify discovery/retry loops.

The frontend, dedicated runner/presentation/regexes, argv classifier, exact-command delegation, permission adapters and obsolete fixtures are retired. Native `grep`/`find`/`ls` handle file searches; ordinary Bash/PowerShell return actual execution facts for commands. Registered native search tools are core tools where the caller's selection permits them. Known-unavailable tools remain unavailable: startup respects catalog availability, and PowerShell retains explicit activation so startup does not probe it or write availability settings. No compatibility alias reruns a command through another tool.

The tool-loop guard no longer awaits a deterministic command-preparation hook. Existing duplicate/retry accounting, actual-failure diagnostics, workspace/cwd authorization, shared shell authorization analysis, browser/subagent grants, file revisions and cancellation remain. No new parser, executable/version probe, arbitrary limit or approval flow is introduced. Current schemas/manifests/lockfile/docs agree; historical design/probe records retain their anchors and are marked historical.

## Verification and allocation evidence

Production bundled discovery verifies that the retired tool is absent and native search tools are available. Real native find/grep calls locate the fixture's file and text. The existing unavailable-PowerShell control verifies that startup does not change its known-unavailable state. Policy/revocation, shell compatibility, source invariants and all-provider request-prefix tests cover the retained boundaries.

Final local verification: `npm run check`, offline build **12/12**, and full suite **6,418 passed / 117 skipped / 0 failed across 470 units**, including the 10-API/14-configuration request-prefix matrix. Startup/configuration and result-budget recovery regressions verify no implicit PowerShell state write; obsolete frontend-only tests are retired while browser/subagent authority and revocation controls remain.

Audited admission chain: `tool_call` → pending CallLedger → input hash → duplicate/retry admission → `tool_result` classification/advisory → child/parent/agent-end release. Removing one async preparation invocation removes its Promise boundary per admitted call. No new per-progress/delta/frame callback, Promise, AbortController, wrapper or full-input serialization is added. Existing capacities and metadata-only ownership remain; no pool is used.

Same-machine Windows/Node 26.13.0, exact pre-change commit versus candidate, identical driver with 32 warmups and 256 successful calls per input size:

| Input UTF-16 units | Sampled bytes/call before → after | CPU µs before → after | p95 ms before → after | Sampled peak heap before → after |
| --- | --- | --- | --- | --- |
| 64 | 6,451.72 → 5,813.66 | 0 → 0 (CPU timer quantization) | 0.0167 → 0.0183 | 56,505,352 → 48,161,528 |
| 1,048,576 | 21,774.63 → 21,872.13 | 281,000 → 297,000 | 1.1627 → 1.2287 | 60,978,232 → 53,084,496 |

Both workloads retain identical admission hash counts/bytes, 256 admission digests, zero result re-hashing and zero unexpected advisories. Baseline/candidate module-loading footprints differ; absolute heap and timing are observations, not proof of improvement. The candidate's separate normal/failure/parent-cancel/admission-cancel/retry lifecycle run tracks 288 owners and retains **0** after controlled GC. Leading allocation sites remain input hash chunks, benchmark invocation and bounded hook bookkeeping. No speedup is claimed from retiring an API or from these noisy timing samples.

Rerun:

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/bundled-extensions.test.ts tests/native-execution-policy.test.ts tests/permission-interaction.test.ts tests/tool-loop-repeat.test.ts tests/tool-loop-repeat-hot-paths.test.ts tests/source-invariants.test.ts tests/codemode-session.test.ts tests/shell-cd-find-compatibility.test.ts
node --expose-gc --experimental-strip-types scripts/bench/tool-loop-repeat.ts
npm test -- --keep-going
```

Offline fixtures do not claim live provider/MCP/MXC execution.
