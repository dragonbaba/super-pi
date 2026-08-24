# Tool repair telemetry and analytics

Non-intervening telemetry for Pi 0.84 tool-input repair metadata, false-success interventions, and compaction frequency/fallbacks in one bounded cross-Session aggregate. This extension owns the single `/tool-repairs [--json]` command and the single existing JSON store. It does not alter tool calls, model messages, prompts, compaction policy, or `/tool-errors`.

The version-gated `tool-input-repair-v1` core recipe attaches non-enumerable metadata to successfully repaired argument objects. Bounded `tool_call` and `tool_result` listeners read only that metadata and deduplicate by call-id/kind, so repairs attached by later preflight handlers are still counted; neither listener serializes or compares tool payloads. Repair kinds include `optional_null_omitted`, `json_array_parsed`, `bare_value_wrapped`, `empty_placeholder_to_array`, `primitive_coerced`, `markdown_path_unwrapped`, `read_offset_clamped`, `batch_duplicate_blocked`, and `repeated_call_blocked`.

## Persistent aggregation

At `agent_settled` (with shutdown as a final lifecycle seam), the extension snapshots only entries after its latest branch checkpoint, merges bounded pending auto-repair metadata, acquires a bounded inter-process lock, atomically writes the store, and appends a checkpoint custom entry. Flushes are serialized; each takes its repair batch only when execution begins, so a failed settled flush requeues its batch before an already queued shutdown flush consumes it. A bounded hash ledger prevents duplicate counting after resume or branch navigation.

Each bucket is keyed by:

- Asia/Shanghai calendar day
- model
- tool
- deterministic category
- repair/outcome state
- Pi or safety-component version anchor

Successful calls provide first-pass tool denominators. Terminal assistant completions and `goal_complete` attempts add bounded `completion_opportunity · observed` denominators for the current false-success guard version; the report compares persisted intervention entries with those opportunities and explicitly labels the result as intervention frequency, not false-positive rate. Because intervention audit persistence is best-effort, the numerator may undercount if session entry persistence fails. Failed calls reuse the deterministic `session-tool-errors` classifier and retain the immediate repair outcome. Policy blocks, LSP `workspace_escape`, intentional `duplicate_call` deduplication, and persistent `repeated_call_blocked` prevention use outcome `blocked`; same-assistant-batch abort cascades contribute one `tool_batch · aborted` event rather than one event per cancelled result. Proven standalone ripgrep no-match is successful `no_match`. False-success interventions come from `false-success-intervention-v1` custom entries. No prompt, argument, command, path, tool output, reasoning, discarded draft, session ID, or unhashed entry ID is stored.

Component-version anchors are checked in cold tests against the authoritative mutation-guard package and false-success core/package versions. This keeps each derived numerator and denominator in one version scope. Historical buckets retain their original version labels and are neither rewritten nor merged into the current component version.

Persisted `compaction` entries provide successful `compaction_frequency` events. Strategy is derived only from reviewed `providerAwareCompaction`, `remoteCompaction`, mechanical-prune markers, `fromHook`, or Pi-default metadata; the active model is seeded from the branch state before the latest aggregate checkpoint. Failures that cannot create a compaction entry use the shared `compaction-telemetry-v1` custom-entry contract. Its parser accepts only reviewed model-safe dimensions, strategy/outcome/reason enums, and exact producer versions. Fallback categories combine strategy and bounded reason so buckets remain aggregated by model, strategy/type, result, and reason without a schema migration or second database.

Compaction producers never write a success event, preventing double counting: the persisted compaction entry is the sole success source. Custom entries cover only cancellation or fallback seams. An OpenAI compaction whose signal is aborted after its parallel requests settle is recorded as `cancelled · aborted` before any local/default/emergency fallback classification, because Pi core will reject that compaction. Neither producer nor collector stores prompt, summary text, provider errors/responses, URLs, headers, credentials, provider cache keys, or raw tool arguments.

The store retains at most 90 days, 4,096 buckets, 16,384 truncated SHA-256 event identities, and 2 MiB. Schema v1 stores from older analytics implementations are accepted only after every current bound, dimension, count, timestamp, and event hash validates; their metadata is normalized and atomically upgraded on the next merge. Truly invalid stores remain fail-closed. Pending non-enumerable repair metadata is capped at 2,048 events per settle interval. Repeated identical aggregation failures notify once per runtime until a successful flush resets the warning state. The aggregate lock is a crash lease with a bounded owner record containing an owner UUID, PID, acquisition timestamp, process start timestamp, and startup identity. A stale lock is recovered only after its exact shape is validated and its recorded process is dead (or the same PID is proven to belong to an older startup); live owners are never removed. Release verifies exact ownership and removes only the owner file and empty lock directory. Atomic staging paths remain cleaned in `finally` blocks.

## Reproducible aggregate benchmark

`npm run benchmark:aggregate` scans 10,000 entries for 9×100 iterations. On the uncontended sequential unified-audit run, the ordinary custom-entry workload measured median 0.0301 ms / p80 0.0333 ms with output hash `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`; the workload containing 32 compaction/fallback metrics measured median 0.0757 ms / p80 0.0787 ms with output hash `40647aa90b8c8b13b9f10b29b40fb10f33c9b554af2c787b6ee142d7354780d6`. This collector runs only through the existing settled/shutdown flush path, not prompt assembly, tool execution, or token streaming.

## Command

```text
/tool-repairs
/tool-repairs --json
```

Markdown and JSON expose the same bounded buckets plus derived false-success intervention-frequency and compaction success/fallback summaries, without the deduplication ledger. TUI reports up to 100,000 characters are copied to the clipboard; otherwise output is atomically written to `<current-project>/.sp/tool-repairs-report.md` or `.json`.

`/tool-errors` remains the unchanged detailed current-Session/current-branch diagnostic command. The prior process-local `status|reset` command contract is retired; there is no second repair command or alias.
