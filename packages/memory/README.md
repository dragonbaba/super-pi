<div align="center">

![Pi Hermes Memory](docs/images/pi_memory.png)

# 🧠 Pi Hermes Memory

**Persistent memory + session search + secret scanning for Pi**

---

</div>

Your Pi agent normally forgets everything when you close a session. **This extension fixes that.**

- 🔍 **Search conversation history** — bounded direct JSONL search returns source line ranges
- 🧠 **Persistent memory** — facts, preferences, corrections survive across sessions
- ⚠️ **Learns from failures** — remembers what didn't work so you don't repeat mistakes
- 🏷️ **Categorized memories** — failures, corrections, insights, conventions, and tool quirks organized for fast retrieval
- 🛡️ **Secret scanning** — API keys and tokens are blocked from being saved
- 📚 **Procedural skills** — the agent saves *how* it solved problems, not just what
- ✅ **Reviewed extraction** — current model proposes durable memory; you approve the final result
- ⚡ **Fast lifecycle** — no startup sweep/backfill or shutdown model/index work

## Quick Start

```bash
# Install
pi install npm:@super-pi/memory

# Open the memory management menu
/memory
```

Use **同步搜索索引** to reconcile current Markdown into search, a **整理…** action to review the current conversation, or **清理恢复产物** for confirmed artifact cleanup. Arrows elsewhere in this document describe menu navigation, not command arguments.

**批量清理记忆** opens a list for user preferences, global/current-project memory or corrections, or all canonical projects. Choose all entries, an age in days since modification, or expired temporary failures; these choices only preselect rows. Space toggles rows and Delete opens a confirmation with entry/file/character totals. Unknown dates remain manually selectable, and durable corrections are excluded from the temporary-failure preset. Nothing is deleted without the interactive terminal and final confirmation.

The all-projects scan skips a project directory that disappears after enumeration and continues with the remaining projects. Other directory inspection errors are reported rather than silently omitted.

Cleanup removes selected raw fragments without trimming, deduplicating or rewriting unselected bytes. A changed file is skipped as a whole. All-project cleanup includes hashed project identities even when their original root is gone, excludes linked files/directories and reports excluded legacy directories. Markdown deletion survives search-index failure; the report warns that search may remain stale and points to **同步搜索索引**. The current session's startup digest stays frozen. Existing checked publication/recovery behavior remains; this feature creates no recycle directory or second canonical index.

## Upgrade Notes

`/memory` replaces standalone maintenance commands. Legacy root, project, database, and flat-skill migrations are retired; old files and backups are retained. See the storage section for manual recovery requirements when upgrading from an unfinished old migration.

## Features

| Feature | What happens |
|---|---|
| 🔍 **Session Search** | Search session JSONL directly with bounded scanning and source line ranges |
| 🧠 **Persistent Memory** | Facts, preferences, lessons saved to markdown files |
| 🔄 **Memory Search Sync** | Successful Markdown memory writes are mirrored into SQLite for `memory_search` |
| ⚠️ **Failure Memory** | Learn from failures — stores what didn't work and why |
| 📚 **Procedural Skills** | The agent saves *how* it solved problems as reusable docs |
| ✅ **Reviewed Memory Extraction** | `/memory → 整理记忆` uses the current model, previews the full result, and writes only after approval |
| 🧹 **Explicit Artifact Cleanup** | `/memory → 清理恢复产物` runs bounded identity-safe cleanup only when requested |
| 🗑️ **Selected Memory Cleanup** | `/memory → 批量清理记忆` preserves unselected bytes and rechecks whole-file fingerprints before deletion |
| ⚡ **Fast Lifecycle** | Startup loads active memory only; shutdown closes owned resources only |
| 🛡️ **Secret Scanning** | API keys, tokens, SSH keys blocked from persistence |
| 📊 **Memory Dates** | Creation/reference dates help review; they do not prove a fact is still valid |
| 🏗️ **Two-Tier Memory** | Global + per-project memory, both searchable |
| 💾 **Extended Store** | Unlimited searchable memories beyond core 5,000-char limit |

## How It Works

### Session Lifecycle

![Session Lifecycle](docs/images/session-lifecycle.svg)

### Memory + Skills Architecture

The extension manages three types of knowledge:

| Type | What | Storage | Token cost |
|---|---|---|---|
| **Memory** (MEMORY.md) | Tagged cross-project notes — attention, avoid, lesson, skill-route, environment | 5,000 chars max | Searchable by default |
| **User Profile** (USER.md) | Who you are — name, preferences, communication style | 5,000 chars max | Searchable by default |
| **Skills** (Pi-native `SKILL.md`) | Procedures — *how* to do something, reusable across sessions | Unlimited | Discoverable by Pi + manageable via the `skill_manage` tool |

![Memory + Skills Architecture](docs/images/memory-architecture.svg)

### Security: Content Scanning

Every write — memory and skills — passes through a scanner before being accepted. This prevents the LLM from being tricked into storing malicious content that could later be surfaced through search or legacy prompt injection.

![Security: Content Scanning](docs/images/security-flow.svg)

## Development

`npm run check` and `npm test` only work from a **full git checkout** after `npm install`. The published npm package intentionally omits `tests/`, TypeScript, and `tsconfig.json` (production install for Pi). Validate from source or rely on CI before publish.

```bash
git clone https://github.com/chandra447/@super-pi/memory.git
cd @super-pi/memory
npm install
npm run check
npm test
```

## Installation

```bash
pi install npm:@super-pi/memory
```

Or install from GitHub:

```bash
pi install git:github:chandra447/@super-pi/memory
```

Or test locally without installing:

```bash
superpi -e ./packages/memory/src/index.ts
```

### Homebrew / Node ABI mismatches

`better-sqlite3` is a native addon used by `memory_search` and memory indexing. If Pi is installed via Homebrew and the extension was compiled for a different Node ABI, those operations may warn:

```text
was compiled against a different Node.js version using NODE_MODULE_VERSION ...
```

The extension attempts one automatic `npm rebuild better-sqlite3` against the Node that is running Pi. If that still fails:

```bash
cd ~/.sp/agent/npm/node_modules/better-sqlite3
npm rebuild better-sqlite3
```

Or install Pi with npm so the host runtime and extension install share one Node toolchain.

## Two-Tier Memory Architecture

The extension stores memory at two levels:

| Tier | Location | What goes here | Available when |
|---|---|---|---|
| **Global** | `~/.sp/agent/@super-pi/memory/` | Facts that apply everywhere — your name, preferences, OS, tools | Searchable via `memory_search` |
| **Project** | `~/.sp/agent/projects-memory/<project>/` | Facts scoped to one codebase — architecture decisions, API quirks, team norms | Searchable when cwd matches the project |

By default (`"memoryMode": "digest"`) the system prompt carries only a constant `<memory-policy>`: when to save (user corrections and preferences, fixes after failed attempts, project decisions not recorded in the repo), when to search, and what never to save. Its bytes do not depend on saved memory, so the provider prompt-cache prefix stays valid across sessions.

Saved memory reaches the model as one hidden `<memory-context>` digest message (at most 2,000 characters). User, global, current-project, and scoped failure/correction sources share the budget in round-robin order. Multiline conditions are collapsed into one bounded line; use `memory` with `action: "list"` for full current entries. The digest is built once at session start and sent with the first prompt of a session context. Later turns and resumes replay the same bytes; it is sent again only after compaction or tree navigation removes it.

Project identities combine the canonical repository root with its basename. Subdirectories and linked worktrees share the repository identity; unrelated same-name repositories are isolated. Legacy import and automatic directory migrations are retired. Old basename directories, flat skill files, and backups remain untouched and are not assigned to a project. Recover old data manually only after verifying ownership and relevance; preserve original entry dates. Moving a repository changes its identity and does not automatically adopt an old directory.

`memory_search` defaults to global plus current-project entries. `project: null` selects global only; an exact project identity selects that project; `project: "*"` explicitly searches all scopes, including retained legacy records. Keyword matches are not a complete inventory. `memory` `action: "list"` reads canonical Markdown, reports total/offset/nextOffset, and supports explicit global/project failure scope. The existing session digest remains frozen after edits.

```
System Prompt (constant)            First prompt of a session context
┌──────────────────────────────┐    ┌──────────────────────────────────┐
│ <memory-policy>              │    │ user message                     │
│ save on correction/failure/  │    │ <memory-context> (hidden)        │
│ decision; retrieve only      │    │ User / Global / Project / fixes  │
│ when needed and permitted    │    │ </memory-context>                │
│ </memory-policy>             │    └──────────────────────────────────┘
└──────────────────────────────┘
```

Set `"memoryMode": "policy-only"` to send the policy without the digest. Set `"memoryPolicyStyle"` to `"full"`, `"compact"`, `"custom"`, or `"none"` to choose policy verbosity. Set `"memoryMode": "legacy-inject"` to restore the old behavior that injects MEMORY.md, USER.md, project memory, and recent failures into the prompt.

## Failure Memory

The agent learns from failures, corrections, and insights — just like humans do.

### Memory Categories

| Category | What it stores | Example |
|---|---|---|
| `failure` | What didn't work and why | "Tried localStorage for tokens — XSS vulnerability" |
| `correction` | User corrections | "Use pnpm, not npm" |
| `insight` | Learnings from experience | "Auth0 SDK handles refresh tokens automatically" |
| `preference` | User preferences | "Prefers dark theme" |
| `convention` | Project conventions | "Monorepo uses turborepo" |
| `tool-quirk` | Tool-specific knowledge | "CI needs --frozen-lockfile" |

### How It Works

1. **Trigger-based saving**: The memory policy tells the agent to save a `failure`/`correction` entry when you correct it or when a fix follows a failed attempt
2. **Session digest**: Current-project and global failures share the configured entry budget; durable `[correction]` entries remain eligible after the temporary-failure age window (`failureInjection*` settings)
3. **Reviewed extraction**: `/memory → 整理记忆` proposes entries from the current conversation; nothing is extracted in the background
4. **Searchable**: Use `memory_search("auth", category: "failure")` to find past failures

### Example

```
User: No, use pnpm not npm
Agent: [saves correction memory]

Next session:
Agent: "I remember you prefer pnpm over npm. Let me use that."
```

The agent learns from its mistakes so you don't have to repeat yourself.

Memory blocks are wrapped in `<memory-context>` XML tags with a guard note ("NOT new user input") to prevent the LLM from treating stored facts as instructions.

## Usage

Once installed, the extension works automatically for durable memory. Skills are available through the `skill_manage` tool during normal work when the agent decides a reusable procedure is worth saving.

### The `memory` Tool

The agent gets a `memory` tool it can call proactively:

| Action | Target | What it does |
|---|---|---|
| `add` | `memory` or `user` | Append a new entry |
| `replace` | `memory` or `user` | Update an existing entry (matched by substring) |
| `remove` | `memory` or `user` | Delete an entry (matched by substring) |

### The `skill_manage` Tool

The agent also gets a `skill_manage` tool for saving reusable procedures. The explicit name is intentional: it manages saved procedures and avoids being mistaken for generic skill discovery.

| Action | What it does |
|---|---|
| `create` | Save a new skill (name, description, step-by-step body, required `scope`) |
| `view` | Read a skill's full content by `skill_id`, or list all skills if no id is given |
| `patch` | Update one section of an existing skill by `skill_id` |
| `update` | Replace the description and/or full body of a skill by `skill_id` |
| `delete` | Remove a skill by `skill_id` |

Skills are stored in Pi-native locations:

- Global skills: `~/.sp/agent/@super-pi/memory/skills/<slug>/SKILL.md`
- Project skills: `~/.sp/agent/projects-memory/<project>/skills/<slug>/SKILL.md`

New skills must choose scope explicitly:

- `global` for transferable procedures
- `project` for repo-specific workflows tied to local paths, scripts, architecture, deploy steps, or conventions

The agent should use the `skill_manage` tool inline during normal work, not via a background auto-extraction pass. That keeps skill creation deliberate and lets the active model choose whether to create, patch, update, or skip.

For `create` and `update`, the preferred shape is structured input instead of hand-written markdown:

- `when_to_use`
- `procedure_steps`
- `pitfalls`
- `verification_steps`

The tool renders these into a valid `SKILL.md` body with `## When to Use`, `## Procedure`, `## Pitfalls`, and `## Verification` automatically. Raw `content` is still supported for compatibility, but structured fields are the recommended path.

Global skill creation also has duplicate/similarity guards:

- exact slug match → blocked (update existing via `patch`/`update`)
- near-name + high description similarity → blocked as similar (enhance existing)
- near-name + low description similarity → blocked as name collision (rename to a clearer distinct skill name)

Each skill uses a structured `SKILL.md` body:

```markdown
---
name: debug-typescript-errors
description: Step-by-step approach to debugging TS errors in monorepos
version: 1
created: 2026-04-26
updated: 2026-04-26
---
## When to Use
When you see TypeScript compilation errors, especially in monorepo setups.

## Procedure
1. Read the error message carefully
2. Check tsconfig.json extends chain
3. Run tsc --noEmit to get full error list
4. Fix errors bottom-up (dependencies first)

## Pitfalls
- Don't trust VSCode's error display — use the CLI

## Verification
Run `tsc --noEmit` and confirm zero errors.
```

### Project Skill Discovery (`resources_discover`)

Project-scoped skills are loaded via Pi's `resources_discover` hook.

On discovery, the extension returns the active project's skills directory as a skill path:

- `~/.sp/agent/projects-memory/<project>/skills/`

This lets Pi discover project skills as native skills without copying them into the global skills folder.

### Memory vs User Profile vs Skills

| Store | File | What goes here | Limit |
|---|---|---|---|
| **memory** | `MEMORY.md` | Tagged cross-project notes only; active-project facts go to project memory | 5,000 chars |
| **user** | `USER.md` | User profile — name, preferences, communication style, habits | 5,000 chars |
| **skills** | `~/.sp/agent/@super-pi/memory/skills/<slug>/SKILL.md` or `projects-memory/<project>/skills/<slug>/SKILL.md` | Procedures — *how* to debug, deploy, test, or fix something | Unlimited |
| **extended** | `sessions.db` | Searchable memories beyond the core limit | Unlimited |
| **sessions** | `~/.sp/agent/sessions/**/*.jsonl` | Past conversation history (bounded direct search) | Unlimited storage; bounded search |

### Session History Search

The `session_search` tool searches past conversations directly in session JSONL files. It needs no SQLite session index and runs only when called:

| Tool | What it does |
|---|---|
| `session_search` | Search past conversations — "what did we discuss about auth?" |
| `memory_search` | Search extended memory store — unlimited capacity, keyword-based |

`session_search` accepts a `markdown` request with optional `from`, `to`, `cwd`, and `limit` fields, plus `all`, `any`, and `exclude` lists of literal search terms. It returns plain text with `count`, an optional `message`, and compact `path:startLine-endLine` anchors with short reasons. Use `read` on those paths and line ranges to retrieve the conversation text.

For example, `{ "markdown": "limit: 10\nall:\n- authentication\nany:\n- token\n- session" }` finds ranges containing `authentication` and either `token` or `session`. File discovery, scanned lines, query size, and retained results are bounded; scan-limit failures are reported rather than presented as complete results.

The retired `sessionSearch.variant` setting is ignored, including an explicit `legacy` value. Existing configuration files and databases are left intact. The old `query`/`project`/`role`/`snippetChars` request surface is retired; reload the extension to obtain the current tool schema. No history indexing runs at startup, during message handling, or at shutdown.

`memory_search` still queries the derived memory index and supports natural-language queries, quoted phrases, and FTS operators such as `OR`.

### Extended Memory Store

The extension keeps Markdown memory as the human-readable source of truth, and mirrors successful writes into the SQLite-backed search store used by `memory_search`.

This means:
- Fresh `memory` tool writes become searchable immediately
- Older Markdown entries can be backfilled with `/memory → 同步搜索索引`
- SQLite search does **not** replace the core Markdown limit

This is the **hybrid memory architecture**:
- **Core memory** (MEMORY.md/USER.md/failures.md): Human-readable, size-limited, searchable by default
- **SQLite memory mirror/store** (`sessions.db`): Searchable on demand via `memory_search`

Important: if core Markdown memory is full and consolidation cannot free space, the write still fails. This package does **not** silently spill failed core-memory writes into SQLite-only storage.

### Explicit Current-Model Memory Review

`/memory` is the single management command. Choose the user, global, project, or correction review action in its menu:

1. It reads a bounded recent tail of the active conversation and the selected canonical MEMORY.md, USER.md, or failures.md. User preferences are global; global failure review does not modify legacy project-tagged records in the same file.
2. The currently selected model returns a read-only extraction/merge proposal. Model override and child-process settings are not used.
3. Pi displays the complete resulting entry set in a read-only editor.
4. Only an explicit user confirmation publishes the proposal.
5. Publication revalidates the source snapshot under the canonical Markdown mutation lock; concurrent changes make it fail closed.

The menu makes the review scope explicit. Global memory is only for categorized cross-project knowledge. If memory is full, review and merge entries first; no model is invoked automatically.

### Explicit Recovery Artifact Cleanup

`/memory → 清理恢复产物` asks for confirmation and then scans only the global memory directory plus immediate project-memory directories. It removes generated recovery, retired, and conflict artifacts only under existing age/count/byte policies and exact file-identity checks. Canonical memory files, symlinks, lookalikes, and deeper user directories are untouched. No cleanup timer runs at startup.

### Fast Startup and Shutdown

Startup loads active canonical memory and skill roots only. Markdown reconciliation, recovery cleanup, and model review are explicit menu actions. No session indexing, legacy database/root migration, or old skill conversion runs during startup or maintenance.

Shutdown performs no LLM call, session parse, indexing pass, backfill wait, or cleanup sweep. It only closes SQLite if opened and releases exact-owner Markdown lock coordinators.

### Explicit Skill Management

Reusable procedures are created or updated deliberately through `skill_manage` during normal work. `/memory → 管理技能` provides reviewed search, move, and delete operations. No background turn/tool-call hook extracts skills.

### Commands

| Command | What it does |
|---|---|
| `/memory` | View current canonical entries, select scoped review, skills, sync or artifact cleanup |

Standalone `/memory-review`, `/memory-cleanup`, `/memory-sync-markdown`, `/memory-skills`, and `/memory import` are retired. Use the corresponding menu actions; import is no longer provided. Headless `/memory` displays storage locations without modifying data.

### `/memory → 管理技能` Manager

`/memory → 管理技能` now opens an interactive TUI modal for skill management.

Features:
- fuzzy search by skill name
- single-list view with scope badges (`[G]` global, `[P]` project)
- multi-select with spacebar
- batch move to global or current project
- batch delete with one confirmation
- inline action summaries for partial success/conflicts

Keybindings:
- `↑` / `↓` — move focus
- `space` — toggle selection
- `/` — focus search
- `tab` — switch between search and list
- `g` — move selected skills to global
- `p` — move selected skills to project
- `d` — delete selected skills
- `a` — select all filtered skills
- `n` — clear selection
- `esc` — close the modal

Move behavior:
- moves are **conflict-safe**
- if the destination already contains the same slug, the conflicting skill stays in place
- batch moves use partial-success semantics: non-conflicting skills move, blocked skills are reported in the summary

## Configuration

Create `~/.sp/agent/config/hermes-memory-config.json`:

```json
{
  "memoryMode": "digest",
  "memoryPolicyStyle": "full",
  "memoryCharLimit": 5000,
  "userCharLimit": 5000,
  "projectCharLimit": 5000,
  "memoryDir": "~/.sp/agent/@super-pi/memory",
  "projectsMemoryDir": "projects-memory",
  "reviewRecentMessages": 0,
  "memoryOverflowStrategy": "reject",
  "failureInjectionEnabled": true,
  "failureInjectionMaxAgeDays": 7,
  "failureInjectionMaxEntries": 5,
  "consolidationTimeoutMs": 180000
}
```

| Setting | Default | Description |
|---|---|---|
| `memoryMode` | `digest` | Prompt behavior: `digest` sends the constant policy plus one hidden memory digest per session context; `policy-only` sends only the policy; `legacy-inject` restores full memory prompt injection |
| `memoryPolicyStyle` | `full` | Policy text used in `digest` and `policy-only` modes: `full` preserves the default v0.7 policy; `compact` uses shorter built-in guidance; `custom` uses `memoryPolicyCustomText`; `none` injects no policy text |
| `memoryPolicyCustomText` | unset | Custom policy text used when `memoryPolicyStyle` is `custom`; blank or missing text falls back to `compact` |
| `memoryCharLimit` | `5000` | Max characters in MEMORY.md |
| `userCharLimit` | `5000` | Max characters in USER.md |
| `projectCharLimit` | `5000` | Max characters in project-scoped MEMORY.md |
| `memoryDir` | `~/.sp/agent/@super-pi/memory` | Custom directory for extension storage files |
| `projectsMemoryDir` | `projects-memory` | Subdirectory under `~/.sp/agent/` for project-scoped memory |
| `reviewRecentMessages` | `0` | Recent conversation messages offered to explicit `/memory → 整理记忆` before the hard 80,000-character tail bound (`0` = all eligible messages) |
| `memoryOverflowStrategy` | `reject` | `reject` returns a capacity error; `fifo-evict` rotates oldest entries. Legacy `auto-consolidate` is accepted but no automatic consolidator is registered, so it also rejects until `/memory → 整理记忆` is run |
| `consolidationTimeoutMs` | `180000` | Legacy field name retained as the timeout for one explicit current-model `/memory → 整理记忆` proposal |
| `failureInjectionEnabled` | `true` | Digest and legacy modes: enable/disable including recent failure memories into the system prompt |
| `failureInjectionMaxAgeDays` | `7` | Digest and legacy modes: maximum age in days for injected failure memories |
| `failureInjectionMaxEntries` | `5` | Digest and legacy modes: maximum number of failure memories to inject |

Removed legacy fields (`nudgeInterval`, `nudgeToolCalls`, `reviewEnabled`, `flushOnCompact`, `flushOnShutdown`, `flushMinTurns`, `flushRecentMessages`, `correctionDetection`, `correction*Patterns`, `correctionDirectiveWords`, `childExtensionPaths`) are ignored if present; no automatic review, flush, or correction hook exists in this hardened build.

## Where Data Lives

```
~/.sp/agent/
├── config/
│   └── hermes-memory-config.json
├── @super-pi/memory/      ← Global extension storage root
│   ├── MEMORY.md          ← Agent's personal notes (env facts, patterns, lessons)
│   ├── USER.md            ← User profile (name, preferences, habits)
│   ├── sessions.db        ← Derived memory search index
│   └── skills/            ← Global extension-managed skills
│       ├── debug-typescript-errors/
│       │   └── SKILL.md
│       └── testing-checklist/
│           └── SKILL.md
├── projects-memory/       ← ALL project-scoped memories (one subfolder per project)
│   ├── my-project--<root-hash>/
│   │   ├── MEMORY.md
│   │   └── skills/
│   │       └── deploy-checklist/
│   │           └── SKILL.md
│   └── another-project--<root-hash>/
│       └── MEMORY.md
└── ...
```

These are plain markdown files. You can read and edit them directly if you want to curate what the agent remembers. Memory entries are separated by `§` (section sign). Skills use Pi-compatible `SKILL.md` files with frontmatter.

One-time migrations from `~/.sp/agent/memory`, agent-root project folders, basename project folders, and flat skill files are retired. Resolve any interrupted legacy SQLite migration manually before upgrading; this version neither resumes it nor removes its recovery files or pending markers. After ownership checks, put recovered entries in the current canonical Markdown directory shown by `/memory`, then choose **同步搜索索引**. Index sync reads current global files and hashed project identities only. The old `memoryDir` spelling `~/.sp/agent/memory` remains an alias for the current global root; it is not an import source.

The `sessions.db` SQLite database holds the derived memory index used by `memory_search`. Older databases may also contain retired session-index tables; history search now reads the original JSONL files.

## Known Limitations

- **`§` delimiter**: Memory entries are separated by `§` (section sign). If an entry naturally contains `§`, it will be split incorrectly on reload. This is rare in English text but possible. [Hermes uses the same delimiter.]
- **Explicit review cost**: `/memory → 整理记忆` costs one current-model request (and at most one correction retry) only when you invoke it; startup, normal turns, compaction, and shutdown do not call a model for memory maintenance.
- **History search is bounded**: large archives may reach the discovery or scan caps. Results are source line ranges, so read the referenced JSONL lines when conversation text is needed. No automatic indexing pass is registered.
- **Older Markdown memories may need backfill**: If you saved memories before the SQLite mirror existed or search looks stale, run `/memory → 同步搜索索引`.
- **Core memory limits still apply**: SQLite search mirroring does not bypass the 5,000-char core Markdown limit. A full-memory write fails; run `/memory → 整理记忆` to approve a smaller merged result instead of relying on automatic consolidation.
- **Project skill visibility depends on Pi discovery cycles**: project skills are exposed through `resources_discover` using the active project's `skills/` path. If a moved or newly created project skill doesn't show up immediately in a running session, trigger a reload/new session so Pi refreshes discovered resources.
- **Project move requires active project context**: in `/memory → 管理技能`, the `p` hotkey is disabled when Pi is not currently in a detected project directory.
- **Skills still need curation**: Skills are saved by the agent through the `skill_manage` tool when it decides a reusable procedure is worth keeping. They may still need review. You can move, delete, or edit them directly in `~/.sp/agent/@super-pi/memory/skills/` or the active project's `skills/` folder.

## Architecture

![Source Architecture](docs/images/source-architecture.svg)

## Credits

Ported from the [Hermes agent](https://github.com/nousresearch/hermes-agent) by Nous Research. Specifically:

- `tools/memory_tool.py` — `MemoryStore` class, content scanner, tool schema
- `run_agent.py` — Background review loop, session flush, nudge interval
- `agent/memory_provider.py` — Provider lifecycle pattern
- `agent/memory_manager.py` — System prompt injection, context fencing

## License

MIT

---

**[Full Roadmap →](docs/ROADMAP.md)** · **[Changelog →](CHANGELOG.md)**
