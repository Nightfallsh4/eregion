# Global Pi snapshot

This directory records the current user-level Pi configuration that cannot be
made project-local in the same way as `.pi/` resources:

- `settings.json` — global preferences snapshot
- `models.json` — custom Ollama/OpenRouter model definitions
- `extensions/` — global extension snapshot
- `themes/` — global theme snapshot

Do not copy `auth.json` from a machine into a shared repository. Configure
credentials through `/login` or environment variables instead.

Use `../scripts/install-global-models.sh` if you specifically want to install
the model registry into `~/.pi/agent/`; it protects an existing registry by
default.
