# N2: staged file commit evidence

Status: **实现与复审中**. Parent N1 is `1914ba15e65e300a0258affe449fcd26e6f3f690`.
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
exposed to model tools. An unavailable adapter is selected before any commit work
as explicit protected in-place compatibility, never after a safety rejection.

| Object/platform | Proposed selection and necessary evidence |
| --- | --- |
| Linux ordinary local single-link file | Bounded handle-based extended-attribute inspection; copy supported mode/owner metadata, sync, validate and rename; actual CI required |
| Linux visible ACL/xattr | Preselect protected in-place compatibility and verify bounded attribute names/values plus mode/owner |
| Linux capability/special mode | Refuse before writing: kernel writes may clear these attributes; no restoration or privilege expansion |
| Windows local single-link ordinary file | Use documented [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) metadata behavior, no ignore-ACL/merge-error flags; actual DACL/ADS/attributes tests required |
| Hardlink | Preserve existing object through preselected protected in-place compatibility; explicitly no staged-replacement guarantee |
| Link/reparse/special file | Preserve existing rejection boundary; no new object capability |
| Read-only/occupied target | No permission override; exact error/outcome testing, no fallback retry |
| Network/unknown filesystem | No local-filesystem atomicity claim; choose compatibility before mutation or refuse precise unsupported case |
| Adapter unavailable/unsupported platform | Explicit preselected protected in-place compatibility, visibly without staged-replacement guarantee |

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
