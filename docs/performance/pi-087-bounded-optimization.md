# Pi v0.87.0 bounded optimization

This is the single working evidence record for `perf/pi-087-bounded-optimization`.
Status is **in progress**, not a release or billing claim.

- Actual origin/main starting commit: `843e96f098ab5e250bb74794ffc921cc6a7daa04` (also the historical assessment coordinate; no intervening changes).
- Upstream: only `earendil-works/pi` tag `v0.87.0`, independently resolved by `git ls-remote` and fetched Git object to `16787ad5b2dc748047f314ca1bfe7708f30f54f3`.
- Existing untracked `.codegraph/`, `.sp/project-*`, and both supplied optimization plans are user-owned and excluded from task commits.
- Environment: Windows, Node v26.4.0, npm 12.0.1, Intel i7-14700KF (20 cores / 28 logical processors). CI uses Node 22.19 on Linux and Windows. All provider fixtures are synthetic, offline fetches; no paid experiments.
- Baseline `npm.cmd run build:offline`: passed. Measurement samples/fixtures and exact measured commits will be recorded below.

| Item | Current evidence / implementation decision | Commit | Tests / benchmark | Conclusion |
| --- | --- | --- | --- | --- |
| S1 overflow | Scope bodyless 400/413 to Cerebras; recognize explicit z.ai phrase | S1 commit (this change) | 9/9 boundary + actual SDK wire tests; AI offline build and check passed | implemented and verified |
| S2 strict | Adapter, capability derivation and generator need consistent conservative default | pending | pending | unverified |
| S3 GIF | Three-byte prefix still present | pending | pending | unverified |
| S4 FIFO | Array.shift queues still present; preserve provider event semantics | pending | pending | unverified |
| S5 virtual payload | Distinguish existing lazy jiti from static virtual payload | pending | pending | unverified |
| S6 fuzzy | Start with indexOf; retain additional changes only on measured evidence | pending | pending | unverified |
| R1 request history | Audit final serializer and durable history across recovery/resume | pending | pending | unverified |
| R2 TUI | Reuse production benchmarks and gates; change only reproduced gaps | pending | pending | unverified |
| R3 budgets | Existing V2/G2D/PrefixManifestRecorder; measure complete offline task requests | pending | pending | unverified |

No compile cache, paid warming, model/auth addition, telemetry, RPC/state/context platform, dependency or product version update, renderer rewrite, merge, deployment, or branch-protection change belongs to this task.

## Verification and review

S1 baseline regression: 4 failures / 9 tests before the classifier change (generic classification, both non-Cerebras bodyless SDK cases, z.ai SDK case), 9 passes after. Ordinary compatibility, 429, and 503 errors each send one ordinary request and zero summaries. Repeated genuine overflow sends two ordinary requests, one compaction operation and exactly two summary requests (history + split-turn prefix), then stops; raw failed history survives. Silent overflow, cache-read accounting and length/zero-output boundaries remain tested. This proves offline request counts, not paid cost reduction. The path audited is SDK runtime → OpenAI SDK fetch → assistant error → AgentSession `_checkCompaction` → existing bounded `_runAutoCompaction` → serializer. No recovery lifecycle or hot delta allocations changed.

Each implemented slice receives its own commit after the smallest regressions. Final gates are `check`, `build:offline`, `test:hot`, full `test`, current-head Linux/Windows Actions, and actual Codex review including inline feedback. Pending, skipped, or old-head results do not count as success.
