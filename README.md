# Super Pi

An extensible terminal AI coding assistant for real engineering work, focused on controlled execution, continuing project context, and long-session terminal workflows.

[简体中文](README.zh-CN.md) · [Documentation index](docs/README.md)

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

These capabilities still depend on the provider, model capabilities, project configuration, and active tool policy. They are application controls, not an operating-system sandbox or a guarantee about any model output or external service.

## Core capabilities

### Code tools and project understanding

The coding agent includes `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and, on Windows, `powershell` tools. Individual tools have their own read windows and byte/line limits; TUI folding controls what is visible on screen. These do not imply a model token budget. The separate `toolResultPresentation` pipeline requires `enabled: true`; model token-budget projection also requires a positive integer `budgetTokens`, which has no production default. Larger output can be kept in a local artifact and opened when supported. See [tool-result presentation](docs/performance/phase5b-budgeted-model-view.md) for the configuration and boundaries.

Project understanding is layered:

- Project Context uses `/project-status`, `/project-init`, and `/project-refresh` for project rules, a lightweight repository index, and context state.
- CodeGraph uses `/codegraph-status`, `/codegraph-init`, and `/codegraph-sync` explicitly. It requires a trusted project and does not fully scan every repository at startup.
- LSP tools need configured servers and provide targeted diagnostics, source-fix previews, and symbol navigation. The repository's own typecheck, build, and test remain the final authority.

File editing uses scoped reads and identity checks. Snapshots, line anchors, and batch edits help keep a change bounded; they are not arbitrary multi-file transactions or a semantic-correctness guarantee. Every write still goes through the normal permission and result checks.

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

Permission checks combine tool policy, project trust, paths, and operation checks. `full-access` changes the authorization scope, but it does not make uninspectable Shell syntax pass automatically; the policy is not an operating-system sandbox. Treat project extensions, MCP servers, Shell commands, and model-generated edits as inputs to review.

A long `node -e` script is not rejected merely because of its length. A one-off script that can be passed reliably can run directly; complex quoting, repeated maintenance, or multi-part scripts may be clearer as an explicit file or supported stdin input. Writing a file is not a way around authorization: the file write and the execution still have their own checks.

### Images and terminal modes

Images first enter an input draft and become part of the model request only after submission. If the active model accepts images, Super Pi can send them according to provider capability. For a text-only model, optional Auxiliary Vision can ask a configured vision-capable model for a description. Auxiliary Vision needs its own model and credentials and may create an additional service call.

Regular mode is suited to preserving terminal history; fullscreen mode provides a more focused workspace. Both share session, tool, and permission boundaries. `--mode json` supports non-interactive output and `--mode rpc` targets embedded hosts; the RPC protocol, client, and server packages are experimental, and the server package does not provide a standalone coding-agent service. Ordinary path paste, internal text selection, and image drafts are separate inputs; the project does not promise native Explorer file-drop handling.

## Quick start

### Requirements

- Node.js 22.19 or newer.
- npm.
- A configured model provider. The word offline in the build script describes the build step; it does not mean model inference is offline.

### Build from source

In PowerShell:

```powershell
git clone https://github.com/dragonbaba/super-pi.git
Set-Location .\super-pi
npm.cmd ci
npm.cmd run build:offline
npm.cmd run superpi -- --help
```

`npm.cmd ci` installs from the lockfile. Keep the repository `.npmrc` and native dependency requirements; do not substitute `npm.cmd update`. `npm.cmd run build:offline` builds the repository runtime and resources. It does not configure a provider or prevent later model network requests. The CLI option `--offline` is separate: it disables startup network operations, but it does not turn a remote provider into a local model.

Start the interactive application:

```powershell
npm.cmd run superpi
```

The supported source entry is `scripts/superpi.mjs`. It checks the built CLI and passes the repository `.sp` extensions, Skills, and prompt resources to coding-agent. Starting `packages/coding-agent/dist/cli.js` directly skips that resource assembly and is not the default path.

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

## Security, privacy, and known boundaries

Configuration, sessions, and some memory are stored locally, but that does not mean input always stays on the machine. Prompts, tool schemas, file excerpts, tool results, and images may be sent to the selected provider; configured MCP servers receive the calls and data sent to them. Review provider, MCP, extension, and environment trust before use.

Permission and project trust are application controls. They do not replace operating-system accounts, containers, network isolation, or human review. `full-access` is not “skip checks”; unsupported Shell wrapper syntax can still be rejected. “Not executed” means a trusted pre-execution refusal; a backend failure after start must be understood from its actual result.

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
npm.cmd run test:hot
npm.cmd test
```

For documentation, start with Markdown, links, commands, and fact checks. For production changes, select tests by impact. Read the performance contract before changing a hot path; a single timing or heap number is not lifecycle evidence.

## Upstream relationship, roadmap, and license

Super Pi was initially derived from [Pi](https://github.com/earendil-works/pi) v0.84.1. It is independently maintained here with the `@super-pi` package scope, the `superpi` command, and the `.sp` data root. It is not an official Pi distribution and does not inherit the upstream release channel; see [NOTICE.md](NOTICE.md) for attribution.

The Pi v0.86.1 difference assessment is recorded, but it is not an overall upgrade. EventStream two-stack FIFO, provider-aware overflow classification, virtual-module lazy loading, and fuzzy-search progression are future independent slices, not current shipped performance results. No background paid cache-warming request is part of the default.

The project follows the [MIT License](LICENSE). Before contributing, read [AGENTS.md](AGENTS.md), the relevant package notes, and the performance contract.
