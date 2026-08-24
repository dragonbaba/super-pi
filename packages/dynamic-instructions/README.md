# @super-pi/dynamic-instructions

Pi 0.84.1 compatibility extension for append-on-change workspace instructions and skill catalogs.

## Behavior

- Reproduces Pi's exact `contextFiles` and visible-skill sections from `before_agent_start.systemPromptOptions`, including all five Pi XML escapes.
- Removes each exact section only when it occurs exactly once in the final ordered `before_agent_start` waterfall; earlier extension-owned prompt insertions are preserved regardless of position, while missing or duplicate sections fail closed.
- Replaces Pi's uniquely matched verbose documentation directory with one stable conditional sentence; source-shape drift leaves the original text untouched.
- Appends one hidden `dynamic-instructions-v1` custom message on first non-empty state or when effective bytes change.
- Writes complete replacements and explicit empty tombstones; older values remain immutable Session history.
- Restores the latest valid SHA-256 pair from the active Session branch, so resume/reload/branch does not duplicate unchanged guidance.
- Keeps only one projection and two hashes in closure state. An unchanged ordinary turn follows an options/result identity path with no hashing, serialization, or result allocation.

Skill bodies are never copied: only Pi's existing skill catalog metadata is moved. Permission checks and tool availability remain runtime-owned.

## Bounds and failure mode

- at most 64 context files;
- at most 256 model-invocable skills;
- at most 2,048 characters per path;
- at most 256 KiB combined dynamic section bytes.

If bounds, unique-section cardinality, or Pi's exact formatting contract do not match, the extension fails closed: it leaves the original core system prompt untouched and emits no replacement.

## Verification

```bash
npm run typecheck
cd ../../maintenance/pi-core-compat
npm run test:dynamic-instructions
npm run benchmark:dynamic-instructions
```

The package must be re-audited when Pi changes its system-prompt context or skill formatting.
