# Super Pi Repository Rules

General working rules live in each agent's global instructions (`~/.sp/agent/AGENTS.md`, `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`). This file holds only rules specific to this repository.

## Hot-Path Allocation Contract

- Provider deltas, assistant/tool progress, event delivery, interactive updates, rendering/layout, terminal frame generation/writes, large-result processing, and Evidence Ledger lookup are hot paths.
- Before modifying a hot path, read [docs/performance/hot-path-allocation-contract.md](docs/performance/hot-path-allocation-contract.md) and audit the complete production call chain, not only the new diff.
- Run the relevant AST/source invariants and allocation benchmark, and provide deterministic counters plus lifecycle/reference-release evidence.
- If a change does not touch a hot path, state that in one line and skip the benchmark.
- Object pools require profiler proof and must satisfy the contract's ownership, safety, capacity, test, and measured-improvement gates.

## Task Temporary Files

- Put task scratch data (probes, logs, fixtures, downloads, profiles) under `.task-tmp/<task-id>-<unique-id>/`, which is gitignored; never in `.git` or `docs/evidence/`.
- For tests and subprocesses, point `TMP`, `TEMP` and `TMPDIR` at the task root in the child environment only; `scripts/test.mjs` derives its per-run directories from that.
- Deleting your own task root when the task is done is part of the task and needs no separate approval. Do not delete other task roots or follow links out of `.task-tmp`. If deletion is blocked, report the remaining path and reason.

## Evidence

- `docs/evidence/` keeps one concise record per task: problem, reproduction, fix, verification numbers and the rerun command. Do not narrate review rounds or cleanup, paste raw output, or keep credentials, real user configuration or private transcripts.
