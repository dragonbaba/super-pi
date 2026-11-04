# Sandbox PowerShell 7 and host PATH toolchains

## Evidence before implementation (2026-11-04)

- User constraint: sandbox execution must use PowerShell 7, never Windows PowerShell 5.1 or a host fallback. Discover tools from the host PATH by default; configuration is for exceptions, not a per-tool prerequisite.
- Host control: PowerShell 7.6.9 Core successfully ran Node 26.13.0, npm 11.20.0, Python 3.13.7 and Git 2.56.0.windows.4 (all exit 0). Child TMP/TEMP/TMPDIR were verified inside the task root.
- Failure: the user's sandbox commands found Node but failed to resolve npm, Python and Git. Error output exposed raw CLIXML.
- Mechanism: `workspace-backend.ts` copied only `node.exe`; `windows-sandbox-task-worker.cs` selected the OS PowerShell 5.1 executable and hardcoded a minimal PATH. The legacy task entry and the older acceptance guest also selected 5.1. Existing PowerShell 7 source guards covered host helpers, not these guest entries.
- Packaged/source control: the task-worker source and current offline distribution both had SHA-256 `f4653967d50f7dacb56cdd5259a05c01afe9a9088e87053f9e5dc7004fd57efd`. This is a source defect, not a stale-build explanation.
- Additional host command resolution: gh, Go, Java/Javac, .NET, Rust/Cargo, Bun, rg, uv and adb have entries. This alone does not prove their dependencies work in a VM. cmake/ninja were absent from the current PATH, not proven absent from disk.
- A preliminary 5.1 diagnostic inherited the Core module path and failed module autoload. It is not evidence of broken host installation and will not be rerun.
- Exact scratch owner: `.task-tmp/sandbox-env-diagnosis-3a8d113ce7e7/resources.json`. The previous README task root is unrelated and has a recorded cleanup rejection; do not retry its deletion.

## Implementation and acceptance scope

Trace settings → session backend → toolchain discovery → read-only guest mounts → gated PowerShell process → Job settlement. Preserve offline networking, project snapshot isolation, authorization/writeback checks and exact VM ownership. Discover and translate installation directories, remove duplicate/invalid PATH entries, account for installation-relative dependencies and distinguish unresolved shims. Do not inherit credentials or the host user profile as a toolchain.

Discovery and manifest construction belong to VM startup. Keep the existing bounded output pumps unchanged; avoid per-chunk closures, regex construction and output copies. Validate PowerShell 7 with a guest version guard and text output, test negative discovery cases and settings trust, then rebuild offline and exercise the real production backend before the PR review/CI gates.

## Implemented behavior

Both workspace and legacy task entries use the same PowerShell 7 command launcher, with an exact Core/major-version guard, disabled implicit Windows compatibility, explicit text output and guest-local home/cache/temp directories. The fixed historical transport probe and its gate fixture also use 7; no sandbox shell launch path names the 5.1 executable.

`SandboxToolchains` discovers host PATH installations automatically. `bin`/`cmd`/`Scripts`, same-name WinGet aliases, Rustup and installation-root variables cover common layouts; global `sandboxToolchains.include` / `exclude` are exceptions only. C-drive installation paths remain usable; other drives use read-only mounts plus guest-only DOS drive aliases. The whole host drive, project, home directory and environment are not mapped. Reserved guest directories cannot be shadowed. Project settings cannot expand mounts.

Asynchronous directory inspection checks links before VM creation. Unsafe optional roots are omitted; mandatory/explicit roots fail closed. This found an actual external project link under the old Node 26.4.0 PATH entry, which is now excluded. Inspection has per-tree and aggregate limits and does not copy complete SDKs. Root identities are rechecked at dispatch. The legacy volume binds the expanded configuration through its original private baseline/hash and ticket; replacing its public preview cannot grant another mapping.

## Acceptance

[Machine-readable evidence](../evidence/sandbox-pwsh7-toolchains-2026-11-04.json) records the exact distribution and counters.

- 83 applicable tests passed, including settings trust, discovery/link/refusal cases, original authorization, source manifests, source/hot-path invariants and process gates. Follow-up dispatch/alias guards also passed. Typecheck and the complete offline build passed; the launcher reports 1.0.0. All 41 packaged runtime hashes were verified.
- A real workspace VM running the offline distribution executed PowerShell 7.6.9 Core and 17 tool version commands, all exit 0: Node, npm, npx, Python, pip, Git, gh, Go, Java, javac, .NET, rustc, cargo, Bun, rg, uv and adb.
- In guest temp storage, Python loaded SSL/SQLite, Git initialized a repository, Java compiled/ran a class, Go compiled/ran a program, Rust emitted metadata using its standard library, and .NET enumerated SDKs. Rust native linking and network/package installation are not claimed.
- Three calls reused one VM. An intentional PowerShell error produced plain text without CLIXML, escape records or ANSI codes; failure retired the VM and released all source/artifact references. The fixture confirmed the host project was not visible, and its final cleanup removed its root.
- The source production legacy backend ran through a real `SandboxTaskBinding`, installed its bounded task package, ran PowerShell 7 with Node/npm/Python/Git, and released its volume/root. Ten physical process owners settled; pending processes and retained candidate/result buffers were zero.
- The discovery snapshot had 27 mounts, 31 PATH entries, 328,946 inspected entries and 24,073 inspected directories. These are startup metadata counts, not per-command scans or an allocation-free claim.

The complete touched path is settings → session → workspace/legacy backend → directory inspection/configuration → guest command startup → unchanged gated Job/Pump → unchanged result delivery/release. `Pump` is byte-for-byte unchanged after line-ending normalization. Its existing contract check observed 131,073 bytes, retained at most 32,768, read 34 times, allocated/cleared exactly 36,864 buffer bytes, and reported zero live buffers after controlled GC. No object pools, per-chunk closures, promises, regular expressions or output materializations were added. New objects and strings belong to VM startup or explicit command launch, not output callbacks.

An exploratory direct sandbox-test glob incorrectly included archived manual entries that `scripts/test.mjs` deliberately excludes and initially omitted `--expose-gc`. Those runs are not counted as acceptance, and historical source-loader/instrumentation failures were not patched or replayed again after identifying their routing. New source-manifest guard failures were fixed by including the actual dependency and updating exact source counts. Scratch remains owned by the recorded task manifest until review/CI and final cleanup.

To reproduce the explicit live checks on the reviewed Windows host, set child `TMP`, `TEMP`, `TMPDIR` to an owned task root, set `SUPERPI_SANDBOX_TOOLCHAIN_ACCEPTANCE=1`, and run Node 26.13.0 with `--expose-gc --experimental-strip-types --test tests/windows-sandbox-toolchain-live.test.mjs`. `SUPERPI_SANDBOX_USE_DIST=1` selects the compiled workspace backend after `npm.cmd --offline run build:offline`. Ordinary CI collects but skips these VM cases.
