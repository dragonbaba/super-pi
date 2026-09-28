# Shell side effects, write presentation, and verification accuracy

Baseline: `57379ac5ce3c4ec895b43c197d11e4015f4d4799` (fetched main).
This repair has three slices on one branch: A shell incident regression and diagnosis;
B one write card with receipt-based completion; C accurate LSP selection and coverage.
The PR remains unmerged. Slice results and final candidate validation are recorded below.

## A: incident and scope of the fix

A Windows HTML check created an unexpected zero-byte file named `m[1])`.
The session's original failed `node -e` call exited 255. The file creation timestamp
fell inside that call's execution interval, before the subsequent successful quoted
Heredoc. Raw tool calls/results and filesystem identity were retained privately;
no session export, original HTML, executable, environment dump, or private path is
part of this change. `tests/fixtures/shell-incident-commands.json` preserves the two
original command strings, including regex escapes, arrow functions and delimiters.
Tests use synthetic HTML only.

The layers must be distinguished:

1. The generated `node -e` command was valid Bash input without an outer output
   redirection. Direct execution with native Node preserved its intended script.
2. Super Pi's approved input and real Bash spawn argument matched exactly. Neither
   `analysisCommand` nor an extra product shell wrapper entered execution. The
   original commands did not trigger the paired-backslash MSYS bridge.
3. Git Bash resolved `node` to an external nvmd 4.2.0 shim. Its Windows Node entry
   used `cmd.exe /C`, reinterpreting JavaScript quotes and arrows as shell syntax.
4. The resulting shell side effect created the unexpected file, or truncated a
   preexisting nonempty sentinel. A later successful check did not undo it.
5. This is not an official Node JavaScript-parser defect. The failure had no
   observed Node consumer record. That absence does not imply no shell effects.

The real tool result retained `started:true`, exit 255, `sideEffects:unknown`, and
`inspect_before_retry`; it did not falsely report `not_executed`.

The external fix is reviewable in `nvmd-node-direct-spawn.patch`. It applies to
[nvmd v4.2.0](https://github.com/1111mp/nvmd-command/tree/b03b4951f7000cb4ef01feb601e29e2336a69dbc).
Only `src/core/node.rs` changes: directly launch native Node from the version
manager's already-selected executable directory. The other batch-tool entrypoints
are unchanged. Reproduce with `git apply <patch>` and `cargo build --release --locked`
in that source checkout (Windows requires the normal Rust/MSVC/CMake toolchain).
`cargo test --release --locked` at that upstream version contains zero unit tests;
the actual consumer regressions are the functional evidence.

The user authorized installing this repaired **version-manager shim**, not a fixed
native Node binary, on their machine. Its original backup remains preserved. This
repository does not install or replace any runtime. Version-switching compatibility
has not been tested, and neither universal Windows remediation nor automatic
future protection is claimed.

## Evidence coordinates and regression modes

Historical local results must not be relabeled as results from this PR:

- Product source/build checkout: `57379ac5ce3c4ec895b43c197d11e4015f4d4799`;
  tree `28301a0f96ce772713fa4832983653e1fb0983d8`. The session did not record hashes
  of all originally loaded binaries, so this is not a historical reproducible-build proof.
- Runtime: Windows, native Node 26.4.0, Git Bash 5.3.15(2). Product launcher:
  installed forwarding command → npm global shim → source `scripts/superpi.mjs`
  → built `packages/coding-agent/dist/cli.js`. No commandPrefix was configured.
- Original installed nvmd shim SHA-256:
  `96e8d38d7148778276b738c8d68a9df1911ba5299ee4199cec2b6ec237fcb791`.
- Locally rebuilt unmodified upstream shim SHA-256:
  `320349ab853891a3b4c755be3c6abd44bfe425113e8bfdfaff63f3e0a48e8393`.
- Locally built repaired shim SHA-256:
  `27e0c30c0ead099c6f3494d6dcb162341240b62135f4e6f9affa7dc0f0fc7a75`.
  These artifact hashes identify local builds, not a promise of reproducible binaries.
- The private original consumer-path matrix reproduced creation and truncation
  with both installed and rebuilt broken shims; repaired-shim checks passed 12/12.
- After authorized installation, the actual **existing global** entry with unchanged
  PATH passed 8/8: two original commands × absent/nonempty sentinel, denial,
  preflight refusal, MSYS bridge, and ordinary output redirection. Network attempts,
  pending calls, and final authorization references were zero. These remain
  historical local installation results, not future UI/LSP candidate results.

`tests/shell-incident-launcher.test.mjs` starts the real source launcher with an
isolated agent directory, real Agent/guards/approval and real platform shell/Node.
Only model responses and the user's approval choice are supplied by the fixture.
It compares before/after file bytes, the displayed approved request, actual Bash
transport, and Node's received source. Refusals assert zero tool-time spawns.
Only synthetic test processes record source/argv; production logging is unchanged.
The historical script and its original `PASS` text are byte-preserving incident
fixtures, not a recommended validation template. The regression checks consumer
bytes and filesystem state independently of that text. Regex matches must be counted
and scoped before any validation conclusion; zero script matches cannot validate JS.

Default CI mode privately prepends the test process's native Node directory to its
child PATH. That verifies the Linux/Windows transport contract and is **not** an
nvmd reproduction or the user's global-entry verification. CI neither installs an
old shim nor replaces runner executables/configuration. Windows exercises Git Bash;
Linux exercises Bash directly. The bridge control additionally verifies the
Windows wrapper is really selected. Normal authorized redirection remains valid.

Optional, explicit local diagnostic modes:

- `SP_INCIDENT_BASH`: absolute shell path when default discovery is insufficient.
- `SP_INCIDENT_SHIM`: private directory containing a separately built shim named
  `node.exe` (Windows) or `node` (POSIX). `SP_INCIDENT_EXPECT_BROKEN=1` is only for
  the isolated known-broken Windows control, never the installed global entry.
- `SP_INCIDENT_GLOBAL_ENTRY`: explicit Windows global `.cmd` entry; this mode uses
  inherited PATH and cannot be combined with a private shim. It exists only for
  authorized local installation checks. Do not set it in CI.
- `SP_INCIDENT_PROJECT`: explicit built checkout under test; omit for this checkout.
- `SP_INCIDENT_KEEP=1`: retain newly created fixture roots for private evidence.

Run after building: `node --test tests/shell-incident-launcher.test.mjs`.
Keep old local evidence and denied-cleanup directories untouched. The original
user file remains preserved. No full-directory production scan, auto-retry,
auto-runtime replacement, or auto-removal of suspicious files is introduced.

## B/C and final candidate status

The companion changes implement [write completion cards](write-completion-card.md)
and [LSP scope accuracy](lsp-validation-scope.md). CI/review outcomes are attached to
the PR's exact candidate HEAD, separately from the historical global 8/8 result.
Global command links remain unchanged; the PR candidate is built and launched from
its separate checkout using `node scripts/superpi.mjs`.
