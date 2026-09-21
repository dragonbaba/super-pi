# Policy diagnostics and Pi 0.84.1–0.86.1 assessment

This record belongs to the `fix/concise-policy-diagnostics` task branch. It does not change the Super Pi version and does not copy or merge the upstream source tree.

## A: implemented scope

The refusal path now carries a small `PolicyDiagnostic` in machine details and projects a single bounded model view. `packages/extensions/resource-lifecycle-guard/core.ts` records the parsed descriptor-duplication fragment at the redirection scanner, so `2>&1` is reported only when it was recognized as shell syntax. Quoted text and heredoc data remain separate parser cases. `packages/agent/src/agent-loop.ts` projects legacy structured `POLICY_BLOCKED` refusals only on the blocked branch; the original fields remain in `toolResult.details` for audit and machine consumers.

Representative model views are:

```text
[POLICY_BLOCKED:FD_DUP_UNSUPPORTED] Not executed:
Bash analysis does not support `2>&1`.
Next: omit stream merging only if stderr need not pass through the pipe; resubmit for authorization.
```

```text
[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED] Not executed:
Bash analysis cannot inspect the `powershell` launcher.
Next: use an enabled native tool for this query only when it is available; normal authorization still applies.
```

The native-tool sentence is conditional and does not claim that PowerShell is enabled. Permission mode, scope, target identity, cwd, approval state, audit records, `retryable`, and `stateChanged` remain enforcement data. Unsupported syntax remains blocked in `full-access`; the implementation does not add a whitelist, rewrite a command, replay it, or move it to another shell. A user rejection and a protected path use their own conservative categories and do not receive a tool-switch bypass.

The four supplied commands are stored in `tests/policy-diagnostics.test.ts` and are only sent through scanners, preflight, the ExtensionRunner, and an offline Agent fixture. The mixed PowerShell command is refused first by lifecycle preflight because its launcher grammar is unsupported. The `cmd /c` query keeps its existing permission-path order and is refused there for the unsupported descriptor duplication. The other descriptor-duplication cases are refused by the high-risk permission assessment after lifecycle inspection. Backend execution and process creation were both zero.

The fixed token fixture uses `cl100k_base` only as an estimate: the old JSON view measured 65 tokens, the candidate short view 46 tokens, and the provider serializer received exactly the 189-code-unit short text. The candidate is below the 128 estimated-token target. This is fixture evidence, not billing or model recovery-rate data.

The current follow-up assessment is deliberately separate: literal `2>&1` support may be evaluated as a later narrow parser slice, but is not implemented here.

## B: pinned source and method

The upstream repository was read at the real tags `v0.84.1` → `v0.86.1`:

- `v0.84.1` = `53fa77ccd8a279eb87e92294ef3687b03ff80112`
- `v0.86.1` = `13cbf77df2396303013a41646bcfa77b4271ae56`

The comparison used read-only Git objects and file diffs. The Super Pi side remained at `dbc5a46f4ad13b7750af07416636d078e07c0d19` when the task branch was created. No upstream merge, lockfile update, npm update, version change, or second source checkout was made.

| Priority | Upstream source | Super Pi comparison | Value and adaptation boundary | Recommendation |
| --- | --- | --- | --- | --- |
| P0 | `b2602be77cb7b0de45dd616407fd210daa48aa75`, `packages/ai/src/utils/event-stream.ts` | `packages/ai/src/utils/event-stream.ts` still uses `queue.shift()` and `waiting.shift()` | Correct FIFO semantics are already shared; the two-stack queue reduces repeated front removal under backlog. It is CPU/allocation work, not token reduction. Audit final-result and iterator release, then run stream tests and `bench:stream`. | First independent upstream slice after A, if backlog evidence shows it matters. |
| P0 | `40c256cccbce062f6af5f2cacb85d0ce1ab4224d`, `packages/coding-agent/src/core/extensions/loader.ts` plus `jiti-static-loader.ts` and `virtual-modules.ts` | Super Pi already defers jiti, but `loader.ts` still statically imports virtual module payloads | Likely startup memory/CPU benefit. Preserve Super Pi aliases and extension SDK namespace; verify source TypeScript, first extension load, no-extension CLI, and bundled/SEA paths separately. | Small, isolated startup slice. |
| P1 | `661619e87277d92caa2af71960112d9d92c13a5c` and `0e283203c7fe903ed1b3b9076252ab024748221c`, `packages/ai/src/utils/overflow.ts` | Super Pi keeps the bodyless `400/413` rule generic and does not include the z.ai `Prompt too long` text | Correctness and cost: a false overflow can trigger compact/retry; a missed z.ai overflow can fail later. Scope bodyless matching to Cerebras, add z.ai only with provider evidence, and retain Super Pi’s own recovery decisions. | P1 provider-specific slice after a provider fixture matrix. |
| P1 | `5901446094988aa5cd8e11efdaa131c3949106f1`, `packages/tui/src/fuzzy.ts` | Super Pi keeps the character loop but already has a dedicated regex module and its own scoring helpers | CPU improvement for fuzzy filtering. Borrow `indexOf` progression only; keep Super Pi regex constants, punctuation semantics, token splitting, and score tests. Audit closure and high-frequency temporary allocations. | P1, only with the existing fuzzy benchmark and semantic corpus. |
| P1 | `60740991c0bba00d22ea259de7b30b27c5294103`, Node compile-cache changes | No `enableCompileCache` path was found in the current coding-agent runtime | Startup CPU improvement with filesystem/cache lifecycle risk. Test cache directory failure, read-only environments, Windows and Linux, and cold/warm startup. | P1 if startup measurement justifies the cache lifecycle. |
| P1 | `46c9de402bddf46b03c3b9f46487b777aaa41861`, extension handler unsubscribe | Super Pi already has tracked event-bus and agent/session unsubscribe paths in the loader, runner, interactive mode, and RPC/print modes | Mostly lifecycle correctness and retained-reference control. No implementation task until a missing handler ownership case is reproduced. | Verify current behavior; no blind port. |
| P1 | `de2de549bcc369726b2e1a50d1626c39806ccc09`, compaction cancellation; `64eeb82a4694335ed9f6a4dc2fa6fb198d71ef26`, unterminated Codex SSE terminal events | Super Pi has its own compaction cancellation boundaries and provider stream handling, including local session cleanup contracts | Correctness and resource release. Compare provider-by-provider terminal events, abort, compaction, and retry state; do not replace Super Pi’s lifecycle contract with the upstream file. | P1 only for a reproduced provider or cancellation gap. |
| P1 | `46bde88a1cd752966aa2a357d292e83aff98b132`, per-model compaction budgets | Super Pi already clamps compaction from model context/max tokens and has `provider-aware-compaction` | Partial overlap. Adapt only the budget precedence and persistence rules that are absent; verify paid boundaries, provider-native compaction, and model switching. | P1 after a concrete budget mismatch is identified. |
| P1 | `fcff255b004a6cde812b5b7a714e0bfe9c540986`, strict-prefer built-in tool schemas | Super Pi already resolves strict schemas through model capabilities and provider-specific adapters | Largely present. Do not port defaults without checking Super Pi’s provider capability overrides, especially Cerebras, Bedrock, Google, Mistral, and OpenAI-compatible routes. | No task from release notes alone. |
| P2 | `6dfc66d32aec503846ee7fafbee1084809f17a9e` and related session migration/resume changes | Super Pi has its own session manager, read-window snapshots, continuation artifacts, and provider projection | Partial and incompatible at the persistence boundary. Compare headers, progressive resume, and continue semantics against Super Pi’s session schema; no transcript migration in this task. | Design review only. |
| P2 | provider routing/request-field changes across the 0.84.1–0.86.1 diff, including `3eda805d0cbaabb3233588dd6aa40ee248a1a6dc` | Super Pi has custom provider-aware routing, cache fields, strict capabilities, and `pi-messages` request contracts | Correctness and cost are provider-specific. Build a route/field matrix from actual user providers before changing shared serialization. | Only implement a provider-reproduced mismatch. |
| P2 | `509ee2bd0ba9fc3d31fb96fe8f5a6ef73b51833c`, fail-closed user Bash hook errors | Super Pi’s extension runner and lifecycle guard already treat hook failures as execution blockers in the current chain | Security correctness appears present; verify error identity and no backend call in the existing regression suite. | No new task without a failing fixture. |

Prompt cache warming (`c596d09d9cef6fdf0db2dd08f3eec8582b7fe8ba`) is intentionally deferred. It creates an additional model request and can add provider charges; it must not be described as “one token” or enabled in the background. TranscriptContext/transcript-backed prompt tools are also deferred because they cross provider input, session history, extension, persistence, and cache-prefix boundaries. Clipboard changes are platform comparison only. Bug-report upload and remote diagnostics are not connected, and Claude Code/OAuth identity simulation remains disabled.

The first recommended independent upstream slice is the EventStream two-stack FIFO, after the A PR is reviewed: it has a narrow file boundary, an explicit FIFO test surface, no permission or provider-policy coupling, and a measurable backlog cost. The extension-loader lazy virtual-module change is the next startup slice.
