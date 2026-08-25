# eregion — portable pi package

`eregion` is a shareable [pi package](https://pi.dev) containing the current
coding workflow configuration. It can be pushed to GitHub, installed on many
devices, and updated through pi's package manager.

## Install from GitHub

Replace the URL with the GitHub repository URL after pushing this repository:

```bash
pi install git:github.com/YOUR_GITHUB_USER/eregion
```

Or use an HTTPS URL:

```bash
pi install https://github.com/YOUR_GITHUB_USER/eregion
```

For a pinned release/tag:

```bash
pi install git:github.com/YOUR_GITHUB_USER/eregion@v0.1.0
```

Pi installs the package globally by default, so its extensions, skills, themes,
and workflows are available across projects. Update later with:

```bash
pi update git:github.com/YOUR_GITHUB_USER/eregion
# or update all installed packages
pi update
```

Try the local checkout without installing it permanently:

```bash
pi -e /path/to/eregion
```

## Included resources

- `extensions/eregion/index.ts` — one package entrypoint that loads the
  one-for-all workflow, clarification, OpenRouter dynamic models, guardrails,
  plan-only mode, custom header, and session default model behavior
- `agents/` — planner, builder, tester, and designer prompts used by PBT/DPBT
- `workflows/` — PBT and DPBT workflow definitions
- `skills/` — PBT plus the shared UI/UX, security, wallet, and related skills
- `themes/` — LOTR and retro gaming themes
- `config/models.json` — optional custom model registry snapshot

The package resolves its bundled agents and workflow definitions from its own
installed location, so it works even when the consuming project has no `.pi/`
configuration. A project can still override agents/workflows by creating
`.pi/agents/` or `.pi/workflows/` files.

## Avoiding collisions

Pi loads resources from global and project scopes. The package therefore uses a
single extension entrypoint rather than exposing each extension file separately.
It conditionally loads the global-style extensions only when an equivalent
extension is not already present in `~/.pi/agent/extensions/` or the current
project. This prevents duplicate commands, tools, flags, hooks, or headers on
devices that already have the old global setup.

Skills and themes are contributed through `resources_discover`, one resource at
a time, and only when an equivalent resource is not already available in the
project or global locations. Existing global skills will not collide with the
package's bundled fallback skills.

If you have old manually copied project resources from an earlier version,
remove the duplicate copies before installing the package:

```bash
rm -rf .agents/skills .pi/extensions/guardrails .pi/extensions/pi-ascii.ts \
  .pi/extensions/plan-only.ts .pi/extensions/session-default-model.ts
```

Do not install the package both globally and as a project-local `.pi` copy.
Use the package install once globally, or use `pi install -l` only if you
specifically need project-local installation. If an older project contains a
copy of one of the package extensions, remove it before using the global
package; the entrypoint also avoids registering a duplicate when it detects one.

## Authentication

Secrets are not stored in this repository. Configure providers with `/login`
or environment variables, for example:

```bash
export OPENROUTER_API_KEY="..."
```

Install the optional custom model registry snapshot with:

```bash
./scripts/install-global-models.sh
```

The script protects an existing `models.json` unless `--force` is supplied.

## Development

After changing the package, test it without installing:

```bash
pi -e .
```

The package uses only pi-provided peer dependencies. Extensions execute with
full system access; review code before installing a GitHub copy.
