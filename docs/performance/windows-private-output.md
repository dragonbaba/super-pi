# Windows private output files

T06.3 baseline: `73a00c92f4038a00b14965e515ef8506ed2ab817` (PR #102).
This closes the Windows ACL gap recorded in
[T06.2](bash-output-file-security.md#windows-findings-and-adjacent-production-paths).

## Creation and ownership

Both `executeBashWithOperations` (interactive `!`/RPC bash) and
`OutputAccumulator` (ordinary bash, PowerShell and other accumulator clients) use
one core filesystem boundary. POSIX still uses exclusive creation with `0600`.
Windows now passes an explicit self-relative security descriptor to
`CreateFileW(CREATE_NEW)`: protected DACL, one FullControl Allow ACE for the process
user, explicit process-user owner, and a non-inheritable handle. The ordinary
spill's `.sp-owned` marker uses the same creation path. Existing files/symlinks
are rejected; no existence precheck, reopen, later chmod/ACL repair or insecure
fallback is involved. NUL and alternate-stream filenames are rejected.

The Windows opener reads back owner and DACL from the created handle before
returning it. A filesystem that cannot preserve the requested protection fails
closed before output is written. A fixed 256-byte verification buffer can grow
once to a validated maximum of 64 KiB; it is call-owned and never retained. The
cached immutable descriptor is at most 172 bytes (92 on the measured host).
The process user's token is queried only during lazy initialization and closed.
No token privileges are enabled or changed.

`uv_open_osfhandle`, resolved from the current Node executable's exports, hands
the same OS object to Node's descriptor table. Node `fstat` must match the native
volume/file identity, and the native handle must still be non-inheritable. Node
then owns buffering, write/writev and close. This also preserves binary content,
including LF, CRLF, NUL, 0x1a and UTF-8. The file is never reopened by path.

Before handoff, any failure marks the still-owned OS handle for deletion and then
closes it, so rollback cannot target a substituted pathname. After descriptor
conversion, rollback closes through Node. Unconfirmed deletion/close retains an
explicit path/cause diagnostic; unconfirmed close also leaves the native ownership
counter nonzero. Neither is reported as successful cleanup. After handoff, the established stream/accumulator
owners handle success, cancellation, write failures, exact-path cleanup, and
caller-owned retained logs. Marker ownership is recorded immediately after its
exclusive open, including marker write failure.

Libraries/symbols are fixed: `kernel32` is a KnownDLL, `advapi32` comes from the
OS system directory, and libuv comes from the current process. The existing
`koffi` dependency is loaded only on first Windows spill. Core does not depend on
the mutation-guard extension, launch PowerShell, create workers, or submit IPC.
Missing native support fails the spill explicitly; small output does not load it.
The descriptor layout supports Windows x64/arm64's 64-bit ABI; actual local
validation was Windows x64. A nonstandard Node executable must expose the public
libuv helper. This does not change existing files, protect against privileged
administrator takeover, or claim a new bound on the user-bash write queue.

References: [CreateFileW security attributes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[libuv descriptor ownership](https://docs.libuv.org/en/v1.x/fs.html#c.uv_open_osfhandle).

## Native bridge evidence

The first candidate used `_open_osfhandle` from the system `ucrtbase.dll`. The
created file's DACL verified, but Node `fstat` returned EBADF: that CRT did not
share Node's descriptor table. The identity check rejected the descriptor and
rollback removed the empty file. A read-only symbol probe confirmed Node's own
libuv exports; using that documented conversion fixed real Node write/stat/close
without changing the ACL or bypassing validation. No system-CRT fallback remains.
Both source and built `dist` modules were exercised successfully.

## Full production call-chain audit

The user-bash chain is producer -> source-specific decoder/ANSI filter -> binary
sanitizer -> optional spill -> rolling tail -> AgentSession observer/event -> RPC
JSON or InteractiveMode/BashExecutionComponent -> viewport/layout -> TuiBase
scheduler -> TerminalFrameQueue -> ProcessTerminal callback/drain -> release.
Its hot delivery functions are unchanged; see the
[existing full audit](bash-streaming-ansi.md#complete-call-chain-audit).

The ordinary tool chain is `createLocalShellOperations`/custom producer ->
`createShellToolDefinition.handleData` -> `OutputAccumulator.append` -> decode/
tail accounting/optional spill -> throttled `emitOutputUpdate` snapshot -> agent
tool-progress delivery -> session/interactive tool component -> render/frame
queue/terminal -> `finishOutput`, close/discard and timer/listener release.
PowerShell uses this same shell definition and accumulator. Setup failures enter
the existing output-failure abort path with preserved shell execution facts.

Native work occurs once per created file: one log for user bash, one log plus one
marker for an ordinary spill. Repeated `ensureTempFile` calls return at the
existing ownership guard. There is no per-chunk native call, IPC, Promise,
controller, callback, wrapper or array added. The shared stream adapter passes
Node's write/writev/close functions directly. No object pool is introduced.
The user-bash close waiter remains one per spill. Native creation and verification
are synchronous at this cold boundary; this is measured below, not described as
free or asynchronous filesystem work.

Existing allocations remain: decoded strings, accumulator decode-option wrappers,
tail concatenation/trimming Buffers, final truncation, snapshot/update objects and
arrays, event delivery and RPC JSON, interactive preview/layout strings and arrays.
There is no additional full-output materialization. The accumulator retains its
existing bounded tail and 5 MiB spill cap; the user executor retains its existing
102400-code-unit tail. Node owns queued write buffers until close. Settled owners
release stream/listeners and files through their existing lifecycles. Native
diagnostics retain primitive counts only; bindings/descriptor are process-owned.

## Verification

Three baseline ACL regressions failed before production edits. The actual Windows
fixtures grant Everyone inheritable Read on their exact temporary parent, then
verify each new output and marker has an explicit current-user owner and exactly
one non-inherited Allow rule in a protected DACL. An additional fixture checks the
empty file before its first byte, then Node binary writev/stat/close. Small output
is checked in a fresh process to prove native loading is absent.

Native failure tests cover unavailable bindings, token query/close, security read
or mismatch, file identity, descriptor transfer, inherited-handle rejection, and
rollback delete/close failure. Real successful native operations are used around
each injected failure. No payload is written before verification. Simulated
unconfirmed close actually releases the fixture's handle, but verifies production
reports uncertainty. Marker-create/write and stream-constructor failures also
close descriptors and remove only owned paths. Existing collision, symlink,
cancellation, storage-error and observed-shell-failure tests remain in force.

```sh
node --experimental-strip-types --test tests/windows-output-dacl.test.ts tests/windows-output-native-failures.test.ts tests/private-output-hot-paths.test.ts tests/bash-output-file-security.test.ts tests/bash-streaming-ansi-hot-paths.test.ts tests/shell-result-contract.test.ts tests/shell-observation-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/bash-streaming-ansi.mjs --baseline 73a00c92f4038a00b14965e515ef8506ed2ab817 --output /absolute/user-profile
node --expose-gc --experimental-strip-types scripts/bench/private-output-files.mjs --output /absolute/accumulator-profile
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000
```

## Same-host profiles and release evidence

Node 26.4.0, Windows x64. Three alternating pairs; actual V8 HeapProfiler samples
include collected objects at a 1024-byte interval. Each user spill writes 120000
bytes in 100 chunks; each accumulator spill writes 204800 bytes in 100 chunks.
The baseline waits for the same completion/cleanup. The interactive case uses the
real component; local pipes use the real backend with simulated process creation.
Native/OS allocations are not represented by V8 samples.

| Scenario | Baseline bytes/chunk | Candidate bytes/chunk | Baseline p95 µs/chunk | Candidate p95 µs/chunk |
| --- | ---: | ---: | ---: | ---: |
| Plain user output | 256.44 | 257.68 | 0.608 | 0.540 |
| Colored | 403.96 | 403.64 | 1.734 | 1.755 |
| Split controls | 184.64 | 183.79 | 0.618 | 0.618 |
| Interleaved sources | 192.81 | 187.57 | 0.569 | 0.578 |
| Interactive component | 41872.92 | 41965.58 | 32.723 | 32.231 |
| User file spill | 4525.24 | 4561.19 | 14.234 | 14.422 |
| Local backend/pipes | 953.11 | 969.49 | 6.552 | 5.000 |
| Tool accumulator spill | 5179.44 | 5272.73 | 14.806 | 14.225 |

Numbers are medians; p95 is over command-mean time per chunk, not individual-event
tail latency. No overall speedup is claimed. First candidate accumulator spill,
including lazy native loading and a whole 204800-byte command, took 10.17 ms.
Steady spill allocation increases were about 0.8% (user) and 1.8% (tool), with
native work amortized over the command. Leading sites remain decode/Uint8Array,
join/truncateTail, interactive split/repeat/match, and local getShellEnv/streams.
Heap readings include compiler/profiler state and drift downward during GC; the
last accumulator pair settled at 15807032/15817328 bytes. Lifecycle conclusions
come from ownership/WeakRef probes, not unpaired heap medians.

With retained producer callbacks, 72 ordinary and 84 user-spill WeakRefs release.
The accumulator's 48 owner/stream WeakRefs across success, error and discard
(cancellation) also release. Settled streams have zero queued bytes/listeners;
native file/token ownership counters are zero. The accumulator probe observes
exactly two native creates per command, 746 transfers overall (including warmup
and lifecycle runs), and a 92-byte cached descriptor. All 1354 user logs and 745
tool log/marker pairs are removed, along with six recorded module directories.
Maximum observed queues were 120000 and 204800 bytes, not new production caps.

The 20000-frame queue gate retains zero active/pending references or bytes after
flush; application callbacks, Promises, controllers, wrappers and full-frame
copies stay zero. Sampling was 110.92 bytes/frame, mainly timing/harness work.
Raw profiles (42 user + 6 accumulator), source hashes, native failure/ACL evidence
and command logs are under local ignored `.git/t06-3-windows-output-dacl-20261011/`.

Final `npm test -- --jobs 2`: 263 units, 4285 tests, 4193 passed, 92 platform skips,
zero failures or cancellations. The initial four-job attempt encountered Windows
V8 VirtualAlloc/Zone allocation failures in unrelated CLI children; an independent
Node probe also failed to allocate memory during that run. After its owned workers
ended, the unchanged suite passed at two jobs, including all affected CLI groups.
No test expectation was relaxed. The recorded full-suite temporary root no longer
exists. `npm run check`, `npm run build:offline`, the compiled native write/stat/
close probe, 20 Windows ACL/native failure cases and 31 source/AST invariants passed.
