# CodeMode batch reads and exact edits

The previous multi-file example returned counts and omitted source. The first replacement showed successful reads but grew the first request by 67 tokens in a three-file reading probe. A live edit trace also found a host read unnecessarily repeated to obtain a sandbox snapshot. The revised gateway consolidates discovery and failure instructions, shows source when judgment requires it, and gives the native file_batch shape for exact edits. Host exact edits reuse current read evidence across scripts. Sandbox items require their own verified snapshot.

Session tests exercise the actual read example with both files present and with one missing, then inspect the next model request. A separate regression batch-reads two files and applies both exact edits from the following script. Type checking and the twelve-package build passed. The local Windows suite passed 6,554 tests with 119 skipped across 486 units. Both real MXC acceptance modes passed separately with the dist worker. No runtime hot path changed.

## Live comparison

The provider was openai-codex/gpt-6.2-sol with medium thinking. Each task used three fresh sessions per version in ABBAAB order, an identical working directory per task, and freshly restored file bytes. A used the main-branch gateway at `7391117cb` (the sibling TUI checkout, in JSON mode). B used the revised prompt. Tool selection was read,edit,file_batch. Context files, MCP, skills, prompt templates and extensions were disabled. Model turns include the final answer. Token counts come from assistant usage on every request, including cached input. They measure usage, not invoices.

| Task | Turns A → B (individual runs) | First input A → B | Mean uncached input A → B | Mean cache read A → B | Mean output A → B | Mean total A → B |
| --- | --- | --- | --- | --- | --- | --- |
| Trace three files | 2,2,2 → 2,2,2 | 3,200 → 2,895 | 4,153 → 3,791 | 2,560 → 2,304 | 122 → 123 | 6,835 → 6,219 (−9.0%) |
| Replace a literal in three files | 7,5,5 → 3,3,7 | 3,201 → 2,896 | 15,245 → 8,590 | 10,240 → 7,680 | 260 → 285 | 25,746 → 16,555 (−35.7%) |

Every run read each file exactly once. All reading answers explained the transformation and produced `pinetree:x/opal`; all edit postimages matched byte for byte. Two candidate edits used one read script and one file_batch script before answering. The third used two file_batch calls and took seven turns (30,023 tokens). Three runs per task characterize these fixtures only.

## Reproduction

After integrating the stable delegation guidance, a separate dependent-file task used the same Sol configuration and working directory on base `00fa42093` and candidate `a9c7c0f18`. The model read `route.txt`, changed only the selected `blue.txt`, and reported its name. The manifest and the `red.txt` decoy remained byte-identical. One run per version took 6 → 5 model turns, 10,364 → 10,200 uncached input tokens, 12,800 → 6,912 cached input tokens and 197 → 160 output tokens. This single pair checks ordered execution and does not estimate an average.

For the read fixture, app.js imports compact from format.js and returns compact(value) + '/opal'. format.js imports prefix from label.js and returns prefix + value.trim(). label.js exports the string 'pinetree:'. The prompt was “Read app.js, format.js, and label.js. Explain how receipt obtains its result and give the exact output for input ' x '.” For the edit fixture each file contains `export const channel = 'copper';`, then a comment with its filename, both lines LF-terminated. The prompt was “Change the channel string from copper to silver in app.js, format.js, and label.js. Preserve everything else. Report the files changed.”

Run each built CLI in the same synthetic task directory with `--mode json --no-session --no-context-files --no-skills --no-mcp --no-extensions --no-prompt-templates --tools read,edit,file_batch --provider openai-codex --model gpt-6.2-sol --thinking medium -p` followed by the task prompt. Sum the assistant message_end usage records once per completed turn. For the deterministic regressions run:

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/codemode-r2-description.test.ts tests/codemode-independent-batch.test.ts tests/codemode-session.test.ts tests/mcp-background-activation.test.ts
```
