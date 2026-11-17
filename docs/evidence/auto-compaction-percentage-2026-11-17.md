# Provider/model automatic compaction percentage — 2026-11-17

## Behavior and ownership

[Current user guide](../auto-compaction.md) specifies the default 85% policy,
free-text command/settings input, global per-provider/model persistence and
effective model capacity. `agent-core/compaction-policy` owns the pure calculation;
coding-agent threshold checks, prune feasibility and context accounting consume
it. The harness helper uses the same default and inclusive comparison.
`reserveTokens` continues to budget summary/request preparation, including branch
summarization, and is not subtracted again from the percentage threshold.

All production settings resolution uses the active or guarded request model.
Subagents already pass their selected provider/model to the ordinary CLI and
load the same global settings; no parent-resolved percentage is copied into a
child. Same-name models under different providers have distinct escaped keys.
Per-key locked persistence preserves concurrent edits, even within one provider.
Project files cannot override this global preference. Saving a percentage waits
for storage completion and reports write errors.

## Hot-path audit and measurement

The audited chain is footer/statusline event/render → session context usage →
compaction-aware epoch lookup → settings percentage lookup → pure threshold.
The existing usage object gains three primitive fields. No new callback,
Promise, controller, history materialization or wrapper object is introduced in
normal lookup. The settings owner retains only one small encoded identity key;
changing the pair replaces it. Values are not cached, so saves/reloads take
effect without stale policy. Disposal/GC releases the owning session/settings.
Dialog callbacks, save snapshots and command status strings have explicit
user-interaction/setup lifetimes. The footer changes a short label within its
existing bounded two-line materialization; frame transport/backpressure is
unchanged.

Same-machine offline fixture: 160 paired historical tool calls, 329509 expected
tokens, 256 queries, with complete equivalent history. The baseline is commit
`89126fdc5ef86a5c12da02aa51d4937312cb62aa`.

| Query measurement | Before | After |
| --- | ---: | ---: |
| Historical JSON serializations / UTF-16 units | 0 / 0 | 0 / 0 |
| Sampled allocation bytes | 2093064 | 1788792 |
| Peak heap bytes | 48619656 | 48764744 |
| Heap after release/GC bytes | 45508408 | 45658216 |
| CPU microseconds | 0 | 0 |
| Retained session owners | 0 | 0 |

CPU values are below this run's timer resolution; allocation samples fluctuate.
This is no performance-improvement claim. The after run also verified zero
identity encodings during steady queries and zero retained settings owners.

A separate `--footer` run measures the actual footer at width 160, 256 renders /
512 output lines. For the baseline, the exact prior FooterComponent source was
loaded with only its relative import locations relocated; both variants use the
same current context engine and full history to isolate the footer change.
Both rendered 73472 characters, with zero history serializations or identity
encodings. Sampled allocations were 9261832 → 9153032 bytes; peak heap
56134632 → 56076440; after-release heap 45871960 → 45811320; CPU
0 → 16000 microseconds (coarse timing, no speed claim). Session, settings and
footer retained-owner counters were zero in both runs. Allocation sites remain
the existing branch retrieval, width truncation and grapheme/layout work.

## Verification scope

Regressions cover inclusive boundaries, independent reserves, percentage input
and cancellation, concurrent save/restart/reload, provider/model/capacity changes,
project precedence, write failure, real command behavior, real threshold
compaction/accounting, prune feasibility and the no-loop materialized boundary.
AST and runtime counters guard lookup allocations. Provider-prefix fixtures
exercise actual serialized requests across built-in APIs, catalog transitions
and compaction; policy edits do not change the fixed prompt/tool prefix.
All measurements use offline fixtures; no original user session, paid provider
compaction or completed tool operation was replayed.
