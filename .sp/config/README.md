# Super Pi project configuration

This directory contains repository-owned configuration used by the local `superpi` launcher.

- `settings.json` lists the source packages bundled by this repository.
- Personal configuration belongs in `~/.sp/agent/config/` and must not be committed here.
- Sessions, memory databases, caches, managed binaries, and model catalog state are runtime data rather than configuration and remain under their dedicated directories in `~/.sp/agent/`.
