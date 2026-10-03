# Regression tests and optional measurements

Default Linux and Windows CI runs `npm ci`, `npm run check`,
`npm run build:offline`, then `npm test`, within the unchanged 30-minute job
limit. Use `npm.cmd` on Windows PowerShell when required by execution policy.

`node scripts/test.mjs --suite all --list` lists the deterministic test-file
order (of the selected shard, if any) without executing tests. The runner discovers each file once and
includes the memory workspace. It runs files in a bounded pool of
`min(available CPUs, 8)` child processes; `--jobs N` or `SP_TEST_JOBS=N`
overrides the width, and `--jobs 1` restores serial execution. Files with
wall-clock pass conditions (`bash-running-responsiveness`,
`tool-lifecycle-postmerge`) run alone before the pool starts. In the pool, known
slow files start first so they do not extend the tail. `--shard i/n` or
`SP_TEST_SHARD=i/n` runs one part of a deterministic split: units are assigned
heaviest first to the least-loaded shard using approximate weights in the
runner, so the shards are disjoint and together cover every file and the memory
workspace once. CI runs Linux as 2 shards and Windows as 4 shards on separate
runners, each shard serially (`SP_TEST_JOBS=1`) because the two-core hosted
runners gain little from a pool; only shard 1 repeats `npm run check`. After the first nonzero
child exit or signal no new file starts; running files finish and the first
failure's exit code is returned. Each child writes stdout and stderr to a
runner-owned log file, replayed to stdout with its END line, so parallel output
never interleaves and the runner does not hold child output in memory.
`test:unit`, `test:hot` and `test:contract` partition that discovery for focused
work; they are not an additional validation chain before `npm test`.

Every child gets private HOME, USERPROFILE, config, agent and session paths and
`SP_OFFLINE=1`. Raw-result/interactive integration fixtures also retain their
empty temporary cwd. Other tests keep the repository cwd needed by source,
build and packaging checks. The runner removes only its own temporary child
directory and reports cleanup failures. START/END lines identify the file,
elapsed milliseconds, exit code and signal.

## Consolidated coverage

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
