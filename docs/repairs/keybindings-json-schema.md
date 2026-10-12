# Keybindings JSON Schema

Super Pi supplies a static editor schema for the global
`~/.sp/agent/config/keybindings.json` file. With a custom agent directory, the
configuration lives at `<agentDir>/config/keybindings.json`. Project-level
keybindings files are not loaded.

The schema is `packages/coding-agent/schemas/keybindings.schema.json` in a
checkout, or `schemas/keybindings.schema.json` in the coding-agent package.
It covers built-in editor, selection, fullscreen and application actions, with
descriptions and the supported legacy action names.

## Connect an editor

Add a `$schema` property to the global keybindings file:

```json
{
  "$schema": "https://raw.githubusercontent.com/dragonbaba/super-pi/main/packages/coding-agent/schemas/keybindings.schema.json",
  "app.message.copy": "ctrl+x",
  "tui.altScreen.top": ["ctrl+home", "ctrl+up"],
  "tui.altScreen.bottom": ["ctrl+end", "ctrl+down"],
  "app.session.new": []
}
```

For offline use, replace the URL with a local file URL. For a checkout at
`D:\src\super-pi`, use
`file:///D:/src/super-pi/packages/coding-agent/schemas/keybindings.schema.json`.
On Unix, use
`file:///absolute/path/to/super-pi/packages/coding-agent/schemas/keybindings.schema.json`.
Replace the example path with your checkout or installed package path. All schema
references stay inside this file; no build or running Super Pi is required.
Editors that support schema associations can also associate this exact global
file without adding `$schema` to it; see the
[settings schema setup](settings-json-schema.md#connect-an-editor) for editor
association guidance.

## Configuration behavior

- A string sets one key; an array sets alternative keys for the same action.
  Both replace that action's defaults. An empty array disables the action.
  Omit an action to keep its defaults. `/hotkeys` shows the effective bindings;
  platform-dependent defaults are not frozen into this schema.
- Key notation includes `ctrl+x`, `shift+ctrl+p`, `escape`, `pageUp` and single
  characters. The existing matcher accepts case variations, modifier order
  variations and `esc`/`return` aliases. The schema deliberately checks string
  types without defining a second key parser. It does not detect invalid key
  syntax, conflicts or terminal/operating-system limitations.
- Legacy action names such as `interrupt` and `cursorLineStart` remain accepted.
  Their descriptions point to the current names. If both forms exist, the
  current name wins. Loading and migration do not rewrite the file.
- Unknown actions and malformed value types produce editor diagnostics. The
  permissive runtime loader remains unchanged: an unknown name does not register
  an action, and an invalid binding type falls back to that action's default.
  `$schema` remains ordinary metadata and does not trigger schema loading or
  validation in Super Pi.
- This schema describes the CLI's built-in actions. SDK applications with their
  own keybinding definitions may need a different schema. Extension shortcuts
  registered through `registerShortcut` are a separate API. This file does not
  configure models, settings, MCP or extension-owned options.

## Design and validation

The pre-edit audit covered the global path, JSON/BOM loading, legacy migration,
value filtering, TUI binding resolution and key matching. The feature adds only
static editor metadata and documentation; it changes no production
TypeScript/JavaScript. Editors own their schema state, and Super Pi gains no
runtime allocations, caches, pools, timers or subscriptions. Allocation
benchmarks do not apply.

Focused offline tests check coverage against the current source definitions and
legacy mapping, accepted/rejected shapes, and real file loading without writes.
An offline package dry run checks schema inclusion. No local full-suite test,
global rebuild or actual editor/terminal display verification is claimed.
