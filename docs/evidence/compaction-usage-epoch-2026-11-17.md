# Compaction usage epoch and request headroom

## Evidence and cause

The reported session generated a 191,310-character CodeMode argument. The existing shared 131,072 UTF-16 limit rejected it before any child tool ran. The following provider response reported 512,307 tokens while the configured context window was 500,000. A 1,024-token tool-result budget was sufficient for the 56-token batch minimum, but no context headroom remained for the 31-token envelope. The local preparation block preserved prior outcomes.

Read-only reconstruction found a previous compaction checkpoint with a 19,708-token materialized baseline and 182 later successful responses. Automatic compaction already ran between tool turns; its accounting always ignored provider usage after any checkpoint. The reconstructed 432-message context therefore estimated 337,673 tokens while provider-aware accounting measured 512,568 including trailing messages. No uncommitted paid compaction boundary followed that checkpoint. Raw private history was neither changed nor committed.

## Change and boundaries

Current-epoch usage becomes authoritative only when the successful response matches the selected API/provider/model, is present in the active context, and is committed to the active branch after its latest checkpoint. Retained pre-checkpoint usage, omitted branches, errors, aborts and other owners remain ineligible. Until a valid response exists, materialized accounting and its existing baseline guard remain. New checkpoints, branch restore and reload revalidate ownership without retaining a new cache. Stale-response checks use the same branch membership instead of timestamps, including when a host clock moves backwards.

The failed run still cannot authorize paid recovery from a local preparation block. A new explicit prompt performs the normal threshold check when automatic compaction is enabled; no completed tool is replayed. Disabled compaction and uncommitted paid-boundary suppression remain. CodeMode schema and model-facing source guidance now use the existing runtime length constant; no larger quota, source parser or partial execution is introduced.

## Allocation contract

Audited chain: footer/status context query and turn/request admission → `getContextUsage`/threshold accounting → active branch/checkpoint and paid-boundary lookup → current-epoch anchor → trailing estimates → disposal. The verified path adds no callbacks, Promises, AbortControllers, arrays, payload copies or retained state. It returns one estimate object, as did the prior post-checkpoint path; the existing branch-array owner remains. Legacy/unverified materialized estimation is retained. No pool is introduced.

Same-machine Windows/Node 26.13.0, identical 160 paired historical calls and 329,509 expected context tokens, 256 getter calls:

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Historical argument serializations | 40,960 | 0 |
| Serialized UTF-16 units | 168,222,720 | 0 |
| Sampled allocated bytes | 177,182,464 | 2,083,792 |
| Sampled peak heap bytes | 79,715,648 | 48,623,184 |
| Heap after release/GC bytes | 45,820,192 | 45,518,864 |
| Retained session owners after release/GC | 0 | 0 |

Baseline allocation sites were historical JSON serialization and full-history estimation; candidate sites are the existing branch array and measurement bookkeeping. CPU samples were 94,000 µs versus 0 µs at timer quantization, so no CPU speedup is claimed. Heap samples include fixture/setup footprints; deterministic serialization counters establish the removed work. Raw benchmark JSON can be saved with `--output` independently of terminal presentation.

## Verification

Type checking, offline build **12/12**, **429 related regressions / 0 failures**, and the complete local suite **6,434 passed / 117 skipped / 0 failed across 473 units** pass, including live SDK tool-turn compaction with one completed effect, next-prompt recovery after a local block, disabled compaction, owner mismatches, reload/branch restoration, paid-boundary state and the 10-API/14-configuration/140-request offline prefix matrix. Existing threshold-recovery fixtures now report provider usage above their configured threshold instead of a canned 110 tokens, retaining their original hook-failure and omission assertions. The built accounting function also reads the reported session as 512,568 tokens/source=provider/epochVerified=true without modifying it. Offline fixtures and read-only session reconstruction do not claim a live provider compaction.

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/compaction-usage-epoch.test.ts tests/compaction-usage-epoch-hot-paths.test.ts tests/compaction-custom-instructions.test.ts tests/compaction-instructions-lifecycle.test.ts tests/pi087-length-recovery.test.ts tests/pi087-request-history.test.ts tests/codemode-session.test.ts tests/codemode-budget-diagnostics.test.ts tests/tool-prefix-providers.test.ts
node --expose-gc --experimental-strip-types scripts/bench/compaction-usage-epoch.ts --output .task-tmp/<owned-task>/measurement.json
```
