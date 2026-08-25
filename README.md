# eregion — reusable pi configuration

This repository is a portable snapshot of the current pi setup used in
`pi-playground`. It is intended to be copied into another project, not to be
installed as a global replacement for your whole `~/.pi` directory.

## Copy into another project

From this repository:

```bash
./scripts/copy-to-project.sh /path/to/your/project
```

Or copy the project resource directory directly:

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
- shared global skills are preserved in `global-agent/skills/` for reference;
  they are not copied into `.agents/` because pi already discovers them from
  `~/.agents/skills/`

Pi automatically discovers project resources from `.pi/`. The shared skills
are machine-scoped and are discovered from `~/.agents/skills/`; keeping them out
of the copied project prevents skill collision warnings.

## Authentication and secrets

Credentials are intentionally **not** included:

- `~/.pi/agent/auth.json` is private machine state and was excluded.
- API keys and `.env` files were excluded.
- `global-agent/models.json` contains provider configuration only; its API key
  values are environment-variable names or local-provider placeholders.

The local `.pi/` directory deliberately contains only project-scoped resources.
The shared skills snapshot is kept outside auto-discovery under
`global-agent/skills/` for the same reason.
Machine-scoped extensions (guardrails, plan-only mode, custom header, and the
session default model) are kept in `global-agent/` and continue to load from
`~/.pi/agent/`. They must not be copied into `.pi/extensions/`, because pi will
load both scopes and register those extensions twice.

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
global extensions, themes, and shared skills for reference or optional
installation. The
project-local `.pi/` copy is the recommended way to share this configuration
between repositories. On a machine without the global snapshot, install the
model registry with the provided script and copy global extensions/themes to
`~/.pi/agent/` only after reviewing them.

## Generated files and maintenance

Runtime state is deliberately not part of this snapshot. The `.gitignore`
excludes Pi sessions, workflow caches, auth files, environment files, and
local package installs. If the source setup changes, recopy the relevant `.pi/` directory and review
the diff. Do not copy `global-agent/skills/` into a project's `.agents/skills/`
directory: those skills are intentionally machine-scoped.

Extensions execute with full system access. Review changes before copying this
configuration into a project.
