# Pi Auxiliary Vision

Adds OMP-style vision delegation to Pi.

- When the active model accepts images, Pi sends attachments normally; the extension only materializes Pi clipboard temp paths into attachments.
- When the active model is text-only, attached images are analyzed by the configured vision model and the text description is appended to the user's turn.
- For text-only models, a successful description replaces the original image in session history to avoid replaying large unusable payloads. Images are retained only when delegation fails so the user can switch models and retry.
- `inspect_image` analyzes a local PNG/JPEG/GIF/WebP file. In `auto` mode the tool is active only for text-only models.
- On Windows, use `Win+Shift+S`, then `Alt+V` in Pi. The exact-version `pi-core-compat` recipe registers `%TEMP%\\pi-clipboard-<uuid>.<mime>` with this extension's creator-owned lease before inserting the path into the editor.

## Clipboard lifecycle

Each created image has an exact path, owner UUID, PID/start identity, session ID, file identity, timestamp, and `editor`/`submitted`/`materialized` state in a bounded lease manifest. Editor removal/replacement and cancellation release only matching owned identities. Submission clearing does not delete; auxiliary materialization stages the file, and only an accepted user-message event (or completed explicit inspection) confirms consumption. Provider/preflight failure therefore remains retryable. Reload and shutdown release this owner's files.

Cold startup reclaims only dead-owner aged manifests after exact path, regular-file, MIME, identity, and temp-root checks. Older unleased `pi-clipboard-UUID` files require a 24-hour age plus exact prefix/MIME validation. Active owners are never swept. Limits are 8 files/40 MiB per owner and 32 files/128 MiB globally; creation fails closed when safe capacity cannot be proven.

## Configuration

Edit `~/.super-pi/agent/auxiliary-vision.json`:

```json
{
  "model": "openai-codex/gpt-5.6-luna",
  "automatic": true,
  "toolMode": "auto",
  "maxInputBytes": 20971520,
  "maxImages": 8,
  "maxTotalInputBytes": 41943040,
  "timeoutMs": 300000,
  "maxTokens": 4096
}
```

The selected model must exist in Pi's model registry, advertise image input, and have working credentials. Configuration is re-read for every request. Numeric settings are clamped to hard safety ceilings. `inspect_image` only uploads regular image files whose resolved paths are inside the current workspace or system temporary directory.

Use `/aux-vision status`, `/aux-vision on`, `/aux-vision off`, or `/aux-vision auto` for session-scoped automatic-delegation control. `/aux-vision status` also reconciles a changed `toolMode`. Run `/reload` after installing or changing extension code; other JSON configuration changes do not require reload.
