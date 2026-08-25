# eregion — reusable pi configuration

This repository is a portable snapshot of the current pi setup used in
`pi-playground`. It is intended to be copied into another project, not to be
installed as a global replacement for your whole `~/.pi` directory.

## Copy into another project

From this repository:

```bash
./scripts/copy-to-project.sh /path/to/your/project
```

The helper is recommended because it handles both kinds of device:

```bash
./scripts/copy-to-project.sh /path/to/your/project
```

It always copies `.pi/`. It also checks the device's global Pi directories
before copying the global snapshots:

- if a global extension/theme/skill already exists, it is not duplicated;
- if it is absent, a project-local copy is installed so the project still works.

For a manual project-only copy (only appropriate when the target device already
has the global resources), use:

```bash
cp -a .pi /path/to/your/project/
```

The copied project will get:

- `.pi/agents/` — planner, builder, tester, and designer roles
- `.pi/extensions/` — live OpenRouter models, clarification, and PBT/DPBT workflow support
- `.pi/skills/pbt/` — local PBT workflow instructions
- global extensions/themes remain in `global-agent/` and are not duplicated in `.pi/`
- `.pi/workflows/` — PBT and DPBT workflow definitions
- `.pi/settings.json` — the current model, thinking level, theme, and display preferences
- `global-agent/skills/` — fallback copies of shared skills for devices that do
  not have them under `~/.agents/skills/`

Pi automatically discovers project resources from `.pi/` and `.agents/`.
The copy helper checks existing global resources before materializing fallback
copies, preventing collisions on this device while keeping the configuration
portable to devices without those global resources.

## Authentication and secrets

Credentials are intentionally **not** included:

- `~/.pi/agent/auth.json` is private machine state and was excluded.
- API keys and `.env` files were excluded.
- `global-agent/models.json` contains provider configuration only; its API key
  values are environment-variable names or local-provider placeholders.

The repository stores global-resource snapshots under `global-agent/`, outside
Pi auto-discovery. The copy helper decides at install time whether each one
should remain global-only or be materialized into the target project. This is
important because Pi loads both global and project resources: copying a resource
that already exists globally causes collisions.

For OpenRouter, export the key in each shell where pi runs:

```bash
export OPENROUTER_API_KEY="..."
```

The OpenRouter dynamic-model extension refreshes the model list when the model
selector opens. For a local Ollama model, install the optional model registry
snapshot into your global pi config:

```bash
./scripts/install-global-models.sh
```

That script refuses to overwrite an existing `~/.pi/agent/models.json` unless
`--force` is supplied.

## Included global snapshot

`global-agent/` preserves the current global Pi settings, custom model registry,
global extensions, themes, and shared skills. The project-local `.pi/` copy is
the recommended shared configuration; use the copy helper so global resources
are installed only when missing. On a machine without the global model
registry, install it with the provided script.

## Generated files and maintenance

Runtime state is deliberately not part of this snapshot. The `.gitignore`
excludes Pi sessions, workflow caches, auth files, environment files, and
local package installs. If the source setup changes, rerun the copy helper and review the diff. It is
safe to rerun: it does not duplicate resources that already exist globally.

Extensions execute with full system access. Review changes before copying this
configuration into a project.
