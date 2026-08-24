# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Status-only progress**: See whether each subagent is waiting, working, completed, or failed without exposing delegated task text or child output
- **Parallel streaming**: All parallel task states update simultaneously
- **Elapsed-time tracking**: Shows final runtime and passively refreshes running elapsed time whenever the parent UI already renders, without owning a repaint timer
- **Usage tracking**: Shows model, turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

Copy this extension directory into `~/.super-pi/agent/extensions/subagent`. Copy any agent definitions you want to use into `~/.super-pi/agent/agents` and workflow prompts into `~/.super-pi/agent/prompts`.

Do not symlink agent definitions from repositories or other untrusted locations. Discovery canonicalizes each definition and rejects links outside the configured agent directory.

## Security Model

This tool executes a separate `pi` subprocess with a delegated role prompt/tool policy and a separately resolved provider/model route.

**Project-local agents** (`.super-pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.super-pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

Project scope is accepted only when Pi reports `ctx.isProjectTrusted()`. This check happens **before** project agent discovery, and `confirmProjectAgents: false` never bypasses it. Interactive runs additionally confirm requested project agents by default. Headless JSON/print runs default-deny project scope because they cannot confirm; trusted automation must explicitly set `confirmProjectAgents: false`.

Each child starts with extensions, skills, templates, and session persistence disabled. A dedicated `child-guard.ts` is loaded explicitly. Security controls include:

- every single/parallel/chain task requires a deeply frozen, non-enumerable, one-call grant from the Session permission controller; the task `cwd`, originating tool-call ID, and filesystem device/inode identity must all match immediately before launch. Primary and identity-valid added workspaces are supported, while `full-access` delegates only the explicitly requested exact cwd rather than ambient filesystem access;
- child environment uses a small runtime allowlist, resolved provider-scoped auth variables only, and `SP_CODING_AGENT_DIR` so custom Pi auth storage still works; arbitrary parent variables and session metadata are not inherited;
- all built-in file tools are limited to the assigned workspace and block `.env`, Pi auth storage, private keys, browser profiles, and common SSH/cloud credential directories (safe templates such as `.env.example` remain readable);
- agents without a `tools` declaration receive only `read, grep, find, ls`; a parent `read-only` grant or explicit task `readOnly: true` strips `write`, `edit`, and `bash`, project agents can never receive Bash, and a user agent must explicitly list `bash`;
- user-agent Bash is a **trusted capability** and is enabled only by an explicit `bash` entry in that user-owned agent's `tools`; it is conservatively checked for obvious credential reads, environment enumeration, workspace-changing commands, out-of-workspace writes, and detached/background or persistent process launch forms;
- Windows termination synchronously waits for the absolute System32 `taskkill.exe /T /F`; Unix children run in a process group and the complete group receives TERM/KILL; each launched task has an independent runtime limit (default 30 minutes, hard maximum 2 hours via `timeoutMs`), so queue time does not consume another task's budget;
- stderr, individual JSON lines, raw JSON transport bytes/events, retained completion events, messages/details, chain handoff text, and model-visible per-task output have independent hard bounds; high-frequency incremental events no longer consume the retained-event budget, and oversized assistant events retain bounded final-text head/tail while discarding large traces/details.
- credential-path checks canonicalize Windows AppData roots before comparison, and recursive traversal is streamed through directory handles with hard directory, entry, and depth limits rather than allocating whole directory trees.
- a partially successful parallel batch returns completed sibling outputs plus bounded failure summaries so successful work is reusable; an all-failed or externally aborted batch still fails.

Bash filtering is **not** an OS sandbox or a complete shell parser. It blocks common detached launch forms but cannot prove that arbitrary programs or scripts will not spawn descendants. Bash is therefore disabled for repo-controlled project agents rather than presented as isolation, and defaults off for user agents too. Adding `bash` is an explicit opt-in for trusted definitions. Provider authentication variables required by Pi may exist in the child environment and shell syntax can read them despite filtering; use a VM/container for hostile code.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```text
Run 2 scouts in parallel: one to find models, one to find providers
```

For multiple audits in the same cwd, set `readOnly: true` on each task explicitly:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Audit models; do not modify files.", "readOnly": true },
    { "agent": "reviewer", "task": "Review provider risks; do not modify files.", "readOnly": true }
  ]
}
```

Task prose does not change capabilities; `readOnly` is the formal permission downgrade.

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**All views**:
- Batch completion counts plus waiting/working/failed counts
- Per-agent status icon (○/⏳/✓/✗), role name, and elapsed runtime
- Model and usage stats: `model: provider/model · 3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens`
- No delegated task text, child tool calls, child output, or raw timeout/error body; Ctrl+O does not reveal them

**Parallel mode streaming**:
- Shows every agent with live status (○ waiting, ⏳ working, ✓ completed, ✗ failed)
- Updates as each task makes progress
- Shows compact completion, working, waiting, and failure counts
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Bounds retained task/details data and throws structured Pi tool errors for validation, trust, cancellation, and child failures
- Preserves bounded stderr/startup diagnostics internally for parent-model error handling, but never renders those bodies in the user-facing status card
- Keeps repaint work bounded: result states are counted in one pass and status strings are built directly without per-repaint collection arrays; running elapsed text passively updates only during already-requested parent UI renders and never starts a periodic invalidation timer

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.super-pi/agent/agents/*.md` - User-level (always loaded)
- `.super-pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`. Project-agent prompts remain bound to the trusted primary project and cannot be delegated to an additional or `full-access-exact` workspace; user-level agents can use those explicitly granted roots.

Definitions are fail-closed: files/prompts are capped at 128 KiB; `name` is 1–64 safe identifier characters; `description` is 1–500 characters; `tools` is parsed in one bounded pass as at most 32 comma-separated safe tool identifiers. Empty segments and invalid definitions are rejected, and agent-file symlinks escaping their canonical agent directory are ignored. Legacy `model` frontmatter is role-inert: it is ignored rather than used as execution configuration.

## Provider/model assignments

Role definitions and execution routes are deliberately separate. Use `/subagent-model` to inspect or change the persistent routes stored in `~/.super-pi/agent/subagent-models.json`:

```text
/subagent-model
/subagent-model list
/subagent-model set <agent> <provider> <model> [off|minimal|low|medium|high|xhigh|max]
/subagent-model clear <agent>
/subagent-model clear-all
```

With UI, `/subagent-model` opens one continuous role → provider → model → supported thinking-level picker; cancelling any stage leaves the file unchanged. In headless mode it falls back to the bounded list output. Use `/subagent-model list` for explicit non-interactive inspection.

Assignments use an exact provider/model pair already known to Pi's model registry. The optional thinking level is independent. An unassigned role inherits the parent session's exact provider, model, and thinking level. Provider definitions and credentials remain owned by Pi's normal model/provider configuration; this file stores routes only. Writes are bounded, deterministic, same-directory atomic replacements. Assignment keys are role names, so a project role overriding a user role with the same name uses the same route.

## Sample Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| `scout` | Fast codebase recon | read, grep, find, ls, bash |
| `planner` | Implementation plans | read, grep, find, ls |
| `reviewer` | Code review | read, grep, find, ls, bash |
| `worker` | General-purpose | Explicitly declared tools; omitted `tools` means read-only discovery tools |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: `execute` throws with bounded stderr/output (Pi marks the tool result `isError: true`)
- **stopReason "error"**: LLM error is thrown with its message
- **stopReason "aborted"**: Ctrl+C terminates the process tree and throws
- **Chain mode**: Stops and throws at the first failing step
- **Parallel mode**: Completes scheduled tasks, then throws a bounded aggregate if any failed

## Limitations

- Parallel model-visible output is capped at 50 KB per task; retained details are independently bounded
- Agents and model assignments are loaded fresh on each invocation (allows editing without another reload after the command is registered)
- Parallel mode limited to 8 tasks, 4 concurrent; mutation-capable siblings cannot share one cwd. Use `readOnly: true` for same-cwd audit tasks or chain/sequential execution for writers
- Execution is foreground-only: there is no detached/background task API, so the 2-hour hard runtime maximum is intentional
- Child guard rules are policy checks, not an operating-system security boundary

## Verification

```bash
npm test       # runnable path/environment/Bash security regression tests
npm run check  # strict TypeScript check; expected: 0 diagnostics
```

The included `tsconfig.json` resolves the installed Pi 0.84 type declarations in this Windows installation.
