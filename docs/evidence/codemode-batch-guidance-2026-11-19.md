# CodeMode batch reads and model turns

The previous multi-file example printed completion counts and omitted the source a model needed to decide the next step. The default gateway now shows successful reads from the batch and reports any failures. Its system guidance groups independent inputs, continues computable dependent steps within one script, and returns the relevant originals when a decision requires model judgment. Known independent edits across files use the existing `file_batch` tool when available.

Two session regressions execute the example from the actual tool description and inspect the following model request. Both source markers arrive together when both files exist. When one is missing, the other marker arrives with the failure diagnostic. The three relevant suites passed 146/146 locally. Type checking and the 12-package offline build passed. The change touches prompt text, documentation and tests only. No runtime hot path changed.

## Live comparison

One paired run per task used the CLI from base `7391117cb` and the candidate, with openai-codex/gpt-6.2-sol, medium thinking, fresh sessions, identical synthetic files, and the same read/edit/file_batch tool selection. Context files, extensions, skills, MCP and prompt templates were disabled. The prompts named all three files without specifying an orchestration strategy. Model turns include the final answer.

| Task | Model turns, base → candidate | CodeMode scripts | Repeated reads | Verified outcome on both |
| --- | --- | --- | --- | --- |
| Trace a three-file call chain and calculate the output for a whitespace-padded input | 2 → 2 | 1 → 1 | 0 → 0 | One batch read all three files. Both answers explained trimming, prefixing and suffixing and gave the exact result. |
| Replace one specified literal in each of three files, preserving all other bytes | 7 → 8 | 6 → 7 | 0 → 0 | One batch read all three files, then one native file_batch applied the edits. All three postimages matched byte for byte. |

The baseline already batched both tasks. These samples verify output and tool choice, and do not establish an increase in adoption or a reduction in model turns.

Rerun the deterministic checks from the repository root after building offline:

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/codemode-r2-description.test.ts tests/codemode-independent-batch.test.ts tests/codemode-session.test.ts
```
