# Pi OpenAI Fast Mode

Update-safe `/fast` toggle for Pi 0.84.x and OpenAI Codex subscription models.

## Commands

- `/fast` toggles Fast mode.
- `/fast on` enables it explicitly.
- `/fast off` disables it explicitly.

Fast mode returns a shallow replacement payload from Pi's `before_provider_request` hook with `service_tier: "priority"`. It does not register or wrap the `openai-codex` provider and does not import a private Pi AI transport at runtime. Pi's provider remains responsible for OAuth, transport, retries, response parsing, the Codex routing hint, and Priority pricing.

The effective Fast state belongs to the current Pi session. `~/.super-pi/agent/pi-openai-fast.json` stores only the default for the next session or extension reload; changing it does not alter already active sibling sessions. Fast mode is applied only to the `openai-codex` provider. The status line shows `FAST` while it is enabled and an OpenAI Codex model is selected.

Fast and remote compaction share a fail-closed, versioned session registry. Missing sessions, malformed registries, or unknown versions mean no Fast override. Shutdown removes only the exact session state owned by that extension instance, so concurrent embedded runtimes do not share toggles.

Priority processing consumes usage at the provider's Fast rate. ChatGPT-authenticated GPT-5.6 and GPT-5.5 requests currently consume 2.5x Standard credits; GPT-5.4 consumes 2x. API-key Priority processing is billed separately at API rates and is outside this extension's `openai-codex` scope.
