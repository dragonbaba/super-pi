# Super Pi

An extensible terminal AI coding assistant for real engineering work, focused on controlled execution, continuing project context, and long-session terminal workflows.

[简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Documentation](docs/README.md) · [Upstream follow-up](docs/upstream-pi-history-followup-plan.md) · [GPL-3.0-only](LICENSE)

Super Pi is a source-first coding agent. It combines a model provider, project files, and local tools into a persistent working environment: inspect a project, plan a change, run checked operations, resume a session, and load only the extensions you need.

## What it is for

Super Pi is useful for work that needs several rounds of exploration and change:

- Understand an existing repository and locate relevant files, configuration, and call paths.
- Implement a bounded change, run local checks, and keep the reasoning trail in a session.
- Explore in Plan mode before handing an accepted plan to implementation.
- Keep project context, goal state, or reviewed memories across sessions.
- Switch models, sessions, and tool scopes without leaving the terminal.

For a single prompt and a single text response, a direct model API call may be simpler. Super Pi adds an engineering workflow around the request:

| Direct model API call | Super Pi adds |
| --- | --- |
| The application assembles tool calls and context | Built-in read, search, edit, write, and Shell tools with tool-result history |
| Requests are usually independent | Sessions, resume, branches, import/export, and context compaction |
| The application implements approval | Tool policy, project trust, preflight checks, and final authorization |
| The application owns the UI and streaming state | Regular and fullscreen TUI, selectors, progress, and result presentation |
| Provider integrations are separate | Multiple provider catalogs, stored authentication, extensions, Skills, MCP, and RPC |

These capabilities still depend on the provider, model capabilities, project configuration, and active tool policy. The selected execution mode determines whether supported tools use Windows Sandbox; application permissions do not guarantee model output or external-service behavior.

Windows Sandbox commands require **PowerShell 7**, with no Windows PowerShell 5.1 fallback. Tool installations are discovered automatically from the host PATH and mounted read-only with their installation-relative dependencies; normal tools do not need individual configuration. File tools accept relative paths and host absolute paths inside the session workspace; commands use the guest working directory. Networking is disabled by default; set global `sandboxNetwork: "enabled"` to allow it. Host `node_modules` is excluded, and dependencies installed inside the VM stay there. See [workspace paths and networking](docs/execution-environments.md#工作区路径与网络配置).

## Quick start

### Requirements

- Node.js 22.19 or newer according to package `engines`; current [CI](.github/workflows/ci.yml) tests Node.js 26.13.x on Linux and Windows.
- npm.
- Default Sandbox permissions require Windows Sandbox and a supported CLI; see [execution environments](docs/execution-environments.md). Select host read/write explicitly through `/permissions`.
- A configured model provider. The word offline in the build script describes the build step; it does not mean model inference is offline.

### Build from source

In PowerShell 7:

```powershell
git clone https://github.com/dragonbaba/super-pi.git
Set-Location .\super-pi
npm.cmd ci
npm.cmd run build:offline
npm.cmd run superpi -- --help
```

`npm.cmd ci` installs from the lockfile and may require network access and native build prerequisites. Keep the repository `.npmrc`; do not substitute `npm.cmd update`. Once dependencies are installed, `npm.cmd run build:offline` uses the checked-in model data and builds the local package runtimes and resources into `packages/*/dist/`. It enables npm's offline mode for child builds and does not refresh the online model catalog or configure a provider. The CLI's separate `--offline` option disables startup network operations. Neither makes remote model inference local.

The build respects workspace dependencies and runs at most two packages concurrently by default. Use `npm.cmd run build:offline -- --jobs 1` for serial execution or `--list` to inspect the build plan. Existing commands with npm's outer `--offline` flag still work. See the [build guide](docs/building.md) for failure handling and measured results.

Start the interactive application:

```powershell
npm.cmd run superpi
```

The supported source entry is `scripts/superpi.mjs`. It checks the built CLI and passes the repository `.sp` extensions, Skills, and prompt resources to coding-agent. Starting `packages/coding-agent/dist/cli.js` directly skips that resource assembly and is not the default path.

### Rebuild an existing checkout

After updating the source, rebuild from the repository root. If `package-lock.json` changed, run `npm.cmd ci` first to install the matching dependencies. With dependencies already installed:

```powershell
npm.cmd run build:offline
npm.cmd run superpi -- --offline --version
npm.cmd run superpi -- --offline --help
```

The launcher checks that the built CLI exists; it does not rebuild it or check whether it matches newer source. The version command reports the package version, so it alone cannot establish that a particular commit was built. A successful build followed by these CLI checks verifies the local launch path; provider access is configured separately below.

### Configure authentication and a model

After the application starts:

1. Run `/login` and choose a provider and authentication method. API keys can be saved through the interactive flow; OAuth providers use their own flow.
2. Run `/model` and choose a model for the authenticated provider.
3. To list models and check readiness without printing a credential, exit and run (OpenAI is the example provider):

```powershell
npm.cmd run superpi -- --list-models
npm.cmd run superpi -- auth check --provider openai --no-refresh
```

A model can also be selected at startup. Replace `REPLACE_WITH_MODEL_ID_FROM_THE_LIST` with an actual OpenAI model ID from the list before running this example; listing a model does not establish account access to it:

```powershell
$model = "openai/REPLACE_WITH_MODEL_ID_FROM_THE_LIST"
npm.cmd run superpi -- --model "$model"
```

Prefer `/login` for interactive credential entry. An environment variable such as `OPENAI_API_KEY` is also supported, but keep real keys out of shared commands, screenshots, and public logs.

Authentication resolution gives precedence to an explicit `--api-key` for the current invocation, then to a stored provider credential, and only then to environment variables, AWS profiles, ADC, or another provider-owned ambient source. An expired stored OAuth credential is refreshed through that provider's flow; a failed refresh does not silently fall back to another source.

Stored credentials are in `~/.sp/agent/config/auth.json`. The `auth print-api-key` and `auth print-bearer-token` commands output credentials for explicit external-client integration and are not first-login commands; avoid writing their output to logs. `auth check` checks provider readiness and can be told whether to refresh.

Anthropic's retired self-managed subscription OAuth is disabled. Use a supported Anthropic API key or another configured provider; Super Pi does not silently switch billing sources.

### Work in your own project

Start from the target project's directory so session cwd, project trust, `.sp/config`, and project context refer to that project:

```powershell
Set-Location "C:\work\my-project"
node "C:\src\super-pi\scripts\superpi.mjs"
```

Replace `C:\src\super-pi` with your checkout path. The source launcher remains the formal entrypoint.

To expose the checkout as a command, optionally run this from the repository root:

```powershell
npm.cmd link
```

Then:

```powershell
Set-Location "C:\work\my-project"
superpi
```

`npm.cmd link` creates `superpi`. It does not create `pi` or replace PowerShell's `sp` alias. The link depends on the source directory, so moving or deleting the checkout breaks the linked command.

## Core capabilities

### Code tools and project understanding

Ordinary tools run through the built-in `codemode` JavaScript tool by default in the CLI, TUI, JSON/RPC and SDK. No opt-in setting is required. Scripts use `await tools.read({path: "README.md"})`, `await callTool(name, args)` and `await show(result.ref)`; native interaction and Plan/Goal controls remain direct tools. Unsupported grammar formats use a JSON `code` parameter with the same runtime. Tool allowlists, Plan mode, authorization and cancellation still apply to every child call; `--no-tools` disables tools.

Codemode loads its isolated QuickJS Worker on first use and bounds execution, bridge traffic, state and output. Shown native reads can authorize guarded edits only on a later model turn; hidden reads, printed copies and truncated content do not. A failed child keeps its parent failed, even if the script catches the error. Successful branch-local `store` writes persist without replaying scripts; external tool effects are never rolled back. Batch related operations to amortize Worker startup. See [the usage guide](docs/codemode.md), [the default Codemode contract](docs/codemode-default-execution-plan.md) and [validation evidence](docs/codemode-default-execution-log.md).

The coding agent includes `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and, on Windows, `powershell` tools. Individual tools have their own read windows and byte/line limits; TUI folding controls what is visible on screen. These do not imply a model token budget. The separate `toolResultPresentation` pipeline requires `enabled: true`; model token-budget projection also requires a positive integer `budgetTokens`, which has no production default. Larger output can be kept in a local artifact and opened when supported. See [tool-result presentation](docs/performance/phase5b-budgeted-model-view.md) for the configuration and boundaries.

Project understanding is layered:

- Project Context uses `/project-status`, `/project-init`, and `/project-refresh` for project rules, a lightweight repository index, and context state.
- CodeGraph uses `/codegraph-status`, `/codegraph-init`, and `/codegraph-sync` explicitly. It requires a trusted project and does not fully scan every repository at startup.
- LSP tools need configured servers and provide targeted diagnostics, source-fix previews, and symbol navigation. The repository's own typecheck, build, and test remain the final authority.

File editing uses scoped reads and identity checks. Snapshots, line anchors, and batch edits help keep a change bounded; they are not arbitrary multi-file transactions or a semantic-correctness guarantee. Every write still goes through the normal permission and result checks.

### Session background tasks

In host TUI/RPC sessions, Bash and PowerShell can use `background: true` with an explicit `cwd`; the Sandbox modes currently run foreground commands only. The model sees effective capacity before submission; `/tasks` and the direct `tasks` tool manage shell and subagent work together. Shell defaults are 16 running and 64 admitted commands, configurable up to 64/256. Commands keep normal authorization, bounded results and completion notifications, and stop on session shutdown. Persistent sessions restore bounded historical results after restart; missing completion is marked interrupted, without replaying work or restoring permissions. See [background task usage and limits](docs/background-tasks.md).

### Goal, Plan, sessions, and memory

- Plan mode starts with `/plan` or `--plan` and emphasizes read-only exploration, clarification, and a complete implementation plan. It narrows the available tools until the plan is accepted.
- Goal mode uses `/goal` to manage a continuing objective, pause, resume, and completion state. Ordered Goal queues and managed-run RPC are experimental and off by default.
- Sessions support continue, resume, fork, tree navigation, naming, import, and export. Session history is local durable data; each model request still receives only the context selected for that request.
- Memory separates global memory, project memory, session search, and Skills. It provides a human-reviewed extraction workflow through `/memory-review`. Ordinary memory tool operations follow content checks and the current tool policy; the confirmation flow depends on the entrypoint. Startup does not inject every historical memory into the system prompt.

Compaction organizes older context when the active model approaches its limit. It preserves a usable continuation boundary, but does not preserve every internal model state or promise identical behavior across providers.

The provider-native `openai-server-compaction` extension defaults `enabled` to `true`. When loaded, it operates according to its configuration, model compatibility, and trigger conditions. To disable it explicitly, set `enabled: false` in `~/.sp/agent/config/openai-server-compaction.json` or set `SP_OPENAI_SERVER_COMPACTION_ENABLED=false` (the environment variable takes precedence). See the [configuration source](packages/openai-server-compaction/src/config.ts). Remote compaction may create extra requests and cost; Auxiliary Vision is a separate integration that needs its own configuration.

### Models, extensions, Skills, and MCP

Super Pi uses the `@super-pi` package scope and the `superpi` CLI. The AI layer includes built-in providers and model catalogs, and `models.json` can define custom providers or model overrides. A model is usable only when its catalog entry, authentication, provider settings, and tool/image/reasoning capabilities permit it.

The source launcher loads repository-provided extensions, Skills, and prompt templates from `.sp/config/settings.json`. You can also use `superpi install`, `superpi list`, `superpi config`, `superpi remove`, and `superpi update` to manage resources. Extensions can add tools, commands, providers, or UI; project-local resources are subject to project trust.

MCP is an explicit integration. Configure a trusted server in `~/.sp/agent/config/mcp.json`, then use `/mcp-status`, `/mcp-tools`, and `/mcp-reload` as needed. Discovery, connection, and tool calls can add startup time, network transfer, and provider cost. Model token-budget projection of MCP results has the same explicit `toolResultPresentation` enablement and `budgetTokens` requirements described above; it is not a default for every remote result. Failed calls are not automatically replayed.

### Questions, permissions, and failure recovery

When the model needs a decision about material ambiguity, conflicting requirements, or a preference that cannot be inferred, it should call `ask_user`. The tool displays the question and waits for an explicit option or text answer; dependent business calls do not start before the answer. A prose question such as “please confirm” does not create the same boundary, and a disabled tool or unavailable UI does not count as an answer. An answer is not file, Shell, or external-service permission.

Start with `superpi` and use `/permissions` to select read-only in Windows Sandbox, Sandbox read/write (default), or full host read/write. Both of the first two modes execute file and command tools inside the VM; only the third uses host tools, after explicit confirmation. Switching preserves the conversation and drains the previous runtime. See [permissions and execution limits](docs/execution-environments.md) for workspace snapshots, writeback, supported tools and migration. Project extensions and provider code still run in the host application.

A long `node -e` script is not rejected merely because of its length. A one-off script that can be passed reliably can run directly; complex quoting, repeated maintenance, or multi-part scripts may be clearer as an explicit file or supported stdin input. Writing a file is not a way around authorization: the file write and the execution still have their own checks.

### Images and terminal modes

Images first enter an input draft and become part of the model request only after submission. If the active model accepts images, Super Pi can send them according to provider capability. For a text-only model, optional Auxiliary Vision can ask a configured vision-capable model for a description. Auxiliary Vision needs its own model and credentials and may create an additional service call.

Regular mode is suited to preserving terminal history; fullscreen mode provides a more focused workspace. Both share session, tool, and permission boundaries. `--mode json` supports non-interactive output and `--mode rpc` targets embedded hosts; the RPC protocol, client, and server packages are experimental, and the server package does not provide a standalone coding-agent service. Ordinary path paste, internal text selection, and image drafts are separate inputs; the project does not promise native Explorer file-drop handling.

Scrolling up in fullscreen mode shows `↓ Back to bottom · Esc`. Click it or press Escape to follow new output again while preserving the input draft. Exiting restores the pre-session terminal and leaves only a resume hint by default; select `fullscreenExitOutput: "transcript"` in `/settings` to explicitly reprint the session.

## Configuration and data

| Location | Purpose |
| --- | --- |
| `~/.sp/agent/config/settings.json` | Global tools, UI, resource, and runtime settings |
| `~/.sp/agent/config/auth.json` | Stored provider API-key and OAuth credentials; never commit |
| `~/.sp/agent/config/models.json` | Custom providers, model catalogs, and capability overrides |
| `~/.sp/agent/config/mcp.json` | Global MCP server configuration |
| `~/.sp/agent/` | Sessions, memory, caches, model catalog state, and other runtime data |
| `<project>/.sp/config/` | Trusted project settings and extension configuration |
| `<project>/.sp/extensions/`, `<project>/.sp/skills/`, `<project>/.sp/prompts/` | Project-local resources, subject to trust and startup flags |

`SP_CODING_AGENT_DIR` changes the global agent data root, and `SP_CODING_AGENT_SESSION_DIR` changes the session root. Do not commit `auth.json`, session JSONL, MCP headers, or model request content.

Resource management commands:

```powershell
npm.cmd run superpi -- list
npm.cmd run superpi -- config
npm.cmd run superpi -- config --local
```

`config --local` edits the current project's resource settings. Project-local resources still need a clear trust decision. `--no-extensions`, `--no-skills`, `--no-context-files`, `--no-tools`, `--tools`, and `--exclude-tools` can narrow one run without changing global authorization.

## Context efficiency and performance design

Super Pi's performance work uses explicit boundaries:

- Streaming updates, tool progress, and interactive events use bounded queues, backpressure, or coalescing instead of unbounded Promise accumulation.
- Presentation caches invalidate on meaningful changes; owners release their references on session switch, cancellation, and dispose.
- Tool read windows, byte/line limits, and TUI folding serve different purposes. Model token-budget projection requires explicitly enabled `toolResultPresentation` and a positive integer `budgetTokens`; artifact/continuation paths are available where supported.
- Frequent syntax checks use top-level fixed regex modules and existing parse facts; hot-path gates prevent accidental extra scans.
- Cancellation, timeout, and failure paths preserve actual execution state instead of rewriting unknown side effects as “not executed”.

These are design and maintenance constraints, not an all-path zero-allocation, fixed-frame-latency, or never-leaks promise. Before changing provider streaming, tools, TUI, terminal frames, or large-result processing, read the [hot-path allocation contract](docs/performance/hot-path-allocation-contract.md) and provide reproducible evidence.

The home page does not present isolated microbenchmark numbers. Heap delta, sampled allocation, token estimation, and provider billing are different measurements.

The footer's `CH%` uses the latest assistant response's reported cache reads divided by its normalized prompt tokens; `/session` uses cumulative token-weighted usage. Missing provider cache reports cannot establish the actual server hit rate. Optional **Cache overlap estimates** (`showCacheMissNotices`, off by default) show length-only upper bounds, with repeated content and cache causes explicitly unknown. They do not infer expiry or money saved.

## Security, privacy, and known boundaries

Configuration, sessions, and some memory are stored locally, but that does not mean input always stays on the machine. Prompts, tool schemas, file excerpts, tool results, and images may be sent to the selected provider; configured MCP servers receive the calls and data sent to them. Review provider, MCP, extension, and environment trust before use.

Permission rules and project trust are application controls. The first two permission modes additionally isolate supported file and command tools in Windows Sandbox. Host read/write retains explicit denials, file-version checks and protected metadata checks; it does not restore old `full-access` grants. “Not executed” means a trusted pre-execution refusal; a backend failure after start must be understood from its actual result.

Compaction reduces direct visibility of some older history. Memory, Project Context, and CodeGraph each have their own bounds and activation conditions; none promises to understand an entire repository automatically or remember every session forever. Auxiliary Vision needs separate configuration. Provider-native compaction follows the extension's configuration and compatibility conditions, with `enabled` defaulting to `true` as described above. Both can create extra service calls and cost.

## Documentation, development, and contribution

- [Documentation index](docs/README.md): task-oriented links for users and contributors.
- [Model capability reference](docs/model-capabilities.md): model input, tools, reasoning, context, and provider capabilities.
- [Coding-agent notes](packages/coding-agent/README.md): fullscreen behavior, PowerShell, and runtime details.
- [AI/provider API](packages/ai/README.md): providers, models, auth, tools, and images.
- [NOTICE.md](NOTICE.md): provenance, authors, and license notices.

Common source checks:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build:offline
npm.cmd test
```

`npm test` includes the unit, hot-path invariant and provider-contract suites plus the memory workspace once. `test:unit`, `test:hot` and `test:contract` select subsets for focused work; they are not extra gates before the full suite. The runner logs each file's start, exit and wall time, gives each child an isolated offline HOME/agent/session environment, and enables GC for the ownership regressions that require it. See [test execution and optional measurements](docs/testing.md) for the boundary between regression coverage and benchmarks.

Development scratch files belong under `.task-tmp/<task-id>/`: logs, temporary fixtures, caches and resource manifests. Preserve acceptance evidence in `docs/` or `docs/evidence/`, then remove a task's recorded scratch files after its processes and handles have closed. Check for active tasks before emptying the shared directory. Deleting completed scratch data does not remove `packages/*/dist/`, installed dependencies in `node_modules/`, or runtime data in `~/.sp/agent/`; later tasks recreate their own temporary directories. See [AGENTS.md](AGENTS.md) for ownership and cleanup rules.

For documentation, start with Markdown, links, commands, and fact checks. For production changes, select tests by impact. Read the performance contract before changing a hot path; a single timing or heap number is not lifecycle evidence.

## Upstream relationship and versions

Super Pi was originally derived from [Pi](https://github.com/earendil-works/pi) v0.84.1. It is maintained independently with the `@super-pi` package scope, `superpi` command, and `.sp` data directory. It is not an official Pi distribution and does not inherit the upstream release channel. See [NOTICE.md](NOTICE.md).

Super Pi core packages are currently **1.0.0**, with independent versioning. The selected [Pi 1.5.0 implementation](docs/upstream-pi-1.5.0-implementation-plan.md) and the subsequent [H00–H10 history follow-up](docs/upstream-pi-history-followup-plan.md) have been merged as of **2026-11-04**. The follow-up records the individual PRs, review and CI results, performance evidence, and cleanup status.

The [Pi 1.5.0 assessment](docs/upstream-pi-1.5.0-diff-assessment.md) is a fixed historical comparison, not a continuously updated upstream release tracker. The history inventory's 1,150 source records do not represent 1,150 fixed defects or a complete semantic audit. V01–V04 and other unverified entries remain open; feature candidates require separate product decisions. Paid background cache warming remains off by default.

## License and responsible use

This revision is licensed under **[GNU GPL v3.0 only](LICENSE)** (`GPL-3.0-only`). Distribution of covered modified versions or binaries must satisfy the applicable license, notice, and Corresponding Source obligations. Proprietary redistribution that withholds required source or recipients' GPL rights is not permitted.

The project opposes unlawful use, unauthorized access, infringement, and other abuse. This is a project position, not an additional GPL field-of-use restriction. GPL permits commercial use; private modifications, internal use, and merely operating a network service do not automatically require public source disclosure. Using Super Pi to write your own project does not by itself change that project's license.

The change does not revoke earlier MIT grants. Upstream MIT portions and their copyright notices are retained. See [NOTICE.md](NOTICE.md) for scope, distribution guidance, provenance, and reporting. Before contributing, read [AGENTS.md](AGENTS.md), the relevant package notes, and the performance contract.
