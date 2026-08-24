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
node .\packages\coding-agent\dist\cli.js --help
```

The executable name is `sp`. Super Pi does not install or provide a `pi`
command alias.

## Isolation from Pi

- Package scope: `@super-pi/*`
- User configuration: `~/.super-pi/agent/`
- Project configuration: `.super-pi/`
- CLI environment marker: `SP_CODING_AGENT=true`

The existing global Pi installation is used only as a read-only migration
reference. Super Pi development and tests must never patch or deploy into it.

## Repository layout

- `packages/ai` — model and provider APIs
- `packages/agent` — agent loop and harness
- `packages/coding-agent` — the `sp` CLI and interactive application
- `packages/tui` — terminal UI
- `packages/protocol`, `packages/client`, `packages/server` — session protocol
- `packages/extensions` — bundled Super Pi extensions
- `packages/memory`, `packages/goal`, `packages/lsp` — local agent capabilities
- `MIGRATION.md` — ordered migration ledger and safety baseline

## Attribution

See [NOTICE.md](NOTICE.md) for source provenance. Super Pi is distributed under
the MIT License.
