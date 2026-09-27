# Write completion presentation

Guarded `write` opts into hiding its call body in a collapsed terminal card.
The same component retains its call ID, arguments and original result. Expanding
reveals the existing content view and receipt text. Model history and provider
payloads are unchanged; this does not reduce model input tokens.

`Added` requires a successful structured creation receipt. `Modified` requires a
successful committed overwrite receipt. Partial, cancelled, unknown and failed
receipts remain distinct; unstructured prose cannot establish success. Streaming
results say `Write running`, even when their text happens to say `Added`.

## Verification and allocation scope

The call-chain audit covers provider tool argument ownership, Agent event delivery,
AgentSession delivery, InteractiveMode tool updates, ToolExecutionComponent,
built-in write highlighting, guarded result rendering, retained TUI layout and
final component release. Execution and receipt construction are unchanged.

The existing `tui-tool-leaf-allocations.ts` profiles the full delivery chain. The
focused `write-completion-card.ts` supplements it with a 4,000-line write, 1,000
stable renders and 25 expand/collapse cycles. On Windows / Node 26.4.0, the latter
observed zero renderer calls during stable renders and zero highlight rebuilds
during toggles. Final release cleared highlight arrays, receipt/content references
and derived Text bodies. One controlled-GC run measured 24,710,504 bytes before
sampling and 24,204,112 after release; sampled allocation was 180,743,704 bytes
including the explicit expanded 4,000-line layouts. These are a local sample,
not a universal heap or timing guarantee.

The call component owns one current highlight cache, bounded by the existing
write argument size; it is reused across completion and expansion, replaced on
argument changes, invalidated on theme/layout invalidation, and released even
while hidden from the mounted tree. No pool or per-render probe was introduced.
The result component retains only current receipt/content identities and summary,
and releases them on unmount. Tests verify narrow output, streaming, terminal
states, long content, object preservation, release, and real guarded writes after
session reopen. Existing source/AST gates remain intact.

Hidden third-party call-release hooks are error-isolated: the parent advances its
lifecycle generation, drops the hidden component reference, runs derived cleanup,
clears image/discovery references, and only then rethrows the first error. A regression
injects both a hidden-hook error and a derived-hook error and checks the release state.
