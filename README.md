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

Themes are declared as package resources in `package.json`. Skills are added
through the entrypoint's `resources_discover` hook after project/global skills
are known, so bundled skills are used only as collision-safe fallbacks. Existing
project/global skills and themes therefore do not collide with this package.

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

## Development while using the package

Use an editable local install on the device where you are developing. This
makes pi load the package directly from your working tree, so you can edit the
repository and use the changes immediately after `/reload` or a new pi session.

If the GitHub copy is currently installed, remove it first. Do not leave both
sources installed because pi will load both package entrypoints:

```bash
pi remove git:github.com/Nightfallsh4/eregion
pi install /home/nightfallsh4/Programming/Learning/eregion
```

The local package source is recorded in `~/.pi/agent/settings.json` and is
shared across projects. Check it with:

```bash
pi list
```

Then work normally in any project:

```bash
cd /path/to/project
pi
# edit eregion in another terminal
# use /reload in pi, or restart pi, to load the change
```

After changing the package, run a temporary smoke test from the repository:

```bash
cd /home/nightfallsh4/Programming/Learning/eregion
PI_OFFLINE=1 pi -e . --list-models
```

`pi -e .` is useful for a one-off test, but do not use it while the same
package is already installed globally unless you intentionally isolate the
Pi config; otherwise the global and temporary package can both load.

For a completely isolated test with no installed packages:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" PI_OFFLINE=1 pi -e . --list-models
```

When development is complete:

```bash
git add .
git commit -m "Describe the change"
git push origin main
```

Devices using the GitHub installation can then update with:

```bash
pi update git:github.com/Nightfallsh4/eregion
```

The package uses only pi-provided peer dependencies. Extensions execute with
full system access; review code before installing a GitHub copy.
