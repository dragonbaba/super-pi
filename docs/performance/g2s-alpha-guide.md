# G2S Alpha validation guide (candidate work in progress)

This guide supersedes the former PowerShell large-output projection procedure. G2 Alpha manual validation remains blocked; automated results do not certify a user's Windows Terminal session. G3–G10 remain unstarted.

Run commands from the existing candidate worktree, `D:\RMProjects\Pi-g2s-alpha-runtime`. Do not modify, rebuild, reset or clean the fixed manual copy `D:\RMProjects\Pi-g2-final-main-d5516ca`.

## Direct raw ToolResult checks

```powershell
npm run build:offline
npm run alpha:g2-probe
```

The probe creates isolated temporary HOME, config and session directories, uses an offline fixture model without an API key, and removes only its owned directories. The raw result producer is test-only and is not registered in the normal CLI tool list or exported as stable package API. It returns AgentToolResult content directly, without PowerShell, Bash, read, MCP or a stdout adapter. Output contains scalar counters and test names, not complete large results.

Coverage includes 1 KiB, 64 KiB, 256 KiB, 1 MiB, a 10 MiB single line, 10,000 repeated errors, structured JSON, CJK, ANSI and a CRC-checked PNG with marker companion text. Seed, source digest, bytes/code units, unique markers and toolCallId are checked. Direct owner continuation, actual AgentSession/provider projection, canonical UI content, artifact identity and parallel ordering are separate assertions.

For high fanout, **129 results at total budget 1024 must fail closed with typed `budget-too-small`**: all 129 executions finish, only the initial provider request occurs, the turn terminates, canonical results remain available and later input works. The effective share is seven tokens; the production-estimated recovery notice cannot fit. Do not call this a G2 projection regression solely because a second request is absent.

The independent **129 at total budget 16384** fixture must make exactly two provider requests, retain canonical result order, keep combined projected tokens inside the envelope and validate all 129 continuations. The production contextual-budget algorithm is unchanged. A future aggregate batch manifest is backlog `D-G2D-HIGH-FANOUT-BATCH-MANIFEST`, outside G2S.

## PowerShell is a different boundary

The built-in PowerShell tool truncates at its own approximately 50 KiB limit before AgentSession/G2 receives content. A single 256 KiB shell output or four parallel 64 KiB shell outputs therefore cannot prove or disprove raw G2 projection. The upstream fixture verifies the real accumulator, its separate complete spill file and `fullOutputPath`. G2 owns the already-truncated result, not the omitted shell bytes. A PowerShell spill file is not a G2 continuation artifact.

## Startup and terminal capture

```powershell
node scripts/alpha-startup-capture-run.mjs --tui-mode regular
node scripts/alpha-startup-capture-run.mjs --tui-mode fullscreen
```

The capture runner isolates HOME/config/session and enables the default-off phase capture. Inspect the printed report path for phase, duration, generation and error code; it does not log prompts, keys, full paths, messages or results. Exercise `/quit`, Ctrl+D and double Ctrl+C in separate launches. Record exit code and whether raw mode, cursor and bracketed paste recover. Native terminal behavior must be observed by the tester; pipe-backed tests are explicitly labeled as such.

The clean-HOME/no-model sentinel startup failure has a deterministic regression test and a fix. The user's originally reported configured-copy startup failure still has no confirmed cause. Preserve that distinction in any report; do not attribute an unknown startup failure to the historical `/quit` title-write bug.

## Streaming measurements

```powershell
node scripts/alpha-bench.mjs stream --layer 0 --rate 20 --count 40
node scripts/alpha-bench.mjs stream --layer 1 --rate 20 --count 40
node scripts/alpha-bench.mjs stream --layer 2 --rate 20 --count 40
node scripts/alpha-bench.mjs stream --layer 3 --rate 20 --count 40 --delay 20
node scripts/alpha-bench.mjs stream --layer 3 --rate 100 --count 200 --history 50000 --corpus word --profile on
node --experimental-strip-types scripts/bench/alpha-source-audit.ts
```

L0 generates chunks only; L1 consumes them in AgentSession; L2 adds the actual interactive TUI with a memory terminal; L3 uses ProcessTerminal and a Writable with controlled callbacks. Reports carry exact HEAD/dirty state. Repeat timing in at least five independent processes and report p50/p95/p99/max/CV. Keep CPU-heavy tests separate from timing runs.

Provider inter-arrival, event/handled latency, render duration and physical-write marker arrival are separate measurements. An injected Writable's write entry is not proof of when pixels appeared in Windows Terminal. Requested update rates are fixture schedules, not measured provider token/s. A provider delivering 10–20 tokens/s is not itself a TUI regression. Correlated smooth provider arrivals and additional visible freezes require investigation.

The 100k stress fixture deliberately dispatches actual session-to-component updates so observer coalescing cannot turn 100,000 generated chunks into a handful of UI calls. Its GC-enabled run warms up and measures five complete owner lifetimes, checking WeakRefs after each. Corpus tests separately cover exact 1/4/16/64 code-unit chunks, growing responses through 256 KiB, thinking/text, final-first delivery, final immediately after delta, abort/error and tool interleaving. Content/queue correctness is not a latency pass.

## Gate

Use [the status ledger](g2s-status.md) for unresolved findings and [the measurement packet](g2s-measurement-checkpoint.md) for evidence limitations. Full final exact-head tests, cross-platform CI, remaining adversarial coverage and cumulative Draft review are still required. Do not Mark Ready or merge, and do not claim Alpha manual validation passed.
