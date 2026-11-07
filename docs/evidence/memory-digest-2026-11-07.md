# Hermes memory: trigger-based policy and session digest (2026-11-07)

## Problem

- The memory extension was effectively frozen. `policy-only` mode sent no
  saved memory, the default policy had no concrete save triggers, and a local
  custom policy limited reads and writes to explicit requests.
- The nudge and flush config keys were dead: nothing read them.

## Change

- `memoryMode` now defaults to `digest`:
  - The system prompt gets only the constant trigger-based `MEMORY_POLICY_PROMPT`.
  - Saved memory goes in one hidden `hermes-memory-digest` custom message. It is
    capped at 2,000 characters and covers user entries, entries for the current
    project, and recent failures (the `failureInjection*` settings apply).
  - The digest is frozen at `session_start` and sent once per session context.
    It is re-sent only when `session_compact` or `session_tree` leaves the
    context without it.
- Dead nudge, flush, correction and child-transport config fields are removed.
  If an old config file still has them, they are ignored.

## Prompt-cache impact

- The system prompt bytes do not depend on saved memory. The test asserts that
  the prompt is identical with and without memory.
- The digest is persisted as session history, so later turns and resumes replay
  the same bytes.
- There is no per-turn injection or nudge.

## Verification (`TMP`/`TEMP`/`TMPDIR` set to the task root)

| Command | Result |
|---|---|
| `packages/memory: npm test` | 6/6 pass, including the new `tests/memory-digest.test.mjs` |
| `packages/memory: npm run check` | exit 0 |
| `packages/memory: npm run benchmark:lifecycle` | `startupMs≈3.3`, `shutdownMs≈0.04`, `registeredTools=4` |
| root `npm run check` (`tsgo --noEmit`) | exit 0 |
| `packages/memory: npm run smoke:rpc` | **fails** before the extension runs |

The smoke test fails with `No models available` because its isolated agent
directory has no provider credentials. This is an environment limitation of the
smoke test and unrelated to this change.

A regression found while writing the test: the omitted-count line was not
budgeted, so the digest reached 2,031 characters. Space is now reserved for
that line.

## Follow-up: dead code removal

Method:
- Scanned for exports nobody references, using a whole-word search across
  `src` and `tests`.
- Scanned store classes for public methods that are never called.
- Ran `tsc --noUnusedLocals`.
- Repeated the scans until they found nothing new.

Removed code had no production caller:
- `store/session-indexer.ts` and `store/session-parser.ts`.
- Direct review application: `runDirectMemoryCompletion`,
  `applyReviewOperations`.
- The review transport switch: `usesDirectTransport` and the
  `reviewTransport` config field.
- The consolidator hook and its retry branch. `setConsolidator` was never
  called.
- `registerSkillsCommand` and `confirmDeleteSelectedSkills`.
- `scanSecrets`.
- These sqlite helpers: `getMemories`, `removeMemory`, `getRecentFailures`,
  `touchMemory`.
- These `DatabaseManager` methods: `getLastRecovery`,
  `withCorruptionRecovery`, `recoverFromCorruption`, `getPath`, `exists`,
  `getStats`.
- `AtomicLockCoordinator.closeShared` and `closeAllShared`.
- `MemoryStore.getStorageIdentity` and `getAllFailureEntries`.
- `SkillStore.getPiGlobalSkillsDir`.
- `GLOBAL_MEMORY_CATEGORIES`.
- Unused imports and locals.

Verification: memory `npm test` passes 6/6, `npm run check` and root `tsgo`
exit 0, and the lifecycle benchmark is unchanged (`startupMs≈3.7`).
