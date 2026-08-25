# Super Pi

Super Pi is an independent, source-first coding agent originally derived from
[Pi](https://github.com/earendil-works/pi) `v0.84.1`. It now owns its complete
runtime, safety, memory, compaction, provider, extension, and terminal-agent
implementation in this repository.

Super Pi is not an official upstream distribution. It uses the `@super-pi/*`
package scope, provides the `superpi` command, and keeps all user state under
its dedicated `.sp` directories.

## Current status

The standalone runtime and cleanup are complete. This repository provides the
full source implementation and locally linked CLI without any fallback runtime
or external legacy package dependency. npm publication is currently out of
scope.

## Requirements

- Node.js 22.19 or newer
- npm

## Build and run

```powershell
npm install
npm run build:offline
npm run superpi -- --help
```

The executable name is `superpi`. During source development,
`npm run superpi --` loads the bundled packages from this repository while
keeping user state in `~/.sp/agent/`.

To expose the local source checkout as a command:

```powershell
npm link
superpi --help
```

The npm link creates `superpi`. It does not install a `pi` command or replace
PowerShell's built-in `sp` alias.

## Standalone runtime

- Package scope: `@super-pi/*`
- User configuration: `~/.sp/agent/config/`
- Project configuration: `.sp/config/`
- Runtime data: dedicated directories under `~/.sp/agent/`
- CLI environment marker: `SP_CODING_AGENT=true`

Super Pi is self-contained and has no external legacy runtime dependency.
Credentials and other personal configuration remain outside this repository
under `~/.sp/agent/config/`.

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
- `MIGRATION.md` — accepted independence and cleanup state

## Attribution

See [NOTICE.md](NOTICE.md) for source provenance. Super Pi is distributed under
the MIT License.
