# Pi Auxiliary Vision

Adds OMP-style vision delegation to Pi.

- When the active model accepts images, Pi sends attachments normally; the extension only materializes Pi clipboard temp paths into attachments.
- When the active model is text-only, attached images are analyzed by the configured vision model and the text description is appended to the user's turn.
- For text-only models, a successful description replaces the original image in session history to avoid replaying large unusable payloads. Images are retained only when delegation fails so the user can switch models and retry.
- `inspect_image` analyzes a local PNG/JPEG/GIF/WebP file. In `auto` mode the tool is active only for text-only models.
- On Windows, use `Win+Shift+S`, then `Alt+V` in Pi. Modern Super Pi keeps the image in its native attachment draft and submits typed image data; it does not need a `pi-clipboard-*` file bridge.

## Clipboard lifecycle

The host's public positive safe-integer `IMAGE_ATTACHMENT_VERSION` marker selects native attachment ownership. On that path the extension does not install a global clipboard bridge, scan temporary files at startup, or replace another instance's owner. It still reads historical `pi-clipboard-*` paths with the existing root, size, MIME and identity checks, but does not acquire deletion ownership: **successfully read historical files are retained**, including after reload and shutdown. Unreadable paths remain in the text for retry. Saved vision descriptions and legacy digests remain reusable, and failed delegation preserves the images.

Hosts without this marker retain the legacy bridge. An explicitly supplied clipboard lifecycle also retains its existing consumption rules, even on a modern host. Each owned image has an exact path, owner UUID, PID/start identity, session ID, file identity, timestamp, and `editor`/`submitted`/`materialized` state in a bounded lease manifest. Editor removal/replacement and cancellation release only matching owned identities. Submission clearing does not delete; auxiliary materialization stages the file, and only an accepted user-message event (or completed explicit inspection) confirms consumption. Provider/preflight failure therefore remains retryable. Reload and shutdown release this owner's files.

Only the legacy installation performs the existing cold-start cleanup: dead-owner aged manifests require exact path, regular-file, MIME, identity and temp-root checks; older unleased `pi-clipboard-UUID` files require a 24-hour age plus exact prefix/MIME validation. Files covered by the live-lease snapshot are protected from sweeping. Limits remain 8 files/40 MiB per owner and 32 files/128 MiB globally; creation fails closed when safe capacity cannot be proven. Modern attachment loading is not a historical orphan-file cleanup operation.

Legacy consumption and lease cleanup recognize Windows short/long directory aliases only when they resolve to the same configured temporary root. Creator/editor paths and the lease format remain unchanged. Final file type, MIME and identity checks still apply; unresolved aliases are retained rather than treated as missing files. Startup cleanup shares one live-lease snapshot between stale-record and orphan cleanup, so a dead record cannot override a live lease visible in that snapshot. This is not an atomic cross-process registration protocol.

## Configuration

Edit `~/.sp/agent/config/auxiliary-vision.json`:

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
