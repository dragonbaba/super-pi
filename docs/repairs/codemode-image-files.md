# Codemode image files (F07)

## Design gate

Baseline: `f87094539cf8386ab723b361300c5ae2366218b7` (PR #126 merged).
The fixed 1.1.0 plan selects the feature described in the upstream
[1.0.3 release](https://github.com/earendil-works/pi/releases/tag/v1.0.3):
image output should be addressable by ordinary tools in later turns.
Current `image()`/`show(ref)` retain image blocks, but refs expire with the
script and no binary file path reaches the model. Reproduce through the real
AgentSession before changing production code.

Save images once, after the worker and nested calls settle, including images
retained by a failed script. Keep existing image blocks and execution status.
File failures produce an explicit bounded warning; they must not reject the
completed parent result or replay tools. Do not grant VM filesystem access or
change tool policy, model permissions, receipts, or the standalone sandbox API.

Each completion owns at most 16 image records, one decoded buffer at a time
(8 MiB maximum), a 16-entry digest map and at most 16 MiB of decoded input.
Deduplication is within that completion only; no session/global image cache.
Validate base64 and PNG/JPEG/GIF/WebP signatures before writing. Use an exclusive
random temporary directory and the existing private-output opener: POSIX 0600,
Windows protected current-user DACL before content writes. Every successful
descriptor is closed; cleanup targets only a failed file created by this call.
A private JSON manifest maps image positions to binary paths. Its path is
reported in the final text and persisted with ordinary session messages.
The text cap must retain this notice even when it truncates preceding output.

Files survive controller disposal, branch changes and session reopen on the
same machine. They are temporary, with no application TTL or background sweeper;
the OS/user may remove them at any time. Copy to a chosen destination through
normal authorized tools for durable storage. Missing files are ordinary read
failures, never triggers to rerun the producing script. No automatic cross-restart
work is added. Disk bounds are per completion, not a global storage quota.

Audited chain: VM image/output -> primitive worker bridge/BridgeBudget -> host
Execution.handleMessage/finish and worker termination -> CodemodeController
execute + native show -> bounded image persistence -> capCodemodeOutput -> Agent
tool completion -> AgentSession JSONL and model projection -> InteractiveMode
tool card/Image -> render/layout -> terminal queue/write -> owner disposal.
Read-provenance offsets must remain unchanged. New file work belongs to the
completed-result boundary; no file work, closures, promises or caches are added
per progress update, provider delta or rendered frame. The existing text cap
is a large-result hot path: preserve its streaming spill and bounded estimator,
and measure the complete affected chain rather than claiming zero allocations.

Validation: focused integration for later-turn reads, JSONL reopen, duplicate
images, failed script/write preservation, caps and permissions; existing output
and source invariants; same-fixture allocation counters/profiles and controlled
GC after normal/failure/abort/disposal. Test resources are recorded and removed
by exact fixture identity. No full local suite or live provider call is planned.

## Implementation and verification

The real session probe first failed because completed image output had no file
reference. It now verifies identical bytes, per-completion deduplication, a
later-turn `read` and the manifest path surviving JSONL reopen. A second failing
probe exposed the existing text-spill failure path when the disk was full and a
small output budget required truncation. The image completion path now retains
bounded text and image identities with an explicit unavailable-recovery notice;
the script status and completed child-call count remain unchanged. Partial
image writes are removed by exact identity; previously saved files remain
addressable by their directory if the manifest itself cannot be written.

39 distinct checks passed: 15 integration/provider-conversion checks and 24
image/output/source checks. Four focused file checks cover actual Windows
owner/protected DACL on both binary and manifest files (POSIX mode checked on
that platform), native handle release, signatures, 8/16 MiB limits, count cap,
dedup, partial writes and a 256-token output budget. The final affected source/
output rerun passed 18 checks. Root typecheck and coding-agent build passed.

Source audit confirms the existing VM/worker bridge, nested dispatch, Agent/
Session, estimator/spill, UI/tree/Image, Main/Alt rendering and terminal queue
are unchanged. The text-projection loop is identical to the merged baseline.
The new synchronous file helper has zero closures, Promises and controllers;
the no-image branch creates no containers. No per-update/frame factory, copy,
timer, worker or pool was added. Images need one decode buffer per accepted
image, a SHA256 digest, a bounded record array/map, binary writes and a small
manifest serialization. These are completion allocations, not zero allocation
claims. The original encoded image string is not copied for hashing or storage.

Windows x64 / Node v26.4.0, same fixtures before/after:

| Fixture | Baseline | Candidate |
| --- | --- | --- |
| Real AgentSession: 10 sampled cycles, 1 warmup, 242 nested reads | 26,096,944 sampled host bytes | 26,525,448 sampled host bytes |
| Session first-batch median / p95 ms | 45.513 / 46.504 | 45.466 / 77.486 |
| Session warm-batch median / p95 ms | 44.910 / 46.113 | 46.984 / 56.024 |
| Session workers started/stopped; WeakRefs retained | 22/22; 0/55 | 22/22; 0/55 |
| Image controller: 3 samples x 4 completions, after warmup | 180 Promises / 4 calls | 180 Promises / 4 calls |
| Image sampled bytes/completion | 270362 / 237844 / 223468 | 299798 / 259474 / 246412 |
| Image instrumented time / 4 calls ms | 145.625 / 136.883 / 136.313 | 154.458 / 159.825 / 138.357 |
| Image post-GC heap delta bytes | 735824 / 338496 / 36760 | 814368 / 317376 / 37536 |
| Image private opens / 4 calls | 8 (text spill + marker) | 16 (also one deduped image + manifest per call) |
| Image normal/script-error/abort/disk-failure owner release | 0/84 retained WeakRefs | 0/105 retained WeakRefs |

The image fixture uses a real controller/worker, two identical images and 20k
text characters, including the real cap and file writes. Its additional disk
failure cycle is candidate-only; normal performance samples are identical.
Existing full async-chain Promises remain nonzero. Leading image allocations
remain inspector post, V8 API, decode, fromStringFast and runtime bookkeeping.
HeapProfiler includes collected allocations and fixture/runtime overhead; heap
deltas retain profiler records. These samples show feature cost, not an
improvement or a statistically established CPU regression. No performance pool
was proposed. Image byte/count limit tests are larger than this tiny-image
profiling fixture; the profile does not establish worst-case image latency.

Raw evidence and reproducible commands/loaders/profiles:
`.git/f07-codemode-images-20261012/`. All fixture resources are removed by recorded
identity; no new persistent process, service, worktree or global install change.
Tests are offline; no real provider, physical-terminal visual or OS expiry test.
