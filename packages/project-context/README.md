# @super-pi/project-context

A small Pi extension that keeps project rules, generated repository facts, and durable Hermes memory as separate layers.

## Commands

- `/project-status` — read-only check of project identity, lightweight-index freshness, Hermes scope, and CodeGraph index health.
- `/project-init` — explicitly creates `.sp/project-context.json`, creates `AGENTS.md` only when absent, creates/preserves the scoped Hermes `MEMORY.md`, then builds the lightweight index.
- `/project-refresh` — deterministically refreshes `.sp/project-context.md` and `.sp/project-index.jsonl`.
- `/codegraph-status` — shows CodeGraph version, initialization, index state, last update, counts, and pending changes.
- `/codegraph-init` — after confirmation, creates the first full graph index for the trusted project.
- `/codegraph-sync` — incrementally indexes changed files.
- `/codegraph-reindex` — after confirmation, replaces the full graph index when it is partial, failed, outdated, or otherwise unhealthy.

## CodeGraph Tool

The single `codegraph` model tool keeps prompt overhead small while exposing `status`, `query`, `explore`, `node`, `callers`, `callees`, `impact`, and `affected`. Before every read action it checks CodeGraph's real pending-change status and runs an incremental `sync` when needed. Because files can change while an indexing pass is running, post-command verification allows up to two bounded follow-up syncs to reach a clean snapshot; continuously changing projects still fail closed with residual file/reference counts. The tool never initializes or fully rebuilds an index; those remain explicit user commands.

## Safety

- Existing `AGENTS.md` files are preserved byte-for-byte.
- Newly generated `AGENTS.md` files permit Hermes/session lookup only when the user explicitly asks to search, recall, remember, or revisit prior information.
- Corrupt or unsupported identity manifests are never silently replaced.
- Writes validate every existing parent component under the selected project root and reject linked/non-regular generated targets.
- Identity/rules use exclusive creation. Refreshes are serialized with an owner-token lock; profile and index use a durable transaction marker. In-process failures roll both files back, and—after any confirmed-stale lock is removed—the next refresh/init deterministically restores both prior files after a crash before starting new work. A lock left by a crashed process is never auto-stolen—verify no operation is active before manually removing the reported lock path.
- Dependency, build, VCS, generated, virtual-environment, cache, `.codegraph`, and common credential paths are excluded. The index contains only remaining file paths, sizes, categories, and recognized languages—not file contents; it is not a general secret scanner and does not interpret `.gitignore`.
- The generated Markdown profile is bounded independently of repository size: it keeps the highest-level 20 manifests and 20 likely entrypoints, caps language/area summaries, and reports omitted counts while the JSONL index remains complete.
- Lightweight scanning never follows symlinks, executes project code, installs dependencies, or initializes CodeGraph. `/project-init` only creates an empty project-scoped Hermes `MEMORY.md` when absent and preserves existing memory byte-for-byte.
- CodeGraph access requires Pi's current project trust. The extension executes the exact locally installed `node.exe` and CLI with an argument array—never through a shell—and restricts file arguments to the resolved project root.
- CodeGraph output is bounded to 50 KiB and stripped of ANSI, OSC, and unsafe control sequences before reaching the terminal or model.
- Directory, manifest, and file names are stripped/escaped for generated Markdown and terminal notifications; index JSON uses JSON escaping.
- This local package is strictly gated to Pi `0.84.x` and disables itself when the runtime version is unavailable or outside that line.
- Non-Git projects should start Pi from their initialized root because Hermes currently derives non-Git scope from the current working-directory name.
