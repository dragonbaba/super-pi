# Pi OpenAI Fast Mode

Update-safe `/fast` toggle for Super Pi 1.x, legacy 0.84.x and OpenAI Codex subscription models.

Compatibility uses the host's exported `VERSION`, including SDK and embedded-host loading. The process entry path does not need to be inside the Pi package. The version gate accepts Super Pi 1.x and legacy 0.84.x.

## Commands

- `/fast` toggles Fast mode.
- `/fast on` enables it explicitly.
- `/fast off` disables it explicitly.

Fast mode returns a shallow replacement payload from Pi's `before_provider_request` hook with `service_tier: "priority"`. It does not register or wrap the `openai-codex` provider and does not import a private Pi AI transport at runtime. Pi's provider remains responsible for OAuth, transport, retries, response parsing, the Codex routing hint, and Priority pricing.

The effective Fast state belongs to the current Super Pi session. `~/.sp/agent/config/pi-openai-fast.json` stores only the default for the next session or extension reload; changing it does not alter already active sibling sessions. Fast mode is applied only to the `openai-codex` provider. The status line shows `FAST` while it is enabled and an OpenAI Codex model is selected.

Fast state stays in the extension instance's session map; no process-global registry is published. Shutdown removes only that session's state. Ordinary requests and compaction previews run the same payload hooks: the final `service_tier` controls routing and continuity checks. Fast off stops injecting `priority` without deleting a tier set by another source. A later payload hook may override the tier; the server's response tier affects pricing, never the Fast setting or request identity.

Priority processing consumes usage at the provider's Fast rate. ChatGPT-authenticated GPT-5.6 and GPT-5.5 requests currently consume 2.5x Standard credits; GPT-5.4 consumes 2x. API-key Priority processing is billed separately at API rates and is outside this extension's `openai-codex` scope.
