# Regression tests and optional measurements

Default Linux and Windows CI runs `npm ci`, `npm run build:offline`, then
`npm test`, within the unchanged 30-minute job limit. The shared TypeScript
check runs once, on Linux shard 1. Both operating systems still compile and
exercise their actual runtime paths. Use `npm.cmd` on PowerShell 7 when
required by execution policy.

The [build runner](building.md) uses workspace dependency ordering and at most
two concurrent packages by default. Its `--jobs` option is separate from the
test runner's concurrency setting below; `npm run build:offline -- --jobs 1`
provides a serial build for diagnosis.

`node scripts/test.mjs --suite all --list` lists the deterministic
execution-unit order (of the selected shard, if any), including the memory
workspace, without executing tests. Each file is discovered once and runs in a
bounded pool of `min(available CPUs, 8)` child processes; `--jobs N` or
`SP_TEST_JOBS=N` overrides the width, and `--jobs 1` restores serial execution.
Files with wall-clock pass conditions (`bash-running-responsiveness`,
`tool-lifecycle-postmerge`) run alone before the pool starts. In the pool,
known slow files start first so they do not extend the tail. `--shard i/n` or
`SP_TEST_SHARD=i/n` runs one part of a deterministic split: units are assigned
heaviest first to the least-loaded shard using approximate weights in the
runner, so the shards are disjoint and together cover every file and the memory
workspace once. CI runs Linux as 2 shards and Windows as 4 shards on separate
runners, each shard serially (`SP_TEST_JOBS=1`) because the two-core hosted
runners gain little from a pool. Type checking is not repeated on Windows. After
the first nonzero child exit or signal no new file starts, even if a slow output
consumer is still holding another file's log replay. Running files finish, and
the first failure's exit code is returned. Each child writes stdout and stderr
to a runner-owned log file, replayed to stdout with its END line. Parallel
output never interleaves, and the runner does not hold child output in memory.
`test:unit`, `test:hot` and `test:contract` partition that discovery for
focused work; they are not an additional validation chain before `npm test`.
The root runner invokes the memory workspace's existing Node test directly
against the preceding build. Its standalone workspace test still builds when
that package is tested independently. Native MXC acceptance and allocation
benchmarks are opt-in and run separately from ordinary CI. `--keep-going` is an explicit
diagnostic option; routine CI stays fail-fast.

Every child gets private HOME, USERPROFILE, config, agent and session paths and
`SP_OFFLINE=1`. Its `TMPDIR`, `TMP` and `TEMP` point at one runner-owned
directory shared by the run's children, so jiti's tmpdir transpile cache stays
warm across files. Raw-result/interactive integration fixtures also retain their
empty temporary cwd. Other tests keep the repository cwd needed by source, build
and packaging checks. The runner removes only its own child directory after the
child closes, on success or failure, and the run directory when the run ends.
Retryable removal errors receive up to five retries with a 100ms linear backoff;
exhausted retries still fail. Output spills and abandoned fixture directories in
the run's temporary path leave with the run; no shared system-temp logs are
swept. Test fixtures must still register cleanup
before fallible initialization and release their directories in `finally` after
resource shutdown. Runner cleanup contains abrupt test exits; it does not
replace resource-lifecycle assertions. START/END lines identify the file,
elapsed milliseconds, exit code and signal.

## Consolidated coverage

MXC acceptance is opt-in on Windows x64 with native ProcessContainer support
and PowerShell 7. After `npm run build:offline`, set child `TMP`, `TEMP`, and
`TMPDIR` to an owned `.task-tmp/<task-id>-<unique-id>/` directory, set
`SUPERPI_MXC_LIVE=1` and `SUPERPI_SANDBOX_USE_DIST=1`, then run
`node --experimental-strip-types --test --test-concurrency=1 tests/mxc-workspace-live.test.ts`.
Both read-only and sandbox-write must execute with zero skips. The tests cover
PowerShell 7, direct workspace access, file protection and release of processes,
streams, runtime roots and Job handles. The same live opt-in enables
tests/sandbox-image-read-live.test.ts and the real MXC cases in
tests/subagent-parent-execution.test.ts. Ordinary CI skips these live cases.
The pre-MXC VM acceptance suite is archived in the [retirement record](documentation-status.md#windows-sandbox-vm-retirement).
Relevant allocation measurements remain separate from ordinary CI:
`node --expose-gc --experimental-strip-types scripts/bench/mxc-search.ts` and
`node --expose-gc --experimental-strip-types scripts/bench/mxc-output.ts`.
For read/search status and clipped ASCII excerpts, run
`node --expose-gc --experimental-strip-types --test scripts/bench/mxc-result-render.ts`.
Set child `MXC_RENDER_COMPARE_MARKERS=1` to add the equal-length former Unicode
marker comparison in expanded and collapsed result updates. Sampling includes
the real tool component and alt-screen renderer; tracked results/components
must be released after disposal and four controlled GC cycles. The search
benchmark also profiles the production directory consumer with a controlled
lazy producer, checks 20,001 reads at the 20,000-entry limit, and verifies that
every directory cursor closes and is released. Native Dirent allocations are
outside that controlled fixture; native workspace acceptance exercises real I/O.

- The parallel raw-result matrix contains 8 cases instead of 18: both renderers
  retain projection on/off with 8 concurrent calls, plus 129-call insufficient
  and sufficient budget boundaries with projection enabled. Each still checks
  actual concurrency, no replay, exact continuation recovery, responsiveness and
  GC. Single-result shapes already run in `alpha-raw-session`; intermediate
  count 4 and another unprojected count 129 introduced no additional branch.
- The real CLI matrix has 39 cases (38 after consolidation, plus the T02
  AGENTS-only saved-denial regression). Terminal lifecycle,
  cancellation, active-work shutdown and progress still run in both renderers.
  Missing/malformed settings and trusted/untrusted project parsing run once
  through the real CLI because they precede renderer selection.
- The caught-child-error control is consolidated into `codemode-r2-failure`:
  failed/successful child facts, catch/alternative output, preserved previously
  committed store and discarded new keys all remain asserted. The separate
  uncaught typed-tool error control is retained.
- Across the two CI operating systems this removes 30 redundant test invocations,
  one repeated type check and two repeated memory builds. Windows/POSIX coverage
  and correctness, allocation, cleanup and timeout limits are unchanged.
  Historical timing/result counts remain dated evidence; current matrices are
  authoritative.
- The retired `alpha:g2-probe` command repeated 23 files already discovered by
  `npm test`. Its independent environment/GC requirements now live in the one
  runner. No alpha family is excluded from discovery.
- `alpha-stream-stress.test.ts` duplicated repeated heap measurement available
  in `scripts/bench/alpha-stress-gc.ts`. Its behavior and WeakRef checks now run
  in `alpha-assistant-update.test.ts` for regular and fullscreen modes: 8,193
  updates cross two 4,096-update render batches plus a partial final batch.
  Final content, queue bounds, zero wrapper/promise counters, completion and
  owner collection remain asserted. Repeated 100,000-update heap statistics
  are no longer default regressions.
- Assistant/tool coalescing uses repeated overwrites of one/four pending
  slots (1,025 updates, or 257 per parallel tool), retaining final-delivery and
  end ordering. The session-delivery benchmark smoke uses 1,025 updates with
  32 warmup updates, retaining synchronous-lane counters and source invariants.
- Fixture cardinalities are checked on the existing deterministic manifest;
  a second test no longer builds the same large arrays and strings again.
- GC is required, not silently skipped, for assistant-update, Markdown owner,
  raw parallel-result and startup/quit ownership tests. The default runner
  supplies `--expose-gc` only to those files. Direct execution of those files
  must supply that flag too.

Native commit correctness remains in `native-file-metadata.test.ts` and the
native operations/integration regressions: actual readback, receipts, metadata,
identity/permission failure boundaries, zero native handles/descriptors and
worker disposal. The five-process cost sampler is no longer a default CI step.
Platform-specific and explicit opt-in skips elsewhere retain their existing
meaning; a skip is not an executed pass.

## On-demand performance work

Existing commands remain available when their measurements are relevant:

```sh
node scripts/alpha-bench.mjs stress --mode regular --cycles 5
node scripts/alpha-bench.mjs stress --mode fullscreen --cycles 5
node scripts/bench/native-file-commit-multiprocess.mjs
npm run bench:stream
npm run bench:tool-progress
npm run bench:tui-session-event-allocations
```

The stress wrapper isolates/sanitizes its environment; the native sampler owns
its private file fixture. These are measurements, not extra routine PR gates.
Startup capture is retained because real CLI tests and manual terminal checks
still use it. Historical probe results in evidence documents remain historical,
not instructions to run a removed command. Production hot-path changes still
require the relevant source invariants, allocation and lifecycle evidence from
the [allocation contract](performance/hot-path-allocation-contract.md).
