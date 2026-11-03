# @super-pi/dynamic-instructions

Append-on-change workspace instructions and skill catalogs, using Super Pi's native prompt composition with a legacy Pi 0.84.1 fallback.

## Behavior

- With supported `before_agent_start.systemPromptComposition`, consumes the exact native workspace and skill segments. Direct and Codemode-nested `read` use the same native skill visibility. No duplicate formatting, full-prompt search or string surgery occurs.
- Keeps native base/custom, append and cwd text unchanged, even when they contain duplicate workspace/skill text or old documentation headings.
- A raw prompt override sets composition to `null`: preserve that prompt and emit no replacement or tombstone. Unknown versions/sources or malformed composition also preserve it; metadata is not an authorization credential.
- Only absent composition uses the legacy path: reproduce sections from `systemPromptOptions`, remove exact unique matches, and compact the uniquely matched old Pi documentation directory. Missing/duplicate matches preserve the prompt.
- Appends one hidden `dynamic-instructions-v1` custom message on first non-empty state or when effective bytes change.
- Writes complete replacements and explicit empty tombstones; older values remain immutable Session history.
- Restores the latest valid SHA-256 pair from the active Session branch, so resume/reload/branch does not duplicate unchanged guidance.
- Keeps one current projection. Unchanged turns reuse composition/result identity (options/result identity for legacy hosts), with no formatting, hashing or new projection. Active-branch lookup and the host's hook/context allocations still occur.
- Clears the projection on session start, shutdown or invalid provenance. A synchronous host dispose that only invalidates the API, without sending shutdown, may retain this one cache with its old Runner until collection. It does not advance durable hashes.

Skill bodies are never copied: only Pi's existing skill catalog metadata is moved. Permission checks and tool availability remain runtime-owned.

## Loading

The repository's `superpi` source launcher includes this package from `.sp/config/settings.json` and passes its manifest entry to the CLI. `--no-extensions` omits that default entry; an explicit `--extension packages/dynamic-instructions/src/index.ts` still loads it. The launcher test checks these arguments, while the offline SDK assembly test loads the actual file entry and checks one migration across unchanged turns.

An SDK session uses its own resource configuration; it does not inherit the source launcher's package list. Without this extension, native prompt composition still includes complete workspace instructions and the visible skill catalog. With it, those sections move to the durable custom message while default/custom base text, appended instructions and cwd stay in the system prompt. This is optional content placement, not an execution boundary.

## Bounds and failure mode

- at most 64 context files;
- at most 256 model-invocable skills;
- at most 2,048 characters per path;
- at most 256 KiB combined dynamic section bytes.

Native counts and path bounds are immutable scalars paired with the composition; byte limits apply to the actual segments. These limits constrain migration, not core prompt construction. If a bound or provenance check fails, the complete prompt remains intact and no replacement is emitted. Legacy unique-section/format checks remain conservative.

## Verification

From the repository root:

```sh
npm run check
node --experimental-strip-types --test tests/dynamic-instructions.test.ts tests/prompt-composition.test.ts tests/prefix-production-assembly.test.ts
node --expose-gc --experimental-strip-types scripts/bench/prompt-composition.ts
```

The benchmark is a bounded manual probe, not an extra CI matrix. Re-audit native protocol changes and legacy Pi formatting separately. Session history remains `dynamic-instructions-v1`; failed message persistence is retried on the next turn.
