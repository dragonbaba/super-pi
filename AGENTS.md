# Super Pi Repository Rules

General working rules live in each agent's global instructions (`~/.sp/agent/AGENTS.md`, `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`). This file holds only rules specific to this repository.

## PR Delivery and Review

Follow the global Git authorization rules. The workflow below applies when the user has authorized PR delivery for the task; these instructions do not themselves authorize commits, pushes, PRs or merges. Reuse the task's existing authorization for necessary review fixes and delivery steps; do not ask again for the same authorized action.

- Use a task branch or isolated worktree and keep unrelated local changes out of the PR. Split work into independently reviewable changes; complete the review and CI gates for a prerequisite PR before building the next stage on it. Do not create empty PRs to match a planned phase count.
- Lead PR descriptions with the concrete problem and resulting behavior. Include relevant verification, performance evidence and remaining gaps; update the title and description when scope changes. Keep credentials, private configuration and raw transcripts out of PRs.
- After **every push**, including review fixes, manually post `@codex review` with the current head and the specific concerns to check. A previous review or an automatic trigger does not replace this step.
- Verify each finding against the production path and a reproduction or counterexample before changing code. Fix confirmed problems and add a meaningful regression where needed; answer inapplicable feedback with evidence. Check the next request or lifecycle transition when a finding concerns retained state, not only the failing call.
- Merge only after the **final head SHA** has a completed review with no unresolved findings and all required CI checks from the [current workflow](.github/workflows/ci.yml) have passed for that head. Pending, cancelled or older-head results do not satisfy the gate. Recheck head, review threads and CI immediately before merging, and bind the merge to the verified head.
- After an authorized merge, verify the merged result, synchronize local `main`, and remove the task's merged local and remote branches by exact identity. Broader cleanup requires the user's authorization; preserve unrelated branches, stashes and working changes. Report the resulting commit and local build status.

## Code and Compatibility

- Prefer the smallest clear change using existing owners and shared primitives. Use named helpers when they clarify control flow and ownership; local closures need intentional lifetimes and captured state. Avoid retaining large payloads through callbacks; keep per-item callbacks out of hot processing loops.
- Prefer direct loops and incremental counters when they avoid repeated scans, intermediate arrays or `map`/`filter`/`reduce` chains. Do not split a large result or long line into an unbounded array. Preserve required validation passes and observable behavior when optimizing.
- Share fixed limits, units and protocol constants through cohesive, side-effect-free modules used by worker, backend, schema and tests. Avoid scattered magic values and duplicate definitions; do not introduce a catch-all constants module or mutable global scratch state.
- Reuse fixed non-stateful regexes at module scope; use literal `indexOf`/`includes` for literal searches. Stateful `g`/`y` matching needs isolated ownership and explicit reset between independent inputs. Do not share mutable `lastIndex` across concurrent operations or compile regexes per row, delta or frame.
- Keep provider/API behavior explicit. Preserve reasoning/signatures, tool call/result pairing, history ownership and remote continuation/compaction boundaries. Measure the actual serialized body, compressed HTTP body or WS frame at its send boundary; distinguish their units. Do not automatically replay completed tools or modifications to recover a provider failure.
- Do not introduce strict parsing or allowlists of model-authored scripts/shell source, arbitrary new tool limits, or additional approval flows as a repair. Preserve existing authorization, protocol/schema validation and sandbox boundaries; do not weaken them to make a test pass.

## Hot-Path Allocation Contract

- Provider deltas, assistant/tool progress, event delivery, interactive updates, rendering/layout, terminal frame generation/writes, large-result processing, and Evidence Ledger lookup are hot paths.
- Before modifying a hot path, read [docs/performance/hot-path-allocation-contract.md](docs/performance/hot-path-allocation-contract.md) and audit the complete production call chain, not only the new diff.
- Follow the contract's zero-allocation callback/Promise/AbortController/wrapper categories for normal per-delta/frame/progress work. Reuse module functions or callbacks created once per owner; arrays and frame materialization follow the contract's measured, bounded exceptions. Account for request/setup allocations separately and name exact lifecycle exemptions.
- Use viewport/dirty-region work and valid incremental state where correctness permits. Avoid unnecessary full-history reformatting, full-screen copies and sorting/filtering allocations per render. Preserve atomic content/cursor updates, backpressure and flush/abort/disposal behavior.
- Reuse the existing serialized string or encoded buffer for byte counts; do not encode, stringify, copy or flatten a complete payload/frame again just for metering or diagnostics. Use native UTF-8 counting where available and preserve supported portable fallbacks.
- Every cache, queue and scratch buffer needs an owner, capacity, invalidation and release boundary, including error, cancellation, generation change and disposal. Clear large references and discard oversized backing stores; a helper or cache does not make hidden allocation free.
- Run the relevant AST/source invariants and allocation benchmark, and provide deterministic counters plus lifecycle/reference-release evidence.
- Compare equivalent correct workloads on the same machine. Report allocation sites, peak/retained memory and CPU measurements; do not claim an improvement from omitted output, different completion coverage or timing alone.
- If a change does not touch a hot path, state that in one line and skip the benchmark.
- Object pools require profiler proof and must satisfy the contract's ownership, safety, capacity, test, and measured-improvement gates.

## Verification and Retirement

- Start with the smallest relevant regression. Use the repository commands `npm run check`, `npm run build:offline` and `npm test` as appropriate to the change, plus the required hot-path gates. Expand testing for impact or diagnosed failures; do not rerun unrelated suites without a reason. Documentation-only changes need content/link/diff checks rather than a build.
- Do not run `build:offline` concurrently with tests consuming `dist`: the build removes and recreates package output. Freeze the candidate during final verification; after a relevant correction, rebuild affected output and rerun the affected checks. Clearly separate offline fixtures, worker-only probes and real session/provider/MXC validation.
- When replacing behavior, trace its consumers and remove obsolete implementation, registrations, dedicated scripts and fixtures within the authorized scope. Update tool descriptions, schemas, current documentation and the docs index together. Mark retained historical evidence/designs as historical or retired and preserve referenced anchors; do not leave superseded instructions active beside the replacement.

## Extension Source Imports

- Bundled extensions that load from TypeScript source (and source-only packages they import, such as `packages/tui-kit`) must write relative imports with the real `.ts` extension, never `./x.js` for a file that is `./x.ts`.
- jiti probes about 60 candidate paths before it retries a `.js` specifier as `.ts`; one extension written that way cost 6,384 failed stat calls and about 75 ms on every start. `tests/bundled-extensions.test.ts` fails on any such import.
- Tests and other callers must import these files by the same `.ts` name. jiti caches by specifier, so `runtime.js` and `runtime.ts` become two module instances with separate state.
- When syncing an extension from upstream, rewrite its relative specifiers before committing. A package tsconfig that does not extend `tsconfig.base.json` needs `"allowImportingTsExtensions": true`.

## Task Temporary Files

- Put task scratch data (probes, logs, fixtures, downloads, profiles) under `.task-tmp/<task-id>-<unique-id>/`, which is gitignored; never in `.git` or `docs/evidence/`.
- For tests and subprocesses, point `TMP`, `TEMP` and `TMPDIR` at the task root in the child environment only; `scripts/test.mjs` derives its per-run directories from that.
- By default, deleting your own task root when the task is done is part of the task and needs no separate approval. If the user asks to keep it for manual cleanup or reproduction, retain it and report the exact path. Do not delete other task roots or follow links out of `.task-tmp`. If deletion is blocked, report the remaining path and reason.

## Evidence

- `docs/evidence/` keeps one concise record per task: problem, reproduction, fix, verification numbers and the rerun command. Do not narrate review rounds or cleanup, paste raw output, or keep credentials, real user configuration or private transcripts.
