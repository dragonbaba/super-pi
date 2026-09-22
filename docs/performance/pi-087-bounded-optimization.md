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
| S1 overflow | Scope bodyless 400/413 to Cerebras; recognize explicit z.ai phrase | `8fc432026` | 9/9 boundary + actual SDK wire tests; AI offline build and check passed | 已实现并验证 |
| S2 strict | Conservative Chat default; explicit compat/capability support; retain built-in support as explicit metadata | `e01aab5d4` | 68/68 related tests; all built-in Chat catalog entries through serializer; local strict=require zero sends | 已实现并验证 |
| S3 GIF | Require full GIF87a/GIF89a signature | S3 commit | 6 red cases before; 9/9 after; image/read related suite 61 passed, 1 platform skip | 已实现并验证 |
| S4 FIFO | Replaced queue and waiting arrays with incoming/outgoing FIFO stacks | `6c47620fc` | 5/5 FIFO/lifecycle tests; queue microbench low 128/high 10k; production `bench:stream` 100k | 已实现并验证；普通场景收益不稳定 |
| S5 virtual payload | Distinguish existing lazy jiti from static virtual payload | pending | pending | unverified |
| S6 fuzzy | Start with indexOf; retain additional changes only on measured evidence | pending | pending | unverified |
| R1 request history | Audit final serializer and durable history across recovery/resume | pending | pending | unverified |
| R2 TUI | Reuse production benchmarks and gates; change only reproduced gaps | pending | pending | unverified |
| R3 budgets | Existing V2/G2D/PrefixManifestRecorder; measure complete offline task requests | pending | pending | unverified |

No compile cache, paid warming, model/auth addition, telemetry, RPC/state/context platform, dependency or product version update, renderer rewrite, merge, deployment, or branch-protection change belongs to this task.

## Verification and review

S3 keeps the existing image processor, size and read-identity paths. Valid one-pixel GIF87a/GIF89a files pass actual `createReadToolDefinition.execute` and CLI `processFileArguments` with default image processing enabled; 3–5 byte prefixes, wrong version, text beginning GIF and lowercase text stay text. Related `image-acceptance-closeout` and `read-windowing` tests pass; one existing platform-specific test is skipped, not counted as a pass.

S4 audited the production path `provider adapter → AssistantMessageEventStream.push → Agent async consumer → event delivery`; no provider delta or TUI latest-only behavior was changed. The same Windows/Node v26.4.0 fixture used warmup 5 and samples 20 on an Intel i7-14700KF, with a 100,000-delta production `bench:stream` and a queue-only 128/10,000 prequeue probe. The old `ecce87888` production run was p50/p95/p99 28.66/29.78/33.97 ms; candidate `6c47620fc` was 24.91/26.99/30.83 ms, with `eventsDelivered=1`, `maxPendingKeys=1`, and `coalesced=100001`. A second old/candidate micro run was noisy: low backlog p50 0.0192/0.0218 ms and high backlog p50 1.1021/1.1217 ms; high-backlog p95 was 1.982/1.410 ms. Structural counters consumed 129/10001 events and left queue/waiter lengths at zero in 25/25 runs. This does not establish a stable ordinary-scene speedup or a billing/token change; the change is retained as the bounded upstream FIFO representation with no measured regression beyond normal variance. No Promise, AbortController, pool, backpressure or frame-path allocation was introduced.

S2 changes only Chat Completions defaults, not Responses defaults. An explicit capability supports strict when compat is absent; either explicit compat false or capability false vetoes it. Existing built-in behavior is retained by adding positive compat metadata to the existing catalog (no refreshed model IDs/prices/limits). The generator's delta baseline is also false, so future generation emits positive support explicitly. The catalog migration was previewed, deterministic and idempotent; existing explicit false/true values were untouched and content hashes updated. Unknown endpoints preserve optional parameters for `prefer`; `require` fails locally with zero sends. The local argument validator remains active. S1's actual session-wire fixture now also declares a prefer-strict optional tool and checks the final wire before asserting bounded recovery counts.

S1 remote checks passed for `8fc432026` only: [CI](https://github.com/dragonbaba/super-pi/actions/runs/35673987821). [Codex request](https://github.com/dragonbaba/super-pi/pull/42#issuecomment-5769732370), [actual S1 result](https://github.com/dragonbaba/super-pi/pull/42#issuecomment-5769753951). Conversation, formal reviews and inline comments were read; no findings on that head. Required checks queried from branch protection are `verify-linux` and `verify-windows` with strict up-to-date requirement. Later heads still need their own checks/review.

S1 baseline regression: 4 failures / 9 tests before the classifier change (generic classification, both non-Cerebras bodyless SDK cases, z.ai SDK case), 9 passes after. Ordinary compatibility, 429, and 503 errors each send one ordinary request and zero summaries. Repeated genuine overflow sends two ordinary requests, one compaction operation and exactly two summary requests (history + split-turn prefix), then stops; raw failed history survives. Silent overflow, cache-read accounting and length/zero-output boundaries remain tested. This proves offline request counts, not paid cost reduction. The path audited is SDK runtime → OpenAI SDK fetch → assistant error → AgentSession `_checkCompaction` → existing bounded `_runAutoCompaction` → serializer. No recovery lifecycle or hot delta allocations changed.

Each implemented slice receives its own commit after the smallest regressions. Final gates are `check`, `build:offline`, `test:hot`, full `test`, current-head Linux/Windows Actions, and actual Codex review including inline feedback. Pending, skipped, or old-head results do not count as success.
