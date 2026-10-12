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
The text cap must reserve this notice even when it truncates preceding output;
paths too long for the budget use the explicit metadata fallback described below.

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

76 distinct checks passed across integration/provider conversion, image/output,
projection/read provenance and source invariants. Six focused file checks cover actual Windows
owner/protected DACL on both binary and manifest files (POSIX mode checked on
that platform), native handle release, signatures, 8/16 MiB limits, count cap,
dedup, partial writes, projection boundaries, relative/deep temporary roots and
a 256-token output budget. Final affected reruns passed 6 file, 22 integration
and 14 output/hot-path checks; the preceding 49-check projection regression
passed. Root typecheck and coding-agent build passed. Overlapping reruns are
not counted as additional distinct checks.

Source audit confirms the existing VM/worker bridge, nested dispatch, Agent/
Session, estimator/spill, UI/tree/Image, Main/Alt rendering and terminal queue
are unchanged. The Codemode text-projection loop after notice reservation is
identical to the merged baseline. The model projector change below only evaluates
its final bounded shrink candidate; source comparison confirms no other edits.
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
| Image sampled bytes/completion | 270362 / 237844 / 223468 | 315354 / 255696 / 261768 |
| Image instrumented time / 4 calls ms | 145.625 / 136.883 / 136.313 | 147.898 / 183.399 / 163.225 |
| Image post-GC heap delta bytes | 735824 / 338496 / 36760 | 830960 / 306784 / 53008 |
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

## CI correction design gate

Initial Linux shard 2 reproduced a read-provenance regression in the existing
`blocked adjacent images ... projected=true` check. It also fails locally on
Windows. Moving the optional notice away from the last native read and making
it compact did not reliably resolve it; those edits alone were not a fix.
The diagnostic loader captured estimates 1195 -> 1061 -> 1031 -> 1025 against
the unchanged 1024 budget. The fourth shrink computed another candidate, but
the loop discarded it without evaluation and emitted a full-omission view.
Snapshot/cursor text can move this final estimate by a few tokens, explaining
intermittent success. A fixed-string metadata/read fixture fails independently
of workers, platform and snapshot randomness.

This newly exposed integration dependency requires evaluating the fourth
computed reduction before omitting read evidence. Keep four reductions, allow
the initial estimate plus their four evaluations, and retain the bounded
fallback if it still cannot fit. The loop adds no factories, promises or state;
profile projection arrays/scans and reference release separately. Keep the
file notice compact and in the controller-owned summary; do not raise budgets,
weaken read checks or alter native block identities. The text cap still reserves
file recovery information when truncating.

The original blocked-image/read integration case and 20 selected integration
checks pass. The fixed-string regression checks 16 path-length variants. A
separate projection profile (3 x 96 results after 16 warmups) retains the
affordable read in 79/96 baseline cases and 96/96 candidate cases. Both versions
use 0 Promises, 401 projection arrays and 96 full source scans per sample; all
1152 WeakRefs are collected and owner records/references are zero after disposal.
Sampled bytes/result: baseline 27175.833 / 25139.917 / 24946.917; candidate
27165.500 / 25451.583 / 25318.417. Instrumented times/sample: 78.212 / 47.105 /
78.015 ms versus 106.503 / 103.386 / 114.730 ms. Post-GC deltas: 398928 / 24840 /
35944 versus 410848 / 31168 / 35768 bytes. The candidate performs the previously
missing evaluation and retains more text; these profiler samples do not claim
a CPU improvement. No factory or additional full-source scan was added.

## Review correction design gate

Relative TMP/TEMP/TMPDIR values must be resolved at completion before creating
files: both the persisted manifest location and its binary paths must survive
a later cwd change. The review fixture currently fails this absolute-path
requirement. A second case uses a deep temporary root and the minimum 256-token
budget. Recovery notices must fit independently of path length: first omit the
text-spill path, then use a fixed short notice if even the image path cannot fit.
Keep the complete image location in saved result metadata, retain attachments
and execution status, and explicitly explain that paths were omitted. Never
shorten a path into a misleading usable-looking location or rerun completed tools.

Both issues were reproduced and the combined fixture now passes. Windows deep
paths use the platform namespace form so the fixture exercises the actual long
path budget boundary, rather than an earlier OS directory-creation failure.
The fallback reuses the existing notice and estimator sample; it adds no
per-block callback/container. Real controller/worker profiling was repeated
after these final corrections; its candidate values above are from that run.

## Projection visibility review gate

A later review identified that appending the manifest notice after all child
facts could put it in the omitted middle of a subsequent head/tail projection,
even when the script-level cap had retained the complete result. Reproduce in
the real AgentSession with eight long failure previews, a large script budget
and smaller 512/1024 model budgets. Put the notice immediately after the fixed
summary header, before any variable child facts, so the retained head exposes
the path. Preserve the summary block identity/count and read-provenance offsets;
do not introduce a new generic projection API or copy images into extra blocks.

Both budget cases first failed because the next model request lacked the path.
After moving the existing notice before the child-fact loop, both retain the
complete path and successfully read its manifest in the next invocation; all
22 selected integration/provider checks pass. This final change only reorders
existing completion statements and adds no allocations, factories or scans.
The normal image benchmark has zero child facts and produces identical summary
text/order under this change, so its final allocation evidence remains applicable.
