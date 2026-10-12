# Settings JSON Schema

Super Pi supplies editor schemas for its two `settings.json` locations:

| Configuration | Default location | Schema in this repository/package |
| --- | --- | --- |
| Global | `~/.sp/agent/config/settings.json` | `packages/coding-agent/schemas/settings.schema.json` |
| Project | `<project>/.sp/config/settings.json` | `packages/coding-agent/schemas/project-settings.schema.json` |

An overridden agent directory changes the global location. These are Super Pi
`.sp` schemas, including its PowerShell, fullscreen, output padding, evidence
ledger, tool-result presentation, transport and other local settings.

## Connect an editor

Add a `$schema` property to the configuration file. For a global file:

```json
{
  "$schema": "https://raw.githubusercontent.com/dragonbaba/super-pi/main/packages/coding-agent/schemas/settings.schema.json",
  "showHardwareCursor": true,
  "outputPad": 1
}
```

For a project file:

```json
{
  "$schema": "https://raw.githubusercontent.com/dragonbaba/super-pi/main/packages/coding-agent/schemas/project-settings.schema.json",
  "tuiMode": "fullscreen",
  "fullscreenScrollbar": "auto"
}
```

For offline use, point `$schema` to a local file URL instead. For example, if the
repository is at `D:\src\super-pi`, the project schema URL is
`file:///D:/src/super-pi/packages/coding-agent/schemas/project-settings.schema.json`.
On Unix, use `file:///absolute/path/to/super-pi/packages/coding-agent/schemas/project-settings.schema.json`.
Replace the example path with your checkout or installed package path. Keep both
schema files together: the project schema resolves `settings.schema.json` beside
it, including when used offline. There is no absolute `$id` redirecting local
references to the network. Schema files are static package assets and are
available before a build; they do not depend on `dist` or a running Super Pi.

Editors such as VS Code also support a `json.schemas` association if you prefer
not to add `$schema` to your configuration. Associate the global file with the
global schema and project files with the project schema; avoid a broad
`**/settings.json` match that also captures editor or unrelated application files.
See the [VS Code JSON documentation](https://code.visualstudio.com/docs/languages/json#_json-schemas-and-settings)
for editor association details.

## Scope and compatibility

- Suggestions, descriptions and type/spelling diagnostics come from the editor.
  Super Pi does not fetch, import or validate against these schemas at startup.
  `$schema` is preserved as ordinary configuration metadata.
- Global and trusted project settings still merge as before. Nested object fields
  inherit; arrays replace. Untrusted project settings are not loaded. Schema
  validation cannot grant project trust.
- The project schema diagnoses `powershellPath`, `powershellStatus`,
  `defaultProjectTrust` and `httpProxy`: the current runtime reads these from
  global settings. The PowerShell status and version/analytics markers are
  documented as application-maintained values.
- Legacy `queueMode`, `websockets`, the old `skills` object, and
  `retry.maxDelayMs` remain described. Existing migrations and precedence are
  unchanged. HTTP/WebSocket timeout numeric strings and `disabled` remain
  supported; numeric milliseconds are the preferred representation.
- Each file is validated independently. For example, a project may enable
  `toolResultPresentation` while inheriting its positive integer `budgetTokens`
  from global settings. The schema documents the effective-settings requirement
  without falsely requiring both fields in every layer. Runtime validation of
  the merged budget remains authoritative.
- Unknown built-in fields and malformed values produce editor diagnostics. This
  does not turn the permissive runtime loader into a rejecting loader, nor delete
  custom keys. Configurations with extension-owned keys may need their own
  schema. `models.json`, `keybindings.json`, MCP and extension-specific files are
  not covered by these settings schemas.
- Numeric ranges describe supported editor settings. They do not promise to model
  every permissive runtime fallback or coercion. Provider capabilities, model
  availability, file existence and cross-file values are checked elsewhere.

## Design and validation

The plan's earlier probe found that `showHardwareCursor: "false"` loads as a
string and that `editorPadingX` is silently ignored. Editor schemas diagnose both
without changing runtime compatibility. The pre-edit audit covered the current
`Settings` and nested interfaces, getters, migrations, storage paths, project
trust gate and startup's global proxy access.

This change has no production TypeScript/JavaScript or hot-path changes. Editors
own their schema parse/validation state; Super Pi gains no caches, subscriptions,
timers or runtime allocations. No object pool is introduced. Ajv is a direct
development dependency for tests using the already locked version; runtime
dependencies are unchanged. Allocation benchmarks are not applicable to static
editor metadata.

Focused checks compile both schemas entirely from local files, compare schema
field coverage with the current interfaces, validate current and legacy examples,
check typos/types and global-only fields, and exercise the existing trust,
inheritance and permissive-loading behavior. Distribution is checked with an
offline package dry run. No local full-suite, rendering benchmark or global
rebuild is required for this change.
