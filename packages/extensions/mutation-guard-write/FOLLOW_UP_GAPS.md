# Evidence-backed follow-up gaps

These capabilities are intentionally **not** added by the current safety closure.

1. **Dedicated delete/move tools** — global discovery currently has one guarded `edit` owner and one guarded `write` owner; no authenticated delete or move tool exists. High-risk delete commands are parsed by `resource-lifecycle-guard`, but Bash cannot provide file-identity compare-and-swap, rollback, or destination collision semantics equivalent to the guarded file tools.
2. **Shadow workspace execution** — mutations still apply to the live workspace after read evidence, protected-root checks, and per-turn budget reservation. There is no isolated copy-on-write workspace or verified promotion step.
3. **Multi-file transactions** — per-file mutation queues and per-turn budgets bound individual/cumulative work, but successful mutations across several files are not atomic as a group. A later failure does not roll back earlier successful files.
4. **Partial-failure receipts** — the derived structured ledger contains only complete successful edit/write receipts. A `PARTIAL_MUTATION` remains a fail-closed verification obligation because post-state identity or hash may be unavailable; it is intentionally not promoted into a fabricated successful receipt.

Evidence: `index.ts` registers only `edit` and `write`; `core.ts` implements single-file evidence/queue checks and cumulative turn budgets; `session-evidence.ts` accepts only complete schema-v1 success receipts; `resource-lifecycle-guard/core.ts` and `mutation-policy.ts` provide structured Bash analysis and protected-root policy, not transactional filesystem primitives.
