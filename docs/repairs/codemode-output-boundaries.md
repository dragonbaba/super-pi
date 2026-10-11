# Codemode output boundary verification (T09.3)

## Scope and design gate

Baseline: `569961d6eb5830a26a0c113fbc82d764fa1e6427` (PR #110 merged).
T09.3 is a verification task: add compact separators only if real provider
conversion makes distinct `text()` / `console` results run together. Do not
introduce upstream output wrappers without evidence or increase any quota.

Source inspection finds newline joins in Chat Completions, Responses, Anthropic
text-only results, Google and Mistral. Bedrock retains separate content blocks;
Anthropic mixed content and Pi Messages also preserve block structure. Verify
these observations with actual AgentSession/Codemode output at each adapter's
post-conversion `onPayload` boundary before deciding on a production change.

The planned fixture uses three script executions (text/console/return, image
interleaving, and failure after output), then reuses the resulting context across
the ten API adapters. Captures stop before transport with a known sentinel;
credentials are dummy values. The existing session fixture owns and closes its
session/worker and removes its exact temporary directory. Captured payloads are
local to the check; no background process or persistent resource is added.

Audited chain: VM `text` / `console` → `output` / primitive worker bridge → host
output items / `finish` / worker termination → `CodemodeController.execute`
summary, return/error, shown blocks and `capCodemodeOutput` → Agent LLM context →
provider capability projection and message conversion → request payload.
The output cap and spill mechanism already retain blocks or add newlines to
saved text. Existing output limits and their tests remain the acceptance bounds.

No production modification is planned unless this fixture reproduces a missing
boundary. Test-only coverage adds no production allocation, encoder, wrapper,
pool, cache or retained owner; an allocation benchmark would not measure a code
change in that case. Provider response deltas and terminal rendering are outside
the changed scope.

## Verification result

**No missing boundary was reproduced; retain the existing production behavior.**
The test runs three real scripts through the session, obtains the context seen
by the next model turn, and captures each actual adapter's converted payload:

| Adapter | Text result boundary observed |
| --- | --- |
| OpenAI Chat Completions | Text blocks joined with one newline per boundary |
| OpenAI Responses, Azure Responses, Codex Responses | Same newline join; mixed output has a single joined `input_text` beside image items |
| Anthropic | Newline join for text-only results; distinct text blocks in mixed output |
| Google Generative AI, Vertex | Newline join in `functionResponse.response.output` or `.error` |
| Mistral | Newline join; failures additionally have the existing `[tool error] ` prefix |
| Bedrock | Distinct `toolResult.content` text blocks; blank blocks are omitted |
| Pi Messages | Original tool-result content array |

The text-only result contains the existing Codemode summary, `alpha`, an empty
item, `beta {"n":2}`, a multiline item and the returned `omega`. The resulting
text is checked exactly, including the blank-item newline, so `alphabeta` or
duplicate wrapping cannot pass. Mixed output checks text before and after an
image; failure checks prior text, console diagnostics and the script error.
All three results survive as separate tool responses. Every conversion also
leaves the retained source message history deeply equal to its original value.

The existing joins contribute exactly `textBlockCount - 1` newline characters
when there are text blocks. There is no new separator or wrapper overhead.
VM output still has the 1 Mi-character / 1,024-item limits. The controller adds
its summary, at most one return/error item and at most 256 shown blocks before
the existing token cap, which may append one recovery notice. This gives a
conservative maximum of 1,282 inter-block newlines; the token cap further limits
retained text. Native content-block paths
do not need an extra text wrapper to preserve boundaries. This does not promise
recovery of the exact `text()` call grouping from arbitrary multiline text.

Windows x64 / Node 26.4.0: 29 checks passed, zero skipped; type check passed:

```powershell
node --experimental-strip-types --test --test-name-pattern 'text and console boundaries' tests/codemode-session.test.ts
node --experimental-strip-types --test tests/codemode-output.test.ts tests/codemode-hot-paths.test.ts tests/source-invariants.test.ts
npm.cmd run check
```

The new check is one session fixture with ten adapter subtests (11 reported
tests), not ten repeated VM/session runs. Six existing output/limit/recovery
checks and twelve source/hot-path invariants passed. Spill fixtures remove their
recorded files/directories; the session fixture shuts down its owned resources.
No full local test suite, unrelated build or allocation benchmark was repeated:
the final diff contains only this record and integration coverage, with no
production change to measure.

Captures stop intentionally at `onPayload`, before provider transport. They
prove local request conversion, not server-side tokenization, model
interpretation, real provider credentials or online multimodal acceptance.
The fixture uses tool-capable models with image support; provider-specific
image reordering and empty-block normalization remain existing behavior.
T09.4 worker installation replacement is a separate task.

Raw local evidence: `.git/t09-3-codemode-output-boundaries-20261011/`.
