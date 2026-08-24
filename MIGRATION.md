# Super Pi Migration

This file is the single migration ledger for turning the copied Pi runtime into
the independent **Super Pi** source repository.

## Fixed decisions

- Repository: `dragonbaba/super-pi`
- Product name: **Super Pi**
- Internal package scope: `@super-pi/*`
- CLI command: `superpi`; no `pi` alias
- Initial distribution: source and local CLI only; no npm publication
- Source baseline: `earendil-works/pi` tag `v0.84.1`, imported once without
  upstream Git metadata or an upstream migration workflow
- Global Pi is a read-only reference. No Super Pi command may patch, deploy,
  format, install into, or otherwise write under its installation directory.
- The original runtime archive is retained permanently.
- Verification stays proportional: affected checks, TypeScript checks, and one
  local `superpi` smoke test. Do not build a broad provider/platform test matrix.

## Safety baseline

- Workspace at migration start: `D:\RMProjects\Pi`
- Permanent archive: `D:\RMProjects\Pi-runtime-archive-20260824`
- Archived files: `205216`
- Archived bytes: `1843301442`
- Archive verification: matching file/byte counts and 64 sampled SHA-256
  comparisons with zero mismatches
- Read-only global Pi root:
  `D:\Nodes\26.4.0\node_modules\@earendil-works\pi-coding-agent`
- Global Pi physical version: `0.84.1`
- Global Pi `dist` files: `801`
- Global Pi `dist` aggregate SHA-256:
  `76b8032a47e756d09131e72772217ee6781be9625dd0df00d78a6bbb52cb9f10`
- Goal execution began at `2026-08-24 09:00:37Z`. The newest file timestamp
  anywhere under the read-only global package is `2026-08-24 07:13:58Z`;
  no global file has a timestamp at or after the execution boundary.
- Final documented byte-tree SHA-256 for global Pi `dist`:
  `7f5da6d515dd60476a6dac5fdcdcbeb5bb0b4c779a25de0f079c84bae42c4c47`.
  Algorithm: sort 801 files by full path, then hash each UTF-8 relative path,
  one NUL byte, and the raw file bytes in sequence. The earlier aggregate is
  retained as the original ledger value; its ad-hoc serialization was not
  reused for the documented final tree hash.

## Status

- `[ ]` pending
- `[~]` in progress
- `[x]` complete
- `[!]` blocked

## Ordered work

- [x] Preserve and verify the permanent runtime archive.
- [x] Remove runtime-only material from the working copy. The 34 explicit
  top-level targets were moved recoverably into the archive under
  `_working-copy-cleanup`; no broad deletion was used.
- [x] Import the Pi `v0.84.1` TypeScript monorepo source baseline. Imported
  commit `53fa77ccd8a279eb87e92294ef3687b03ff80112`; all 1353 compared tracked
  files matched before branding changes.
- [x] Apply Super Pi branding, `@super-pi/*` package names, and the `superpi` CLI.
  All 16 upstream workspaces use the new scope, the local bin is `superpi`, and
  configuration is isolated under `.sp` / `~/.sp`.
- [x] Integrate only the active local packages and extensions. Eleven packages,
  eleven extensions, agents, and prompts were copied without dependencies,
  nested Git metadata, or old build output. A local offline RPC smoke loaded
  the configured extensions and returned a successful `get_state` response.
- [x] Port effective global-runtime behavior into TypeScript source, using the
  54 changed build files and 44 historical patch groups as evidence rather
  than blindly retaining every patch recipe. The retained behavior includes
  bounded output accumulation and truncation, tool/render grouping, compaction
  continuity, catalog refresh coalescing, strict edits, and TUI render caches.
  A complete offline monorepo build succeeds from the migrated TypeScript.
- [x] Remove redundant legacy tests, deployment managers, copied dependencies,
  generated runtime data, and machine-specific paths. Historical and
  publish-only material was moved recoverably under `_source-cleanup-20260824`;
  the final source scan contains no test-like paths, nested Git metadata,
  machine paths, `.env` files, or known secret prefixes. Workspace-local
  `node_modules` directories remain ignored install artifacts only.
- [x] Run minimal affected checks and one local `superpi` smoke test. Evidence:
  `npm run build:offline`, `npm run check`, CLI help/command checks, and an
  isolated offline RPC `get_state` request all succeed. The RPC run loaded the
  configured local extension set and returned `success: true`.
- [x] Recompute the global Pi tree hash and verify the read-only boundary. The
  file count remains 801, the documented final byte-tree hash is recorded
  above, and every global package timestamp predates this goal. No command in
  this migration used the global path as a write target.
- [x] Initialize Git, inspect the complete diff, create
  `dragonbaba/super-pi`, and push the public source repository. GitHub reports
  `PUBLIC` visibility with `main` as the default branch. The initial source and
  test-support cleanup commits were pushed successfully, and local `main`
  matched `origin/main` at `e4f7839c9f02f30a4c529e426cfee2c5b7ac7783`
  before this final ledger update.

## Execution rule

Continue with the first unfinished item. Before a destructive operation,
resolve and verify every exact target. After each item, record concise evidence
here. Historical material is consulted from the permanent archive and is not
copied back unless it is required by the product.

## Independent configuration closure — 2026-08-25

- [x] Separate configuration from runtime data. User JSON configuration now
  lives under `~/.sp/agent/config/`; trusted project overrides live under
  `.sp/config/`. Sessions, memory stores, caches, managed binaries, and
  `models-store.json` remain runtime data under dedicated agent directories.
- [x] Add a non-overwriting `npm run migrate:pi-config` migration and matching
  `npm run check:pi-config` verifier. The migration accepts only 14 known JSON
  files, removes global Pi package paths from migrated `settings.json`, and
  maps Plan and Chrome settings to their `sp-*` names. The `.sp` installation
  migration also carries the global `AGENTS.md` context needed outside the
  source repository.
- [x] Migrate and parse all 14 local configuration files. Every target passed
  semantic verification; credentials stayed outside the repository.
- [x] Hash all 14 global Pi source files before and after migration. Every
  SHA-256 and byte length remained identical.
- [x] Compare global extension and compatibility-package production trees.
  All 11 extension directories and all active package capabilities have local
  source counterparts. Omitted files are test runners, package lockfiles,
  publish workflows, historical plans, or documentation assets rather than
  runtime entry points.
- [x] Close the remaining core-fix gaps found by the source audit: path-aware
  write serialization, rejection of incomplete streamed tool arguments,
  ordered cancellation results for unexecuted calls, and final Proxy tool-call
  metadata propagation are now implemented in source rather than maintained as
  global-runtime patches.

## Independent runtime closure — 2026-08-25

- [x] Absorb `pi-tui-kit` 0.49.3 as `@super-pi/tui-kit`; npm no longer
  installs any `@earendil-works/pi-*` package.
- [x] Add the source-mode `superpi` launcher so bundled packages and resources load
  from any working directory without relocating user state into the repository.
- [x] Link the local `superpi` command; at this intermediate stage the existing
  global `pi` command and PowerShell's built-in `sp` alias remained untouched.
  The later audited default-entrypoint switch is recorded below.
- [x] Move bundled agents and prompts into `.sp` and verify all four
  agents are discoverable outside this repository.
- [x] Absorb and load Plan Mode 0.49.3.
- [x] Absorb and load Chrome DevTools 0.49.3; lifecycle cleanup now imports its
  local browser manager instead of the old global npm-relative path.
- [x] Run an external-directory offline RPC smoke: `get_state` and
  `get_commands` succeeded with 40 commands, including Goal, Plan, Chrome
  DevTools, bundled prompts, and the provider skill.
- [x] Remove all generated `dist` directories and rebuild from source. The
  offline build and root type check pass; removed testing APIs no longer leave
  stale build artifacts.

## Local `.sp` installation closure — 2026-08-25

- [x] Standardize project metadata on `.sp/` and user state on
  `~/.sp/agent/`; no active source or documentation reference to
  `.super-pi` remains.
- [x] Create `~/.sp/agent`, migrate 14 validated JSON configurations and the
  global `AGENTS.md`, and copy Pi's managed `fd.exe` with a matching SHA-256 so
  offline file discovery does not depend on a first-run download. The old
  `~/.super-pi` tree remains an untouched rollback copy.
- [x] Remove only verified-empty repository directories: the old
  `.super-pi` shell, top-level `agents/` and `prompts/`, and
  `packages/tool-classification/scripts/`. Dependencies and build output stay
  available for immediate local use.
- [x] Replace the colliding `sp` command with npm-linked `superpi`, expose it
  through the user-level `~/.local/bin`, replace the stale user PATH entry for
  removed Node 25 with Node 26, and remove the temporary PowerShell `sp` alias.
- [x] Compare local commands from outside the repository. `superpi` 0.84.1 and Pi
  0.84.2+local.1 both return successful version/help/RPC results; their 34
  non-skill commands match. Pi's additional 20 commands are mutable Hermes
  maintenance skills, while Super Pi exposes five bundled short prompts and
  `add-llm-provider` instead.
- [x] Start the real Super Pi TUI from `C:\Windows\Temp`, load the `.sp`
  context/configuration and all bundled resources, execute
  `! echo SP_LOCAL_OK`, observe the expected output, and exit cleanly with
  Ctrl+D.
- [x] Deduplicate identical prompt files reached through both project auto
  discovery and the source launcher. The project TUI reports no prompt
  conflicts, while an external-directory RPC still exposes all eight prompts.

## Historical data and default-entrypoint closure — 2026-08-25

- [x] Add a dry-run-first, non-overwriting historical migration with a receipt
  verifier. It copied 13 session JSONL files, 128 project-memory files, and 70
  extension-memory files from `~/.pi/agent` into `~/.sp/agent`; all 211 source
  hashes and target copies verify. Seven generated lock, SQLite sidecar, and
  migration-sentinel artifacts were deliberately excluded.
- [x] Preserve the old Hermes SQLite store through an immutable file snapshot,
  then explicitly index every migrated session under its new path with Bun.
  The target passes `quick_check` and foreign-key checks with 13 sessions,
  1,165 messages, 150 extended memories, and 17 session-file metadata rows.
- [x] Merge rather than overwrite tool-repair telemetry. The 16,384 old event
  hashes and one disjoint Super Pi event produced 894 aggregate buckets; the
  pre-merge Super Pi store is retained under
  `~/.sp/agent/backups/pi-data-migration-v1/`.
- [x] Include all 67 TypeScript files from the 11 extension packages in the
  root type check. Verify that all 11 old extension production trees have
  local counterparts; omitted files are tests, benchmarks, smoke runners, and
  test loaders rather than runtime entry points. All four agents and all three
  old bundled prompts match the repository resources byte for byte.
- [x] Review and allow the exact install scripts needed by the locked native
  and generated dependencies. Node 26 opens the migrated database through
  `better-sqlite3`; Canvas renders a PNG; esbuild transforms TypeScript;
  protobuf encodes/decodes; and the Google GenAI module loads.
- [x] Back up the three old global `pi` shims, retain
  `@earendil-works/pi-coding-agent@0.84.1`, and switch the default `pi` bin to
  Super Pi. `pi-stable` launches the retained comparison runtime. From
  `C:\Windows\Temp`, `pi` and `superpi` report 0.84.1, `pi-stable` reports
  0.84.2+local.1, and the real global `pi --mode rpc` exposes 60 commands with
  Memory, Plan, Goal, and Chrome DevTools loaded.
