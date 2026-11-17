# Command interface retirement

## Problem and change

The redundant `structured_readonly_command` frontend imposed its own rg/Git executable list, argument classifier and file-existence prechecks before normal execution. Missing roots therefore failed before spawning, and the wrapper's generic error path obscured the actual execution distinction. Adding more command validation would amplify discovery/retry loops.

The frontend, dedicated runner/presentation/regexes, argv classifier, exact-command delegation, permission adapters and obsolete fixtures are retired. Native `grep`/`find`/`ls` handle file searches; ordinary Bash/PowerShell return actual execution facts for commands. Registered native search tools are core tools where the caller's selection permits them. Known-unavailable tools remain unavailable: startup respects catalog availability, and PowerShell retains explicit activation so startup does not probe it or write availability settings. No compatibility alias reruns a command through another tool.

The tool-loop guard no longer awaits a deterministic command-preparation hook. Existing duplicate/retry accounting, actual-failure diagnostics, workspace/cwd authorization, shared shell authorization analysis, browser/subagent grants, file revisions and cancellation remain. No new parser, executable/version probe, arbitrary limit or approval flow is introduced. Current schemas/manifests/lockfile/docs agree; historical design/probe records retain their anchors and are marked historical.

Native searches consume a canonical installed program path outside the primary and all additional workspaces. Scope is carried by the existing private native path grant and rechecked immediately before spawn. This rejects workspace binaries, PATH links into workspaces and unsafe managed installations without inspecting model command text. Searches never download/extract tools as a side effect; existing interactive setup owns bootstrap. Generic unscoped tool discovery and shell PATH/fallback semantics remain unchanged. The managed directory follows current configuration and is captured once per operation instead of being frozen at module import. Resolver metadata is call-owned and does not run `--version`, retain a PATH cache or affect model prefixes.

## Verification and allocation evidence

Production bundled discovery verifies that the retired tool is absent and native search tools are available. Native ls/read verify the fixture's file and text without depending on CI-installed fd/rg. A separate offline process places same-named programs in primary/additional workspaces, uses the isolated installed ripgrep dependency, and verifies one real canonical rg launch, zero availability/version processes, and zero launches after authorization changes during preparation. Resolver regressions cover fd/fdfind, workspace aliases, managed locations and no installer side effect. The existing unavailable-PowerShell control verifies that startup does not change its known-unavailable state. Policy/revocation, shell compatibility, source invariants and all-provider request-prefix tests cover the retained boundaries.

Initial local verification: `npm run check`, offline build **12/12**, and full suite **6,418 passed / 117 skipped / 0 failed across 470 units**, including the 10-API/14-configuration request-prefix matrix. Startup/configuration and result-budget recovery regressions verify no implicit PowerShell state write; obsolete frontend-only tests are retired while browser/subagent authority and revocation controls remain. The added executable-trust changes affect request setup and the pre-spawn boundary; normal grep/find output processing, progress and rendering paths add no allocations.

Final executable-trust/configuration verification: `npm run check`, offline build **12/12**, **6,423 passed / 117 skipped / 0 failed across 471 units**. Focused tests include 73 passes/1 platform skip for resolver, real native grep, scope authority, source invariants and grep configuration/context processing; the additional agent-root-change reproduction also passes. Real delegated CLI children retain four parent read-tool calls under every global execution default and compare availability using the same scoped contract.

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
node --experimental-strip-types --test tests/tools-manager.test.ts tests/native-search-trust.test.ts tests/grep-config-isolation.test.ts tests/grep-context-allocation.test.ts tests/grep-context-stream.test.ts
node --expose-gc --experimental-strip-types scripts/bench/tool-loop-repeat.ts
npm test -- --keep-going
```

Offline fixtures do not claim live provider/MCP/MXC execution.
