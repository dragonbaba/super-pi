# Structured read-only command

A narrow Pi Runtime tool for shell-free, Session-workspace-bounded inspection.

## Tool

```text
structured_readonly_command
```

This extension registers no Slash command. It accepts a structured `cwd`, an allowlisted executable, and an argument array, consumes exact one-call grants from the central Session permission controller for cwd and recognizable absolute argument paths, then runs one owned foreground process with `shell=false`.

Supported operations:

- `rg`: configuration is disabled with `--no-config`; `--pre`, `--pre-glob`, and other program-executing options are blocked.
- `git`: only `status`, `diff`, `log`, `show`, `ls-files`, and `rev-parse` are accepted. External diff/textconv and alternate worktree/git-dir options are blocked.

Safety properties:

- canonical primary, explicitly added, or exact `full-access` Session root and working directory;
- deeply frozen non-enumerable grants bound to tool-call ID, an incremental hash of `command + cwd + args`, and root/cwd device and inode identities, consumed and revalidated immediately before launch;
- up to 16 distinct absolute argument roots authorized independently through primary, added, or exact `full-access` Session scope, without widening process cwd;
- executable resolution only from absolute PATH entries outside the Workspace, preventing project-local `rg`/`git` shadowing;
- rejection of lexical `..` escape and realpath symlink/junction escape;
- syntax-aware path classification shared with the Session permission controller: rg patterns and ordinary option values are never treated as paths, while search roots and pattern/ignore files are authorized and validated;
- no shell expansion, pipes, redirection, heredocs, or environment assignments;
- shell-style globs are rejected when supplied as positional `rg` paths; use `--glob "*.ts"` or `--glob="*.ts"` plus an explicit root such as `.` instead. Both filter forms remain valid after listing options such as `--files`; only the standalone `--` token ends option parsing;
- recognized positional `rg` roots and pattern/ignore files are existence-checked before spawn; a missing root returns `PATH_NOT_FOUND` with the legal `.`/`--glob` form instead of an `rg` exit-2 `command_failed` result;
- Git cwd must be inside a repository whose `.git` marker is within the authorized workspace root; non-repository calls return `WORKDIR_MISMATCH` before Git is spawned;
- a search regex beginning with `-` must be supplied via `-e`/`--regexp`; obvious cases are rejected before spawn, and any remaining `rg: unrecognized flag` exit is classified as `input_validation` with the same mechanical recovery instead of `command_failed`;
- bounded argv sizes, timeout, output lines, and output bytes; stdout/stderr beyond 50KB is drained but never retained;
- exact foreground-child termination on timeout/abort, with timers and listeners cleaned on every exit path;
- no temporary full-output spill files;
- sequential execution to avoid bursts of sibling process launches;
- machine-readable `details` retain `category`, `exitCode`, retryability, truncation, byte/line counts, and the strict `stateChanged: false` contract;
- successful model-visible content contains only bounded command output; no-match has a short semantic status and ordinary empty success is silent;
- collapsed TUI success is silent unless output was truncated; expanded view scans and displays at most 40 output lines without splitting the complete output into an array;
- failures return only category, bounded command diagnostics, and the legal retry step instead of dumping the complete metadata object.

`stateChanged: false` describes the extension's strict allowlist contract. The pre-spawn Git repository check reports `WORKDIR_MISMATCH` with the mechanical next step to set `cwd` to the repository root; the output classifier retains the same category for defensive handling of an unexpected Git “not a repository” exit. This tool intentionally excludes interpreters, package managers, build systems, tests, and mutation-capable Git commands. Unsupported operations must use a more appropriate dedicated tool or fall back to Bash under existing policy guards.

## Verification

```bash
npm test
npm run typecheck
```
