# ✨ @super-pi/statusline — Local Pi 0.84 Footer

> This is the currently loaded local compatibility build at `./packages/@super-pi/statusline`, not the upstream npm package. Keep it loaded through the local path in `settings.json`; do not replace it with an upstream install when troubleshooting this environment.

This local build gives Pi an opinionated powerline footer that looks good
without setup and keeps useful context visible as the terminal narrows.

A representative uncolored layout:

```text
░▒▓ 🤖 sonnet-4 🧠 high 📁 pi-extensions 🌿 main ~2 🪟 ctx 42.0%/200k 🕒 16:42
```

## ✨ Features

- **Zero-config default:** model, thinking, workspace, Git/PR state, context use, and local time.
- **Responsive:** removes lower-priority segments before important information gets clipped.
- **Quiet when idle:** activity appears only while Pi is streaming or running tools.
- **Native-aligned usage:** optional token, prompt-cache, subscription, cost, and latest generation-speed details.
- **Still flexible:** JSON configuration supports custom layouts, multiline rows, colors, labels, separators, and status icons.

> **Need more customization?** See
> [`pi-starship`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-starship)
> ([npm](https://www.npmjs.com/package/@narumitw/pi-starship)). It uses a
> [Starship-inspired](https://starship.rs/) TOML format and style syntax for deeper control over
> layout, modules, and colors. Choose `pi-statusline` for practical defaults and quick setup.
>
> Do not enable both extensions at the same time because both own Pi's footer.

## 📦 Local loading

This environment loads the checked-out compatibility package directly:

```json
"./packages/@super-pi/statusline"
```

Do not use an upstream npm install command for this build. For the best result, use a terminal font that includes Powerline glyphs and emoji.

This compatibility package targets Pi `0.84.x` and declares Pi's coding-agent and TUI packages as
peer dependencies. On an unsupported runtime it disables itself and keeps Pi's native footer. If the
runtime version cannot be obtained from Pi's public `VERSION` export, it is treated as unknown and is
disabled rather than guessed.

## 🚀 Quick start

Install the extension and start Pi. The footer is enabled automatically. Optional customization is read from `~/.super-pi/agent/pi-statusline.json` (or the active `SP_CODING_AGENT_DIR`). This local compatibility build intentionally registers no `/statusline` command.

The default segments are `model thinking cwd branch tools context time`. Edit the `segments` array directly for a smaller or more detailed layout. `tools` takes no space while idle, and `cache` takes no space when Pi has reported no cache reads or writes.

## 💬 Commands

This build registers no statusline command. Edit the optional JSON configuration directly and restart or reload Pi to apply it.

## 📐 Runtime behavior

### Responsive fitting

Each row keeps its configured segment order. If it is too wide, pi-statusline removes the
lowest-priority segment, recomputes the powerline transitions, and repeats until the row fits.
Retention priority is highest to lowest:

```text
context model branch tools cwd thinking cost speed provider cache tokens time turn brand
```

Explicit `line_break` entries remain row boundaries. A single segment that is still too wide is
ANSI-safely truncated.

### Activity, Git, and PR state

- During active work, `tools` shows `💭 thinking` or `⚙ <tool>` with parallel counts.
- Activity disappears after the agent settles and resets across session replacement or shutdown.
- Clean repositories show no Git counters.
- Dirty counters are `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!`
  conflicts.
- A linked GitHub PR appears with the branch when possible, avoiding a duplicate extension status.
- Context color changes to warning at 70% and error at 90%.
- Git state is cached outside footer rendering and stale session results are ignored.

### Usage and context

- `context` renders one-decimal current usage and the model window, such as `2.4%/272k`. Once usage
  crosses Pi's native automatic-compaction threshold, it temporarily renders
  `98.7% · pending compact` until compaction completes or the agent settles. After compaction it can
  temporarily render `?/272k` until the next valid assistant response.
- `tokens`, `cache`, and `cost` total every usage-bearing session entry, matching Pi's native footer:
  assistant messages, nested-LLM tool results, compactions, and branch summaries, including abandoned
  branches retained in the session.
- Cache tokens are `R<read>`, `W<write>`, and `CH<rate>`. `R` and `W` are cumulative; `CH` uses only
  the latest assistant prompt: `cacheRead / (input + cacheRead + cacheWrite) * 100`.
- Subscription-backed OAuth models and `kimi-coding` append `(sub)` to cost. The dollar value is
  usage cost, not proof of an amount billed under a subscription.
- `speed` shows the latest completed assistant stream's output-token throughput, measured from Pi's
  first stream event through completion. It excludes request wait and tool execution time; unreliable
  non-stream timing is omitted rather than estimated.
- Pi's public extension API does not expose the current auto-compaction toggle or customized reserve,
  so the pending marker mirrors Pi's exported default reserve threshold and clears at `agent_settled`
  if no compaction runs; it does not claim that auto-compaction is enabled persistently.

## ⚙️ Settings

The extension uses one user-level file:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides. Package duplicate detection may inspect Super Pi's user
`settings.json`; project `CONFIG_DIR_NAME/settings.json` and package metadata referenced by it are
read only while `ctx.isProjectTrusted()` is true. Runtime paths use Super Pi's `getAgentDir()` and
`CONFIG_DIR_NAME` exports rather than `HOME` or a hardcoded `.super-pi`. When the file is absent, pi-statusline uses its built-in defaults without creating the file or parent directory. The extension never writes this file. Malformed or unreadable settings are never overwritten. Settings reload on startup, `/reload`, and session replacement.

A valid legacy `pi-statusline-settings.json` remains readable with a warning and is never modified
automatically; rename it to `pi-statusline.json`. If both files exist, `pi-statusline.json` wins.

### Settings reference

| Field | Accepted values | Purpose |
| --- | --- | --- |
| `palettePreset` | `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, `custom` | Select the active color preset |
| `palette` | Per-segment `fg`/`bg` `#RRGGBB` colors | Define colors used by `custom` |
| `density` | `compact`, `cozy` | Control horizontal padding |
| `separator` | `none`, `dot`, `bar`, `powerline`, `round` | Separate adjacent segments in one color block |
| `segments` | Ordered unique segment names and `line_break` | Control visibility, order, and rows |
| `segmentText` | Per-segment `prefix` and `suffix`; model truncation fields | Format Pi-owned dynamic values |
| `extensionStatusIcons` | Raw status key or `namespace:*` to icon string | Customize extension status icons |

All fields are optional. Missing fields use defaults. Unknown or invalid recognized values produce a warning; invalid configuration falls back safely without modifying the file.

A compact customization example:

```json
{
  "palettePreset": "ocean",
  "density": "compact",
  "separator": "dot",
  "segments": ["model", "thinking", "cwd", "branch", "context", "cache", "cost"],
  "segmentText": {
    "model": {
      "truncationLength": 40,
      "truncationSymbol": "…",
      "truncationDirection": "middle"
    },
    "context": { "prefix": "ctx ", "suffix": "" }
  },
  "extensionStatusIcons": {
    "goal": "◎",
    "foo:*": "🧪"
  }
}
```

Edit `pi-statusline.json` directly, then restart or reload Pi to apply it.

## 🎨 Appearance

Named palettes provide contrast-checked color ramps and can be selected in JSON.

When `palettePreset` is `custom`, `palette` maps segment names to foreground/background colors:

```json
{
  "palettePreset": "custom",
  "palette": {
    "model": { "fg": "#090c0c", "bg": "#a3aed2" },
    "context": { "fg": "#c0caf5", "bg": "#1d2230" }
  }
}
```

- A manually authored `"palettePreset": "custom"` without `palette` uses Tokyo Night colors.
- Named presets ignore but preserve an existing custom palette.
- A `palette` object without `palettePreset` selects `custom`.
- Legacy string palettes such as `"palette": "ocean"` remain accepted.
- Missing custom colors remain unstyled instead of inheriting Tokyo Night.
- Adjacent segments with identical colors share one block; transitions use ``.

`segmentText` values must be single-line text without terminal control characters and are limited to
64 displayed characters (`truncationSymbol`: 16). Status icons are limited to 16. At the final render
boundary, all untrusted terminal text is stripped of ANSI, OSC, and C0/C1 controls and length-bounded.
Use `line_break` for another row rather than inserting a newline into a prefix or suffix.

### Model truncation

Long model IDs are truncated out of the box so the balanced footer can retain useful model context:

```json
{
  "segmentText": {
    "model": {
      "truncationLength": 36,
      "truncationSymbol": "…",
      "truncationDirection": "start"
    }
  }
}
```

`truncationLength` counts model grapheme clusters retained before the symbol. The built-in value is
`36`; set it to `0` to display the complete ID. The direction names the removed portion:

- `start` retains the suffix and is the default, which is useful for long llama.cpp paths and model
  variants.
- `middle` retains both ends.
- `end` retains the prefix.

Truncation runs after the built-in Claude/GPT shortening rules but before the configured model prefix
and suffix. It changes display only—the provider model ID is untouched. Terminal control sequences
in model IDs are removed at render time, and unsafe configured symbols are rejected. An empty
`truncationSymbol` truncates without a marker. pi-statusline treats model IDs as opaque strings and
does not parse paths, repositories, GGUF suffixes, or quantization names. At very narrow widths, the
existing responsive priorities may still omit the model rather than overflow the terminal.

## 🧩 Advanced layout

Configure layout by editing the `segments` array. Available data segments:

```text
brand provider model thinking cwd branch tools context tokens cache cost speed time turn
```

Data segments must be unique. `line_break` may repeat when data segments separate occurrences, but consecutive breaks are invalid. It has no `segmentText` entry. Leading or trailing breaks represent empty rows.

```json
{
  "segments": ["model", "line_break", "cwd", "branch", "context"]
}
```

An empty `segments` array hides the main powerline while extension statuses can still render. The
extension intentionally has no variable or format language; use `pi-starship` when you need one.

## 🔌 Extension statuses and icons

Other extension statuses appear below the main powerline, wrap to terminal width, and are limited to
five items. Icons resolve in this order:

1. Exact configured raw key, such as `goal` or `foo:server`.
2. Longest configured colon wildcard, such as `foo:*` or `foo:server:*`.
3. Unambiguous installed-package alias, such as `@vendor/pi-foo`, `pi-foo`, or `foo`.
4. Leading emoji supplied by the status text.
5. Built-in icon.
6. Generic `🔌` fallback.

Set an icon to `""` to hide only the icon. Wildcards match colon namespaces, not slash-delimited keys;
configure slash keys exactly. Compatibility fallbacks retain `codex-usage`, `pisync`, and
`unknown-error-retry`; an explicit canonical key wins.

For interoperable extensions, prefer one aggregated key or a stable coexistence slot:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Put transient activity in the value and always clear the same complete key.

## 🛠️ Troubleshooting

- **Powerline symbols look wrong:** use a font with Powerline glyphs; emoji support is also recommended.
- **The footer reports settings warnings:** edit `pi-statusline.json` to fix invalid recognized fields, then restart or reload Pi.
- **The footer appears to be replaced:** disable `pi-starship` or another extension that also calls
  Pi's `setFooter()`.
- **A custom segment disappears on a narrow terminal:** check the responsive priority above or add an
  explicit `line_break`.

## 🗂️ Package layout

```text
packages/@super-pi/statusline/
├── src/
│   ├── index.ts
│   ├── statusline.ts
│   ├── render.ts
│   ├── usage.ts
│   ├── powerline.ts
│   ├── settings.ts
│   ├── extension-status.ts
│   ├── git-status.ts
│   ├── ansi.ts
│   ├── types.ts
│   └── presets/
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`src/index.ts` is the thin Pi entrypoint; all other modules are package-internal.

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer,
context usage, prompt cache, cache hit rate, model status.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
