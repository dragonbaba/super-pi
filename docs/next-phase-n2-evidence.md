# N2: staged file commit evidence

Status: **实现与复审中**. Parent N1 is `d1bad1788e620810caf60914dd330b78ea26981d`.
No claim of N2 acceptance or cross-platform metadata preservation is made yet.

## Observed baseline and capability decision

The existing snapshot commit writes/syncs a same-directory exclusive temporary,
copies mode bits with chmod and renames it. Exact and overwrite call writeFile on
the existing name. Snapshot cleanup currently removes the temporary by name without
rechecking ownership. These paths share neither metadata selection nor a common
commit outcome type.

On Windows with Node 22.19.0, an isolated synthetic baseline probe observed:

- a two-link target became a new one-link object after rename; the other name kept
  the complete old content;
- the target's named NTFS data stream was absent after replacement;
- target inode changed and the new primary content was complete.

Raw probe: `D:/RMProjects/Pi-next-phase-artifacts/n2-node-capability-probe.json`.
Only the probe's recorded temporary directory was removed.

This agrees with [Node 22.19's libuv Windows implementation](https://github.com/nodejs/node/blob/v22.19.0/deps/uv/src/win/fs.c):
rename uses MoveFileExW, not ReplaceFileW. Node's
[chmod API](https://nodejs.org/download/release/v22.19.0/docs/api/fs.html#fschmodpath-mode-callback)
cannot copy Windows DACLs. Linux
[extended attributes](https://man7.org/linux/man-pages/man7/xattr.7.html) can contain
ACLs/capabilities beyond stat's mode/owner fields. A regular single-link stat result
alone therefore does not establish that plain rename preserves necessary metadata.

Approved by the user on 2026-09-27: pin Koffi 3.3.1 (MIT) for a small private
platform adapter. It provides [prebuilt Windows/Linux binaries](https://koffi.dev/)
and requires maintaining a native dependency, install-script allowance and packaged
binary smoke checks. The adapter would only expose bounded metadata capability
inspection and the required platform commit primitive; no arbitrary FFI would be
exposed to model tools. An unavailable adapter now refuses modifications before
any commit work; unrelated reads remain available. It never triggers a retry.

| Object/platform | Proposed selection and necessary evidence |
| --- | --- |
| Linux ordinary local single-link file | Bounded handle-based extended-attribute inspection; copy supported mode/owner metadata, sync, validate and rename; actual CI required |
| Linux visible ACL/xattr | Preselect protected in-place compatibility and verify bounded attribute names/values plus mode/owner |
| Linux capability/special mode | Refuse before writing: kernel writes may clear these attributes; no restoration or privilege expansion |
| Windows local single-link ordinary file with modern inherited or protected DACL | Use documented [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) metadata behavior, no ignore-ACL/merge-error flags; actual DACL/ADS/attributes tests required |
| Windows legacy unprotected explicit DACL | Preselect original-object compatibility: copying/replacement normalizes ACE inheritance semantics; verify owner/group/DACL, attributes, creation time before/after |
| Hardlink | Preserve existing object through preselected protected in-place compatibility; explicitly no staged-replacement guarantee |
| Link/reparse/special file | Preserve existing rejection boundary; no new object capability |
| Read-only/occupied target | No permission override; exact error/outcome testing, no fallback retry |
| Network/unknown filesystem | No local-filesystem atomicity claim; choose compatibility before mutation or refuse precise unsupported case |
| Adapter unavailable/unsupported platform | Refuse modification explicitly before effects; reads/queries remain usable. ARM, musl and macOS are not validated |

Windows ReplaceFileW can have partial failures. Its documented failure states must
be represented as partial/unknown and observed; a failing call cannot automatically
be reported as no change. The adapter's metadata scope and rejected attributes must
be established by tests before enabling this selection. No claim covers all
cross-process races or power-loss durability.

Without a new native dependency, the conservative choice is the shared protected
in-place path, identity-checked temporary cleanup and honest guarantee reporting.
That would improve safety but would **not** satisfy the plan's required normal-file
staged replacement on both platforms; N2's capability delivery would remain pending.

The dependency decision is approved; no repeat permission request is needed.
The shared primitive and native adapter must preserve final authority/signal and
prepared identity/content checks. N1 review and N3/N4 remain in the original scope.

## Shared core slice

`file-commit.ts` implements bounded handle hashing, verified source/parent identity,
exclusive same-directory staging, sync/close handling, final authority/signal gates,
preselected in-place compatibility, postcommit object/content checks and identity-
checked temporary cleanup. Snapshot, exact and overwrite now use it in production;
exclusive creation remains the separate existing creation primitive. Commit strategy
is recorded before staging, receipts preserve committed/unknown outcomes through
single and batch tools, and compatibility/retained temporary state is displayed.
Receipt persistence failure does not report a successful/no-change operation.

Seven Windows Node 22.19.0 tests passed, including BOM/CRLF publication, failed
staging/sync/close, target content/object drift, disappearance, cancellation,
authority loss, changed temporary identity/content, postcommit cancellation,
unknown platform outcome and hardlink-preserving compatibility. The fixture's plain
rename backend applies only to its own synthetic files and is not a production
metadata guarantee. Type check passed. Platform metadata, real SDK integration,
subprocess termination and final full-candidate gates remain pending.

The local Windows probe also demonstrated that retaining our source read handle
through rename can yield EPERM. The shared core closes the verified handle before
the final synchronous authority/signal check and publication; it never retries a
failed replacement. This final close and pathname syscall still leave the documented
external-race boundary. Raw test log: `n2-shared-core.log` in the artifact directory.

The current native slice pins `koffi@3.3.1` in the mutation extension's runtime
dependencies, with exact official platform dependencies in the lockfile. Main and
Windows/Linux x64 packages are MIT; registry manifests, signatures and SRI values
are saved as `n2-koffi-*-metadata.json`. The downloaded main tarball's SHA-512 matches
the registry SRI. The inspected install script loads the installed prebuild or
attempts local compilation; its packaged header-download branches throw instead of
downloading. The real Windows install-script run passed. Only `koffi@3.3.1` was added
to the existing allowScripts map. Four unrelated npm10 libc-field omissions were
restored; no unrelated package versions changed.

The fixed worker bootstraps Windows' already-loaded kernel32 KnownDLL, obtains the
system directory from GetSystemDirectoryW (not SystemRoot/cwd), and loads advapi32
by that absolute OS path. Linux uses fixed absolute glibc paths and fixed symbols. It starts
on first mutation capability request and reuses bindings; no provider/progress/TUI
path loads it. Windows APIs run synchronously on that worker so GetLastError stays
on the calling thread. Requests are bounded to 16 in flight; no cancellation kills
a worker during an OS operation. Windows metadata scope is owner/group/DACL, normal
file attributes, creation time and ReplaceFileW's documented named-stream behavior.
Privileged audit SACLs and advanced attributes are not a preservation claim. Linux
staging requires a supported local filesystem, ordinary current-user ownership/mode
and no listed extended attributes; visible ACL/xattr targets use verified
preselected in-place compatibility, and special modes/file capabilities are refused. Inaccessible inspection is an error, never
proof of absent attributes. Privileged namespaces not visible to the caller are
outside the supported metadata claim. ARM, musl, macOS and other platforms are not
validated by this work.

Windows cleanup now uses FileDispositionInfo on the exact verified Win32 handle,
so a subsequent pathname replacement is not the deletion target. Linux has no
equivalent conditional-by-inode unlink in this adapter; failed staging retains and
reports its temporary rather than performing unsafe check-then-unlink. Successful
replacement consumes the temporary. Missing-parent cleanup is reported as uncertain.
Protected in-place writes use explicit positional offsets, even if a metadata
callback advanced the descriptor cursor. After final asynchronous source gates,
the staged identity/content are checked again. The worker rechecks both objects,
hashes and parent just before its synchronous publication call. This closes the
reviewed asynchronous callback/dispatch gaps, but pathname APIs still leave a final
external-race boundary; no OS compare-and-swap guarantee is asserted. Unknown
publication retains the temporary for recovery; documented no-change native errors
also require actual original-content/identity/metadata observation.

The first draft CI passed Linux but exposed an unsafe Number conversion in the
Windows hardlink test's inode assertion (24488322975190223 rounded to
24488322975190224). Production identity uses bigint. The assertion now does too.
The next Windows slice passes check and 13 tests, with one explicit POSIX-only
skip, including final source-await drift and cleanup-primitive drift regressions.
Raw log: `n2-publication-boundary.log`. Native slice Linux CI is still pending.

## Native bridge investigation (development candidate)

- Known-good control: worker startup, fixed library binding and `stats` succeed on
  Node 22.19.0 Windows x64; seven pure shared-core tests also pass.
- Failure: first real metadata inspection terminates its test process with
  3221226505 (`0xc0000409`), before an ordinary test result. No production caller
  uses the adapter yet. Artifact: `n2-native-first.log`.
- Comparison axis: binding/startup works; invoking metadata on a Node-owned CRT
  descriptor fails. Initial hypothesis: `_get_osfhandle` in separately loaded
  ucrtbase does not own Node's descriptor table. This is a hypothesis until the
  isolated call probe confirms the failing boundary.
- Constraints: “不扩大权限或请求提权” and “异步调用必须正确处理线程相关错误信息”.
  No global invalid-parameter handler override, ACL bypass, disabled verification
  or suppression of the crash is an acceptable fix.
- Next probe: child-process CRT conversion versus a Win32-owned handle opened and
  closed in one native worker scope, using a recorded synthetic artifact path.

The isolated probe confirmed the distinction: CRT conversion exits -1073740791
immediately after its pre-call marker; Win32 CreateFile/GetFileInformation/CloseHandle
all succeed on the same Node 22.19.0 process setup. Artifacts are `n2-native-crt.log`
and `n2-native-win32.log`. The fix removes the CRT binding entirely and gives the
worker its own Win32 handle, comparing volume/file identity against the prepared
Node stat before inspection. No global error handler or safety check changed.
Normal and >260-character Chinese-path replacements now pass with real content and
named-stream preservation, zero active native handles and zero pending requests.
Together with shared-core regression, 11 tests pass and one POSIX parent-rename case
is explicitly skipped on Windows. This is development feedback, not final acceptance.

## Integrated development candidate

The first native slice `e2b97d6b426f63e11f07366b0c87a0c06d708239` reached real Linux
CI. Its loader refused `ssize_t` because that typedef is not built into Koffi. The
adapter now binds `intptr_t`, the signed pointer-width return for the supported
Linux x64 glibc ABI (both intptr_t and size_t confirmed as eight bytes). This fix
requires a fresh Linux CI run; the earlier run is not counted as passing.

Windows Node 22.19.0 check and ten targeted suites now pass 155 cases, with three
explicit platform skips. These include real default SDK mixed-tool assembly,
snapshot/exact/overwrite, R1 alias/file/parent drift, final permission/cancel gates,
Session receipt/reopen, bounded preview and recovery. Existing injection/counters
were moved to actual bounded handle reads and worker publication dispatch, retaining
successful positive controls and the original before/after filesystem assertions.
Linux failed-stage tests now require an explicit retained-temp receipt and actual
candidate bytes, rather than unsafe unlink or silently ignored leftovers.

Native Windows tests additionally compare an actual protected DACL's SDDL before
and after publication, preserve named streams and creation metadata, exercise a
separate process holding a non-delete-sharing handle (Win32 32, verified original
bytes/identity, no retry), and verify hardlink/readonly selection. A copied official
Koffi package without its platform subpackage exercises the real missing-binary
diagnostic while ordinary reads remain usable. Synthetic partial-publication fault
1176 confirms candidate recovery data is retained when the original name disappears.
The synthetic fault is not claimed as a naturally reproduced OS partial failure.
Raw logs: `n2-shared-integrated.log`, `n2-native-matrix.log`, `n2-r1-shared.log`.
Clean-install/delivery smoke, costs, final fixed-head checks, both CI platforms and
actual final review remain required.

## Integrated review follow-up

Actual review on `e36436afbab29236bd6c58e0b1d2342f777f0a69` reported four more
metadata findings. The implementation now refuses Linux special permission bits,
preselects compatibility for a non-writable parent, rechecks both objects' supported
metadata inside the publication worker, and writes candidate bytes under private
permissions (0600 on Linux; protected owner-only DACL on Windows). Publish metadata
is applied after candidate writing and final source callbacks, followed by sync.
Verified unpublished failures restore private access before cleanup/retention;
unknown placement is not chmodded and the receipt explicitly says privacy is not
re-established. No automatic retries or elevated permission are involved.

Linux visible attribute values have a 256 KiB inspection bound; errors and changes
are errors, not absence. In-place mode/owner/link counts are checked before/after.
Source/Jiti reloads share one process-owned worker without Session references; ten
reloads and an attempted in-flight disposal verify one worker and zero pending
calls/active handles. Idle workers are unreferenced, not unloaded during calls.

Windows Node 22.19.0 targeted follow-up: 111 passed, four platform skips across
native/shared core, final exact authority/cancel boundary, and path semantics.
The integrated Linux CI failure was stale instrumentation accepting only the old
snapshot temporary name. Windows initially stopped at a zero-publication counter;
the subsequent native benchmark exposed a real DACL preparation failure (see below),
so that earlier Windows result cannot be attributed solely to instrumentation.
Counters now also observe pinned handle writes; assertions still require original targets, untouched literal aliases,
zero forbidden publication and actual successful postimages. No contract is disabled.
Raw follow-up log: `n2-review-native.log`. Fresh Linux verification, delivery smoke,
five-process cost results and full candidate acceptance are still pending.

Formal delivery smoke now executes `scripts/superpi.mjs` after `build:offline`,
using the default bundled assembly and an offline provider fixture. Real dedicated
reads feed exact edit, overwrite and snapshot edit; all three native staged receipts
and final Chinese-path bytes are checked. An explicit network-denying preload
records zero network attempts. The actual private extension `npm pack` includes
the `.mjs` worker and exact runtime dependency; extracted installed-runtime smoke
loads its copied installed official platform binary with zero network attempts.
This is source-workspace delivery plus the private extension's package contract,
not a newly invented standalone CLI binary release. Initial Windows pack measures
84,313 compressed / 339,309 unpacked bytes (excluding dependencies); final package
size will vary with subsequent source changes. Both smoke tests pass on Node 22.19.0.

## Windows CI ACL investigation

Known-good: `2003aa9078cdf4d3b3a4a75ab323282513ec5eff` passes clean npm ci,
check, a network-denying installed build:offline, hot/full tests, five native cost
processes and the tool-leaf allocation gate on local Windows Node 22.19.0.
CI Windows run `36258866606`, job `108450723002`, fails before full tests in
native cost process 0: SetSecurityInfo returns but exact owner/group/DACL verification
fails, with a not-committed receipt and unchanged target. Log:
`n2-2003-windows-job.log`. Local four-parent-ACL probes (owner, CREATOR_OWNER,
Users and Administrators variants) all pass: `n2-acl-probe.log`.

Comparison axis: synthetic inherited descriptor semantics on CI versus local
Windows; native loading and fixed signatures already work in both. Hypotheses are
inheritance normalization, owner/group differences or ACL unused bytes, not proved
root causes. A gated CI-only benchmark diagnostic captures only the synthetic
fixture descriptors before/after prepare; no real workspace file or credential.
Constraint: “不使用忽略 ACL/属性合并错误的选项来假装元数据保持成功”. The
comparison and no-fallback behavior remain unchanged while collecting evidence.

The diagnostic in `e100be64d598efa3320c9c99babe0dbc9a65330b`, Windows job
`108452400251`, proves the distinction: original control 0x8004 with three explicit
ACEs becomes 0x8404 with six ACEs after SetSecurityInfo (three original plus three
inherited). This is inheritance, not padding. A local test-only legacy descriptor
fixture reproduces the failure. A separate probe also disproved simply leaving the
private DACL for ReplaceFileW: that API normalized the original explicit ACEs into
inherited ACEs. Neither is accepted as exact preservation.

Selection now recognizes legacy unprotected descriptors before effects and keeps
the original object. Modern inherited and protected descriptors retain staged
replacement. Actual legacy tests verify bytes, same inode and exact security
fingerprint; actual modern/protected tests verify replacement plus postimage
metadata. The benchmark and staged source-entry test explicitly construct a
protected synthetic descriptor before measurement; they do not disguise CI's
default legacy descriptor as staged support. The temporary CI descriptor logging
and benchmark wrapper were removed. No production obsolete security API, ignored
merge flag, privilege change or fallback retry was added.

Review on `2003aa9078cdf4d3b3a4a75ab323282513ec5eff` also found three boundaries:
Linux capability inspection must precede hardlink/foreign-owner compatibility;
non-assignable groups must preselect object preservation; retained overwrite
candidates must persist verification/no-retry even with unchanged target bytes.
These are fixed with real Agent/Session retained-candidate regression, real
hardlinked files plus explicitly injected capability observations, and injected
process-group availability without changing credentials. Actual capability-bearing
files are not claimed by that injected regression. Missing native inspection now
refuses modifications, avoiding an unchecked capability-bearing in-place path.

Local Windows Node 22.19.0: native/delivery follow-up passes 15 tests, six Linux
skips; retained overwrite passes one further test. Current pack: 85,438 compressed /
344,099 unpacked bytes (excluding installed dependencies; sizes vary with source).
Earlier `e100` Linux CI measured installed platform package 2,387,558 bytes and
five first-load times 81.32–90.14 ms, event-loop maximum 5.88–6.77 ms. Those figures
are platform evidence for that head, not acceptance of the new candidate. Fresh
full local gates, both CI platforms, cost runs and review remain required.

## Final boundary follow-up

`fb0c0f1fbf21acbb6a416b0e4504dab7513bb099` passed local check, offline
build, hot/full tests and five native cost processes. Its Linux CI passed; Windows
CI `36260905896` exposed eight snapshot fault-injection cases whose default legacy
DACL selected compatibility before their staged-only injection. Tests now exercise
both explicitly staged and hardlinked in-place paths. This exposed a genuine final
async-read identity gap in in-place writes: the old handle could survive a renamed
target. A final worker check now rechecks the handle, source bytes, parent, aliases
and pathname identity before returning to the synchronous authority/signal gate.
It is still not an OS CAS. Real publication-attempt counters distinguish dispatch
from entering ReplaceFileW/rename; positive controls also prove those counters.

The actual review's six findings are covered by this follow-up:

- Retained candidates propagate verification/no-retry through core, batch results,
  durable Session entries and recovery. Verification also observes the bounded
  recorded sibling candidate. Observation excludes the old failed item from any
  new remaining draft; it does not authorize retry or cleanup.
- Linux parent default ACLs are inspected before staging and preselect preservation
  of the existing ACL-free object. Attribute values are hashed with fixed-width
  name/value lengths and names, eliminating ambiguous decimal concatenation.
- Windows replacement selection requires owner/group matching the process token's
  defaults, queried read-only with [OpenProcessToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken)
  and [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation).
  Other owners/groups select in-place preservation. No privilege is enabled.
- The security fingerprint includes owner/group defaulted and DACL presence,
  defaulted, inheritance-request, auto-inherited and protected
  [control flags](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-control),
  with framed component lengths. Unsupported defaulted/request/presence layouts
  select preservation before effects.

Windows Node 22.19.0 targeted checks: 110 pass / eight Linux-only skips across
118 tests, plus one actual non-default-owner regression passes (no privilege
adjustment). Actual control-only DACL drift changes the fingerprint with identical
owner/group/ACE bytes and is rejected before content effects. The Linux ACL and
ambiguous-value fixtures await Linux CI for this candidate. Fixed-head full local
gates, five-process costs, two-platform CI and re-review remain pending. Native
inspection still occurs only in the fixed private worker, with handles/buffers
held until completion; ordinary startup, deltas, progress and render do not load it.

The preceding `98f2c580397994ba517a1adb5c532b4496133d8e` candidate completed
all local gates/five-process costs and both Node 22.19 CI jobs in
[run 36263238718](https://github.com/dragonbaba/super-pi/actions/runs/36263238718).
That includes actual Linux ACL/xattr checks and source/installed/build/package
delivery, not merely Windows helper tests. Subsequent review found archive-cleared
Windows files and Linux file-mount capability selection; the next candidate fixes
these and incorporates N1 `8ecd98981c231c12814488ee5847a17d27c46a5b`.

Windows NORMAL/ARCHIVE attributes are copied to the completed candidate using
[FILE_BASIC_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info).
Real tests showed that [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)
and an in-place write can set ARCHIVE again. Supported attributes are therefore
restored on an identity-checked published object after data handles close, then
verified with bytes, owner/group/DACL and creation time. Flags remain zero; this
is a multi-step metadata completion, not an atomic metadata transaction. A failed
restoration after writing reports unknown/possibly partial and never retries.
Real NORMAL-file tests cover replacement and both hardlink names; injected native
finalization failure observes changed bytes, unchanged inode, remaining ARCHIVE,
one restoration attempt and zero retained worker handles/pending calls.

Linux inspection reads a bounded 4 KiB `/proc/self/fdinfo/<owned-fd>` record and
requires its [mount identity](https://man7.org/linux/man-pages/man5/proc_pid_fdinfo.5.html).
Different target/parent mount identities select object preservation before staging;
missing/unreadable mount identity is an explicit capability failure. The regression
cross-checks real fdinfo and injects the differing-mount observation, then verifies
the actual in-place write/inode. It does not claim an actual writable bind-mount
fixture or enable mount privileges. Linux execution awaits this candidate's CI.

The user's regex/closure correction is applied across N2: the plain-ESM worker's
fixed pattern is in `native-file-regex.mjs`; recovery patterns use `regex.ts`.
Worker actions/token/descriptor helpers and dispatch are module functions with
explicit arguments. A prepared metadata owner uses shared prototype methods,
without captured per-check callbacks or retained open handles. The native client
uses Node 22's deferred primitive; per-request Promises, resolver functions and
payload allocation remain necessary and are not called zero-allocation. AST
gates reject inline/nested callback definitions in all three adapter modules.
The missing-binary isolation fixture now copies the worker's pattern dependency,
so it still tests the actual Koffi missing-binary diagnostic. Windows focused
validation: check passes; 83 tests, 73 pass, ten explicit platform skips. Final
new-head full gates, costs, CI and actual review remain required.

Review 4112386161 requests eliminating the final external-process pathname race.
The user's approved scope explicitly says native replacement is not OS CAS,
a cross-process lock or a cross-file transaction. Synchronous final identity/byte/
metadata checks reduce the observation gap but do not exclude a concurrent writer
between observation and the system call. This is an accepted documented limitation,
not a claim of eliminated races; no lock/transaction architecture was added.

`288015d2fbb14f3c373779365903b07ec3e2cb88` completed all local gates
and five-process costs. The next integration incorporates N1's physical-index,
duplicate-history and final-workspace checks, with the same full-request hash on
N2 exact/snapshot/overwrite intents. Thirty-three targeted recovery/retained-
candidate tests pass with check. Completion text/recovery-warning scans now avoid
their remaining map/filter/some callbacks. Remaining request-bound queue and
receipt callbacks are created once per prepared call/item and released with that
owner; they are not created by native checks, provider/progress or render delivery.

The 288015d2 review's ACL and post-publication findings are fixed in this PR.
Windows capability selection opens the prepared object with FILE_WRITE_DATA,
READ_CONTROL and FILE_READ_ATTRIBUTES; fs.access alone does not establish DACL
write access. A real deny-WriteData fixture remains readable, rejects direct
writing and native selection, and creates no candidate. After ReplaceFileW has
succeeded, a metadata-finalization failure carries a committed marker through
the worker/client/receipt: new bytes are known published, metadata still needs
verification, and the consumed candidate is not claimed retained. An isolated
copy of the actual worker injects a missing metadata path only after the real
replacement, observes Win32 2, changed inode/bytes, one publication attempt,
zero native handles/pending calls and no leftover candidate. The focused Windows
metadata suite passes 21 tests, with nine Linux-only skips. Both fixes retain
fixed bindings and the dedicated-regex/no-inline-callback source invariants.

The afab/cffd review adds a publication-specific access probe. Before a candidate
exists, the worker opens the prepared target using the documented ReplaceFileW
GENERIC_READ | DELETE | SYNCHRONIZE rights and existing sharing mode, validates
its identity and closes the handle. Only explicit ERROR_ACCESS_DENIED preselects
object preservation; all other native failures propagate. This does not authorize
fallback after validation/publication failure. The real Windows fixture denies
DELETE on the target and DELETE_CHILD on its parent, proves r+ still works, then
checks preserved inode, bytes, complete security fingerprint, attributes and creation
time, no candidate/publication, and zero active handles/pending calls. The metadata
suite passes 22 Windows tests with nine Linux-specific skips; check and four focused
boundary/source tests pass. API rights source:
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew

The d314616ce candidate passed all local gates and both platform CI jobs
([run 36270884960](https://github.com/dragonbaba/super-pi/actions/runs/36270884960)).
Its next review exposed four remaining boundaries. Windows now creates the empty
candidate with a protected process-user-only DACL in CREATE_NEW itself, using a
fixed x64 SECURITY_ATTRIBUTES binding. No broadly inherited handle-opening window
precedes later protection. Owner/group defaults remain assigned by Windows; the
descriptor and ACL buffers live through the synchronous worker call. Created
identity and post-create failures are returned together; a lost response reports
the possible candidate without deleting an unproved name. Actual broad-parent and
exclusive-name tests check the initial descriptor before any protect operation,
unchanged existing bytes on CREATE_NEW collision and zero native handles/pending
calls. The API accepts the descriptor at creation:
[Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).

The publication access probe now includes GENERIC_WRITE because the replacement
file receives the same target DACL and ReplaceFileW requests that access too. An
actual deny-AppendData ACL preselects compatibility before staging; Node r+ also
requires GENERIC_WRITE, so this case explicitly refuses without creating a candidate
or changing the target. The earlier deny-DELETE writable compatibility case still
passes. No permission is expanded and no failed operation is replayed.

Linux xattr names now reach fgetxattr as bounded raw NUL-terminated bytes; reserved
ASCII names are compared bytewise. A real user.0xff name regression verifies the
name and value survive object-preserving writing. It is Linux-only and requires
new-head CI; Windows does not claim that execution. This follows the native name
contract in [fgetxattr(2)](https://www.man7.org/linux/man-pages/man2/fgetxattr.2.html).

Recovery requires bounded equality of commit strategy, outcome, sync facts and
retained-candidate/cleanup fields across the durable terminal and aggregate mirror.
A real failed staging sync with retained candidate verifies the genuine receipt;
five independently decoded mirror corruptions refuse verification/drafting.
N1 25be592c6 is integrated normally; its snapshot readback regression now injects
failure after actual N2 publication through the owning read handle, retaining the
same changed-byte/partial-receipt assertions. Windows Node22.19 check passes;
91 focused tests: 80 pass and eleven explicit platform skips. Final whole-project
gates, both platforms and actual new-head review remain required.
