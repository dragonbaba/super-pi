# User bash output file creation and lifetime

T06.2 baseline: `99d22f3013a62acf94070028a2526d02dd002992` (PR #101).
Interactive `!` and RPC `bash` use `executeBashWithOperations`. Its previous
`createWriteStream(path)` used `w` and the default creation mode, returned before
physical close, and could unlink a pre-existing file after an unsuccessful open.
The upstream reference is [v1.1.0 output-files.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/utils/output-files.ts).

## Creation, errors and ownership

- The executor creates one stream lazily at byte overflow or final line truncation,
  with `flags: "wx"` and `mode: 0o600`. No preflight existence check, reopen, chmod
  window, synchronous filesystem call, or retry is introduced. POSIX permissions
  can be further restricted by umask. Exclusive creation rejects an existing file
  or symlink; security assumes a local filesystem supporting exclusive creation.
- The generated candidate path is not cleanup authority. Only the successful
  `open` event assigns the owned path. Open/constructor failure never removes a
  foreign file. One attempt is made even when further chunks arrive after failure.
- One command-owned error callback observes asynchronous write/open/close errors.
  Setup errors are captured too, so filesystem failures do not escape a local
  process's synchronous `data` listener. Text progress can continue while the
  command drains. A storage failure rejects completion, including cancellation;
  an existing producer/observation failure remains primary. Commands are not retried.
- One non-rejecting Promise at first spill waits for `close`, not just `finish` or
  `error`. Success and accepted cancellation transfer the path only after physical
  close and successful completion. On rejection, the executor waits for close and
  unlinks its exact owned path. Cleanup failure keeps the existing diagnostic path
  and primary cause, including observed producer facts.
- `finally` removes open/error listeners and clears stream, close waiter, error,
  owned path, observer, both decoders/ANSI filters and rolling text references.
  Retained producer callbacks cannot accept late output. A returned file is now
  caller/session-owned; it remains available for inspection until caller/OS temp
  cleanup. This change does not introduce a background deletion scan or TTL.

## Windows findings and adjacent production paths

Node's POSIX mode argument is **not a Windows DACL**. Windows files normally
inherit their parent directory's ACL. References: [Node filesystem flags and
permissions](https://nodejs.org/api/fs.html#file-system-flags),
[Microsoft file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).
On this Windows host, a real executor output was closed and inspected with
`Get-Acl`: six inherited Allow entries, including SYSTEM, Administrators, the
current user and three additional SIDs. There was no Everyone or Builtin Users
entry, but the additional grants mean current-user-only access is **not proven**.
The exact probe file was removed; raw ACL evidence is local, not committed.

Windows exclusive creation and cleanup are covered here, but Windows private
DACL creation remains an explicit next independent item (T06.3), before T07.1.
It must address both shell output paths, prevent inherited broad grants from the
instant of creation, and validate failure/cleanup without adding per-chunk IPC.
The existing mutation-guard native worker has a `create_private` operation, but it
belongs to an extension's asynchronous commit protocol; this PR does not couple
the core executor to that extension or claim its protection is already active.

Audited adjacent paths:

- Ordinary bash and PowerShell tools share `OutputAccumulator`: existing
  `openSync(path, "wx", 0o600)`, explicit descriptor ownership, 5 MiB cap and
  `.sp-owned` marker cleanup. Their POSIX creation is already equivalent; Windows
  still inherits ACLs. No duplicate helper or rewrite is added.
- MCP bridge `bridge.js` calls `convertMcpResult` in `result.js`; media/resources
  become bounded typed sources. `tool-result-source.ts` and
  `tool-result-presentation.ts` retain canonical content and issue virtual session
  artifact descriptors. These modules do not create binary temporary files.
  Session transcript persistence is a separate owner, not evidence of an upstream
  binary-temp implementation. Schema-cache/activation-key files are not outputs.

## Complete production call-chain allocation audit

`createLocalShellOperations` stdout/stderr (or custom producer) -> executor UTF-8
decoder -> stateful ANSI filter -> binary/CR sanitizer -> optional stream write ->
rolling tail -> AgentSession callback and `bash_execution_update` event -> RPC
serialization or InteractiveMode -> BashExecutionComponent -> viewport/container
layout -> TuiBase render scheduling -> TerminalFrameQueue -> ProcessTerminal
callback/drain -> command/stream/component release. The surrounding source audit
and existing allocations are detailed in [the ANSI report](bash-streaming-ansi.md#complete-call-chain-audit).

The guard in `ensureTempFile` returns before allocating after the first attempt.
The only new allocations are a stream options object, open listener, close Promise
and its executor at that boundary, one error observer per command, and exceptional
diagnostics. Per chunk the executor/sanitizer/filter/source-forwarders still create
zero callbacks, Promises, controllers, wrapper objects or temporary arrays. The
new error observer also passes the AST hot-method gate. No object pool is used.

The rolling tail retains at most 102400 UTF-16 code units and that many nonempty
entries; finally clears it. Decoded/output strings and final join/truncation remain
existing materializations. No extra full-result copy or scan is added. Node's
Writable owns pending encoded writes; its queued bytes are **not bounded by this
patch**. Existing progress event objects, RPC JSON, interactive split/join/map/Text
work and transcript retention remain visible in profiling, not described as zero.
Terminal active/pending limits and physical writer ownership are unchanged.

## Verification and measurements

Fourteen new regressions exercise successful/cancelled closed-file transfer,
effective POSIX permissions, regular-file/symlink collision with and without abort,
constructor/open/write/close failures, delayed physical close, preserved primary
producer failure, real local process draining after open failure, and final
line-count spill. Existing regressions cover failed unlink diagnostics and retained
late producer callbacks. Before implementation, both exclusive-creation cases and
the delayed-close regression failed on the baseline. Symlink cases ran on this
Windows host; POSIX effective-mode assertions run on Linux CI.

Reproduce from the repository root:

```sh
node --experimental-strip-types --test tests/bash-output-file-security.test.ts tests/bash-output-stream-isolation.test.ts tests/bash-streaming-ansi.test.ts tests/bash-streaming-ansi-hot-paths.test.ts tests/shell-observation-hot-paths.test.ts tests/shell-process-observation.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-hot-paths.test.ts tests/tui-real-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/bash-streaming-ansi.mjs --baseline 99d22f3013a62acf94070028a2526d02dd002992 --output /absolute/evidence/path
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000
```

The extended profiler compares the actual baseline/current executor and local
producer, including a 100-chunk, 120000-byte real filesystem spill per command.
Baseline timing explicitly waits for close too, so comparisons include equivalent
completed output. Raw HeapProfiler sampling interval is 1024 bytes, including
collected objects, with three alternating baseline/candidate runs. Native buffers
and OS allocations are not measured; timing and heap samples include harness work.
The interactive case renders the real component without a physical terminal;
local pipes use the real backend/Node streams with simulated process creation.

Controlled GC covers 12 success/error/cancellation commands per implementation,
both with and without spill. With producer callbacks deliberately retained, all
72 ordinary and 84 spill decoder/parser/observer/callback/stream WeakRefs release.
Every settled stream has zero queued bytes and zero open/error/close/finish
listeners. The probe checks every recorded file/directory cleanup by exact path.
The frame queue probe processes 20000 frames: zero application callbacks,
Promises, controllers, wrappers or full-frame copies; active/pending references
and bytes are zero after flush. Its sample is 110.18 bytes/frame, mainly timing
and harness allocations.

Final same-host medians (Node 26.4.0, Windows x64; bytes per input chunk and
p95 of command-mean microseconds per chunk):

| Scenario | Baseline bytes | Candidate bytes | Baseline p95 µs | Candidate p95 µs |
| --- | ---: | ---: | ---: | ---: |
| Plain | 252.07 | 257.17 | 0.580 | 0.607 |
| Colored | 400.93 | 404.82 | 1.740 | 1.751 |
| Split controls | 182.48 | 180.81 | 0.617 | 0.607 |
| Actual interactive component | 41790.90 | 41884.52 | 52.093 | 51.614 |
| Interleaved sources | 190.01 | 185.58 | 0.604 | 0.601 |
| Real file spill | 4534.65 | 4524.99 | 14.165 | 14.531 |
| Local backend and pipes | 946.30 | 976.36 | 5.214 | 6.392 |

Leading allocation sites remain decoder/Uint8Array and final join; spill is led
by join, truncateTail and decode; interactive by split/repeat/match; local pipes by
getShellEnv and stream internals. These samples do not establish a speedup. Local
pipe p95 increased about 23% in the final sample; the earlier three-pair run went
6.643 -> 5.611 µs, so its timing is variable and is not treated as a proven stable
regression or improvement. The security boundary adds command/spill work, not
per-chunk Promise tails. Median post-GC heaps across all scenarios stayed within
roughly 6 KiB between baseline and candidate; this includes profiler/harness state.

The final run created and removed 1354 exact spill paths and four temporary module
directories, with zero retained stream references. Its maximum observed Writable
queue was 120000 bytes for the synchronous spill fixture; this is an observation,
not a production cap. The complete test run's owned temporary root and the first
profile run's four module directories were also verified absent.

Final local checks: 120 focused cases (115 pass, 5 platform skips), type check,
offline build, and full `npm test -- --jobs 4`: 260 units, 4263 cases, 4171 pass,
92 skips, zero failures/cancellations. The 42 final raw profiles, source hashes,
GC/reference counters, ACL probe and logs are retained under the local ignored
`.git/t06-2-secure-output-20261011/` directory. The profiled executor SHA256 is
`73ca2feb64e0cf9c56633702e8c0c1b4907d8decde510811923f997194df481c`.
