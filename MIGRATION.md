# Super Pi Migration

This file is the single migration ledger for turning the copied Pi runtime into
the independent **Super Pi** source repository.

## Fixed decisions

- Repository: `dragonbaba/super-pi`
- Product name: **Super Pi**
- Internal package scope: `@super-pi/*`
- CLI command: `sp`; no `pi` alias
- Initial distribution: source and local CLI only; no npm publication
- Source baseline: `earendil-works/pi` tag `v0.84.1`, imported once without
  upstream Git metadata or an upstream migration workflow
- Global Pi is a read-only reference. No Super Pi command may patch, deploy,
  format, install into, or otherwise write under its installation directory.
- The original runtime archive is retained permanently.
- Verification stays proportional: affected checks, TypeScript checks, and one
  local `sp` smoke test. Do not build a broad provider/platform test matrix.

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
- [x] Apply Super Pi branding, `@super-pi/*` package names, and the `sp` CLI.
  All 16 upstream workspaces use the new scope, the local bin is `sp`, and
  configuration is isolated under `.super-pi` / `~/.super-pi`.
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
- [x] Run minimal affected checks and one local `sp` smoke test. Evidence:
  `npm run build:offline`, `npm run check`, CLI help/command checks, and an
  isolated offline RPC `get_state` request all succeed. The RPC run loaded the
  configured local extension set and returned `success: true`.
- [x] Recompute the global Pi tree hash and verify the read-only boundary. The
  file count remains 801, the documented final byte-tree hash is recorded
  above, and every global package timestamp predates this goal. No command in
  this migration used the global path as a write target.
- [~] Initialize Git, inspect the complete diff, create
  `dragonbaba/super-pi`, and push the public source repository.

## Execution rule

Continue with the first unfinished item. Before a destructive operation,
resolve and verify every exact target. After each item, record concise evidence
here. Historical material is consulted from the permanent archive and is not
copied back unless it is required by the product.
