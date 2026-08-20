# eregion — reusable pi configuration

This repository is a portable snapshot of the current pi setup used in
`pi-playground`. It is intended to be copied into another project, not to be
installed as a global replacement for your whole `~/.pi` directory.

## Copy into another project

From this repository:

```bash
./scripts/copy-to-project.sh /path/to/your/project
```

Or copy the two project resource directories directly:

```bash
cp -a .pi .agents /path/to/your/project/
```

The copied project will get:

- `.pi/agents/` — planner, builder, tester, and designer roles
- `.pi/extensions/` — guardrails, plan-only mode, custom header, live OpenRouter models, clarification, and PBT/DPBT workflow support
- `.pi/skills/pbt/` — local PBT workflow instructions
- `.pi/themes/` — `lotr` and `retro-gaming-blue`
- `.pi/workflows/` — PBT and DPBT workflow definitions
- `.pi/settings.json` — the current model, thinking level, theme, and display preferences
- `.agents/skills/` — shared UI/UX, security, wallet, and related skills

Pi automatically discovers project resources from `.pi/` and `.agents/`, so no
path changes are needed after copying them into a project.

## Authentication and secrets

Credentials are intentionally **not** included:

- `~/.pi/agent/auth.json` is private machine state and was excluded.
- API keys and `.env` files were excluded.
- `global-agent/models.json` contains provider configuration only; its API key
  values are environment-variable names or local-provider placeholders.

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
global extensions, and themes for reference or optional installation. The
project-local `.pi/` copy is the recommended way to share this configuration
between repositories.

## Generated files and maintenance

Runtime state is deliberately not part of this snapshot. The `.gitignore`
excludes Pi sessions, workflow caches, auth files, environment files, and
local package installs. If the source setup changes, recopy the relevant
`.pi/` or `.agents/` directory and review the diff.

Extensions execute with full system access. Review changes before copying this
configuration into a project.
