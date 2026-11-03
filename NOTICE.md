# Notices

## Current license and transition

Super Pi as a whole, including the Super Pi modifications in this revision,
is licensed under the GNU General Public License, **version 3 only**
(`GPL-3.0-only`). The complete license is in [LICENSE](LICENSE).

Copyright (c) 2026 dragonbaba and Super Pi contributors.

The source tree changed from MIT to GPL-3.0-only on 2026-11-03. The change
applies to revisions containing this notice; it does not retroactively revoke
the MIT permissions granted for earlier revisions. Version numbers alone do
not identify the transition: check the license in the exact commit or archive
you received. Retained upstream portions remain available under their original
MIT terms. Super Pi does not claim exclusive rights over those portions, and
does not offer the complete modified work under MIT as an alternative to GPL.

The former root MIT notice is preserved verbatim in [LICENSE-MIT](LICENSE-MIT).
Each workspace package includes the GPL text, a `NOTICE.md`, and `LICENSE-MIT`
with its retained MIT notice. Dependencies and separately identified third-party
files keep their own licenses and copyright notices.

## Redistribution and responsible use

- You may use, study, modify, and redistribute Super Pi, including commercially,
  under GPL-3.0-only.
- When conveying a covered modified work, comply with GPL section 5, including
  licensing the covered work as a whole under the GPL, preserving notices, and
  prominently identifying modifications and their dates.
- When conveying object code, provide the Corresponding Source through a method
  permitted by GPL section 6. This includes the source and scripts needed to
  generate, install, and run that version, and Installation Information where
  that section requires it. A link to unrelated or outdated upstream source
  does not replace the source for your distributed version.
- Do not impose further restrictions on recipients' GPL rights. Distributing a
  covered derivative as proprietary software while withholding the required
  source or GPL rights violates these license conditions.
- Private modifications and internal use do not by themselves require public
  source publication. GPLv3 does not impose AGPL's network-interaction source
  requirement. Merely using this coding assistant to create another program
  does not automatically place that program under GPL; incorporating covered
  code is a separate question.

The project opposes unlawful use, unauthorized access, infringement, and abuse.
This is a statement of project values, not an additional field-of-use restriction
or a modification of the GPL. Applicable law continues to apply. Suspected
license violations can be reported through the
[repository issue tracker](https://github.com/dragonbaba/super-pi/issues), with
the distributed version and public evidence; do not include credentials or
private session data.

This overview does not replace the license. References:
[GPLv3](https://www.gnu.org/licenses/gpl-3.0.html),
[GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html), and
[GPL-compatible MIT/Expat license](https://www.gnu.org/licenses/license-list.html#Expat).

## Upstream attribution

Super Pi is an independent derivative of
[Pi](https://github.com/earendil-works/pi), imported from tag `v0.84.1`
(commit `53fa77ccd8a279eb87e92294ef3687b03ff80112`). Pi is licensed under the
MIT License and carries the original copyright notice:

> Copyright (c) 2025 Mario Zechner

Super Pi is not an official Pi distribution and does not inherit Pi's release
or update channel.

Bundled extension work also incorporates MIT-licensed code derived from the
upstreams identified in the corresponding package metadata and license files,
including `@narumitw/pi-goal`, `@narumitw/pi-tui-kit`,
`@narumitw/pi-plan-mode`, `@narumitw/pi-chrome-devtools`, `@narumitw/pi-lsp`,
`@narumitw/pi-statusline`, `pi-openai-server-compaction`, and the local memory
runtime lineage. Those provenance records are retained alongside the source:

| Component | Retained MIT notice |
| --- | --- |
| Pi baseline and former Super Pi root | [LICENSE-MIT](LICENSE-MIT) — Mario Zechner; dragonbaba and Super Pi contributors |
| Codemode, imported from Pi v1.0.0 (`a13d35a74`) | [Codemode](packages/codemode/LICENSE-MIT) — Mario Zechner |
| Goal, TUI kit, Plan mode, Chrome DevTools, LSP, Statusline | [Goal](packages/goal/LICENSE-MIT), [TUI kit](packages/tui-kit/LICENSE-MIT), [Plan mode](packages/plan-mode/LICENSE-MIT), [Chrome DevTools](packages/chrome-devtools/LICENSE-MIT), [LSP](packages/lsp/LICENSE-MIT), [Statusline](packages/statusline/LICENSE-MIT) — narumiruna |
| OpenAI server compaction | [Compaction](packages/openai-server-compaction/LICENSE-MIT) — Alexis Gallagher |
| Memory runtime lineage | [Memory](packages/memory/LICENSE-MIT) — Chandra Teja |

These attributions describe origins; they do not imply upstream endorsement of
Super Pi or its license change.
