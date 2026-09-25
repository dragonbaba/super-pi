# Evidence-backed follow-up gaps

These capabilities are intentionally **not** added by the current safety closure.

1. **Native file operations** — implemented by the current A branch: guarded delete/move, exclusive creation, bounded parent creation and version-2 partial/unknown receipts. See README and the main phase record. Filesystem CAS, recursive deletion and cross-volume moves remain outside scope.
2. **Shadow workspace execution** — mutations still apply to the live workspace after read evidence, protected-root checks, and per-turn budget reservation. There is no isolated copy-on-write workspace or verified promotion step.
3. **Multi-file transactions** — per-file mutation queues and per-turn budgets bound individual/cumulative work, but successful mutations across several files are not atomic as a group. A later failure does not roll back earlier successful files.
4. **Partial-failure receipts** — native metadata operations and prepared creations now record intent and result on the Session branch. Unknown state is a verification obligation and is not promoted to success. B extends this to per-item cross-file results.

Evidence: `native-tools.ts`, `native-file-core.ts`, `file-creation.ts`, `core.ts`, and `session-evidence.ts`. Cross-file batch execution is required in B; it will not promise a transaction.
