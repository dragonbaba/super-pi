# @super-pi/project-context

A small Pi extension that keeps project rules, generated repository facts, and durable Hermes memory as separate layers.

## Commands

- `/project-status` — read-only check of project identity, published artifact presence, the last build from the current extension session, and Hermes scope. It does not scan the workspace for freshness.
- `/project-init` — creates or reuses `.sp/project-context.json`, adds navigation to `AGENTS.md` once, prepares the scoped Hermes `MEMORY.md`, then reports the index build separately from initialization.
- `/project-refresh` — deterministically refreshes `.sp/project-context.md` and `.sp/project-index.jsonl`.

## Retired integration

The CodeGraph tool and `/codegraph-*` commands are retired. Existing `.codegraph/` directories, local installations, and user skills are left untouched. Use `/project-refresh` to replace a profile generated before retirement.

## Index exclusions

Use `.spignore` at the project root to limit the generated summary and JSONL index. Its patterns follow Git ignore syntax, including directory suffixes, root anchors, comments and negation. Excluding a parent directory prunes its subtree. Existing built-in exclusions apply before these rules.

```gitignore
Library/
Temp/
Logs/
*.tmp
*.bak
```

Only the root `.spignore` is read. Rule loading from `AGENTS.md` and permissions for explicit file tools are independent of the scanner. Index builds run in a Worker with no fixed file-count limit. The terminal shows the phase and file count during longer builds. Press Escape to cancel before publication. Failed or cancelled builds report whether the previous artifacts are still available.

## Safety

- Navigation is appended to existing `AGENTS.md` files while keeping their original bytes. Subsequent initialization and refresh do not rewrite the file.
- Newly generated `AGENTS.md` files permit Hermes/session lookup only when the user explicitly asks to search, recall, remember, or revisit prior information.
- Corrupt or unsupported identity manifests are never silently replaced.
- Writes validate every existing parent component under the selected project root and reject linked/non-regular generated targets.
- Identity and new rules use exclusive creation. Refreshes are serialized with an owner-token lock. A transaction interrupted before commit restores the previous pair. An interruption after commit resumes cleanup and preserves the newly published pair. Verify that no operation is active before removing a lock left by a crashed process.
- Dependency, build, VCS, generated, virtual-environment, cache, `.codegraph`, and common credential paths are excluded. The index contains only remaining file paths, sizes, categories, and recognized languages—not file contents; it is not a general secret scanner and does not interpret `.gitignore`.
- The generated Markdown profile is bounded independently of repository size: it keeps the highest-level 20 manifests and 20 likely entrypoints, caps language/area summaries, and reports omitted counts while the JSONL index remains complete.
- The scanner sorts bounded batches, merges them into a staged JSONL file, and compares published files in chunks. Larger builds can use temporary disk space for sorted runs. The index preserves the existing fields, stable path order and profile digest convention.
- Lightweight scanning excludes task scratch directories (`.task-tmp`), never follows symlinks, executes project code, or installs dependencies. Old test snapshots and compilation caches therefore cannot reappear as current project source. `/project-init` only creates an empty project-scoped Hermes `MEMORY.md` when absent and preserves existing memory byte-for-byte.
- Directory, manifest, and file names are stripped/escaped for generated Markdown and terminal notifications; index JSON uses JSON escaping.
- This local package is gated to Super Pi `1.x` and legacy `0.84.x`, and disables itself when the runtime version is unavailable or outside those lines.
- Non-Git projects should start Pi from their initialized root because Hermes currently derives non-Git scope from the current working-directory name.
