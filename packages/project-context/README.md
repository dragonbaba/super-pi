# @super-pi/project-context

A small Pi extension that keeps project rules, generated repository facts, and durable Hermes memory as separate layers.

## Commands

- `/project-status` — read-only check of project identity, lightweight-index freshness, and Hermes scope.
- `/project-init` — explicitly creates `.sp/project-context.json`, creates `AGENTS.md` only when absent, creates/preserves the scoped Hermes `MEMORY.md`, then builds the lightweight index.
- `/project-refresh` — deterministically refreshes `.sp/project-context.md` and `.sp/project-index.jsonl`.

## Retired integration

The CodeGraph tool and `/codegraph-*` commands are retired. Existing `.codegraph/` directories, local installations, and user skills are left untouched. A profile generated before retirement becomes stale until an explicit `/project-refresh`; status and startup do not rewrite it automatically.

## Safety

- Existing `AGENTS.md` files are preserved byte-for-byte.
- Newly generated `AGENTS.md` files permit Hermes/session lookup only when the user explicitly asks to search, recall, remember, or revisit prior information.
- Corrupt or unsupported identity manifests are never silently replaced.
- Writes validate every existing parent component under the selected project root and reject linked/non-regular generated targets.
- Identity/rules use exclusive creation. Refreshes are serialized with an owner-token lock; profile and index use a durable transaction marker. In-process failures roll both files back, and—after any confirmed-stale lock is removed—the next refresh/init deterministically restores both prior files after a crash before starting new work. A lock left by a crashed process is never auto-stolen—verify no operation is active before manually removing the reported lock path.
- Dependency, build, VCS, generated, virtual-environment, cache, `.codegraph`, and common credential paths are excluded. The index contains only remaining file paths, sizes, categories, and recognized languages—not file contents; it is not a general secret scanner and does not interpret `.gitignore`.
- The generated Markdown profile is bounded independently of repository size: it keeps the highest-level 20 manifests and 20 likely entrypoints, caps language/area summaries, and reports omitted counts while the JSONL index remains complete.
- Lightweight scanning never follows symlinks, executes project code, or installs dependencies. `/project-init` only creates an empty project-scoped Hermes `MEMORY.md` when absent and preserves existing memory byte-for-byte.
- Directory, manifest, and file names are stripped/escaped for generated Markdown and terminal notifications; index JSON uses JSON escaping.
- This local package is gated to Super Pi `1.x` and legacy `0.84.x`, and disables itself when the runtime version is unavailable or outside those lines.
- Non-Git projects should start Pi from their initialized root because Hermes currently derives non-Git scope from the current working-directory name.
