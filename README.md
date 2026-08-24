# Super Pi

Super Pi is an independent, source-first coding agent derived from
[Pi](https://github.com/earendil-works/pi) `v0.84.1`. It keeps Pi's compact
terminal-agent foundation while absorbing the local runtime, safety, memory,
compaction, provider, and extension work that previously lived around a global
Pi installation.

Super Pi is not an official Pi distribution. It uses its own package scope,
command, and configuration directories so an existing Pi installation can
remain untouched.

## Current status

The initial source migration is complete. This repository provides source code
plus a local CLI; npm publication and an upstream migration workflow are
intentionally out of scope.

## Requirements

- Node.js 22.19 or newer
- npm

## Build and run

```powershell
npm install
npm run build:offline
npm run superpi -- --help
```

The executable name is `superpi`. During source development, `npm run superpi --` loads
the bundled Super Pi packages from this repository while keeping user state in
`~/.sp/agent/`. Super Pi does not install or provide a `pi` command alias.

To expose the local source checkout as a command:

```powershell
npm link
superpi --help
```

The npm link only creates `superpi` and does not replace an existing `pi`
command or PowerShell's built-in `sp` alias.

## Isolation from Pi

- Package scope: `@super-pi/*`
- User configuration: `~/.sp/agent/config/`
- Project configuration: `.sp/config/`
- Runtime data: dedicated directories under `~/.sp/agent/`
- CLI environment marker: `SP_CODING_AGENT=true`

The existing global Pi installation is used only as a read-only migration
reference. Super Pi development and tests must never patch or deploy into it.

To copy supported JSON configuration and the global `AGENTS.md` context from
the existing global Pi without changing it or importing old package paths:

```powershell
npm run migrate:pi-config
npm run check:pi-config
```

Migration creates missing files only and refuses to overwrite a differing
Super Pi configuration. Credentials and other personal configuration remain
outside this repository.

## Repository layout

- `packages/ai` — model and provider APIs
- `packages/agent` — agent loop and harness
- `packages/coding-agent` — the `superpi` CLI and interactive application
- `packages/tui` — terminal UI
- `packages/protocol`, `packages/client`, `packages/server` — session protocol
- `packages/extensions` — bundled Super Pi extensions
- `packages/memory`, `packages/goal`, `packages/lsp` — local agent capabilities
- `packages/tui-kit`, `packages/plan-mode`, `packages/chrome-devtools` — absorbed local UI and workflow capabilities
- `.sp/config`, `.sp/agents`, `.sp/prompts`, `.sp/skills` — bundled source-mode configuration and resources
- `MIGRATION.md` — ordered migration ledger and safety baseline

## Attribution

See [NOTICE.md](NOTICE.md) for source provenance. Super Pi is distributed under
the MIT License.
