# N2: staged file commit evidence

Status: **实现中**. Parent N1 is `a7b5e41c11a7d9a410f722ecc7e00c792c062c34`.
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

Proposed decision, pending user selection: pin Koffi 3.3.1 (MIT) for a small private
platform adapter. It provides [prebuilt Windows/Linux binaries](https://koffi.dev/)
and requires maintaining a native dependency, install-script allowance and packaged
binary smoke checks. The adapter would only expose bounded metadata capability
inspection and the required platform commit primitive; no arbitrary FFI would be
exposed to model tools. An unavailable adapter is selected before any commit work
as explicit protected in-place compatibility, never after a safety rejection.

| Object/platform | Proposed selection and necessary evidence |
| --- | --- |
| Linux ordinary local single-link file | Bounded handle-based extended-attribute inspection; copy supported mode/owner metadata, sync, validate and rename; actual CI required |
| Linux ACL/xattr/capability/special mode | Preselect protected in-place compatibility unless every required attribute can be preserved and verified; no silent loss |
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

Independent work can extract the shared primitive, preserve final authority/signal
and prepared identity/content checks, add failure classification and regression
fixtures while this dependency decision is pending. N1 review and N3/N4 can continue.

## Shared core slice

`file-commit.ts` implements bounded handle hashing, verified source/parent identity,
exclusive same-directory staging, sync/close handling, final authority/signal gates,
preselected in-place compatibility, postcommit object/content checks and identity-
checked temporary cleanup. It has not yet been connected to production mutation
callers: metadata capability selection remains the dependency decision above.

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
