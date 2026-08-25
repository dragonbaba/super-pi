# Super Pi Independence Closure

This file records the accepted final state of the standalone **Super Pi**
repository. One-time migration machinery, rollback assets, and superseded path
details are intentionally not retained.

## Current identity

- Repository: `dragonbaba/super-pi`
- Product name: **Super Pi**
- Internal package scope: `@super-pi/*`
- CLI command: `superpi`
- Distribution: source checkout linked through npm; no npm publication
- User state root: `~/.sp/agent/`
- Project metadata root: `.sp/`

## Functional closure

- The TUI, agent loop, provider layer, session protocol, memory, goals, plan
  mode, LSP support, Chrome DevTools integration, status line, telemetry, and
  bundled extensions are maintained in this repository.
- Bundled agents, prompts, skills, configuration, model data, themes, and other
  runtime assets load from the Super Pi package and `.sp` roots.
- The externally linked runtime exposes the accepted command surface, including
  Memory, Plan, Goal, and Chrome DevTools capabilities.
- Core fixes and extension production code live in source rather than in
  machine-local package patches.

## Data closure

- Personal configuration and credentials remain under `~/.sp/agent/config/`.
- Sessions, project memory, extension memory, managed binaries, caches, model
  state, and the searchable SQLite store remain under `~/.sp/agent/`.
- The SQLite store passes `quick_check` and foreign-key validation. Session,
  message, memory, and indexed-file row counts are runtime data and are not
  pinned in this document.
- Repository-owned defaults and resources remain under `.sp/`; personal runtime
  state is not committed.

## Cleanup closure

- The retired global package, fallback launcher, generated command shims,
  rollback directories, runtime archive, and obsolete state roots were removed.
- One-time configuration, data, and database migration scripts and their package
  commands were removed.
- `package.json`, `package-lock.json`, installed modules, and command entrypoints
  contain no dependency on the retired package scope.
- `node_modules` has no missing, invalid, or extraneous packages and has been
  deduplicated with npm.

## Verification

- `superpi --version` reports the expected Super Pi version.
- `npm run build:offline` passes.
- `npm run check` passes.
- `npm ls --all` passes.
- `npm prune --dry-run` and `npm dedupe --dry-run` report no pending removals or
  dependency-layout changes.
