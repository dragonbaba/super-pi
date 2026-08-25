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

The executable names are `pi` and `superpi`; both launch the same standalone
Super Pi runtime. During source development, `npm run superpi --` loads the
bundled packages from this repository while keeping user state in
`~/.sp/agent/`.

To expose the local source checkout as a command:

```powershell
npm link
pi --help
superpi --help
```

The npm link creates both `pi` and `superpi`. It does not replace PowerShell's
built-in `sp` alias.

## Isolation from Pi

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
- `MIGRATION.md` — accepted standalone-runtime and cleanup state

## Attribution

See [NOTICE.md](NOTICE.md) for source provenance. Super Pi is distributed under
the MIT License.
