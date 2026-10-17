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
  plan-only mode, custom header, session default model behavior, and the
  formal English-butler conversation manner
- `agents/` — planner, builder, tester, designer, and Docs-agent prompts used by
  PBT/DPBT and the focused just-build workflow
- `workflows/` — PBT, DPBT, and just-build workflow definitions; each subagent role
  (planner/designer/builder/tester/documentation) can be pinned to its own LLM
  provider/model via `models` and given its own Pi reasoning level via `efforts`
  (defaults to `high`; see `extensions/eregion/one-for-all/docs.md`)
- `skills/` — PBT plus the shared UI/UX, security, wallet, and related skills
- `prompts/brainstorm.md` — the `/brainstorm` command for a read-only, question-led product or application ideation session that writes its final brief to `docs/idea/` only on explicit finalisation
- `third_party/superpowers/` — vendored Superpowers v7.0.0 skills and its Pi startup/bootstrap extension; upstream source and license are recorded in `UPSTREAM.md`
- `themes/` — LOTR and retro gaming themes
- `config/models.json` — optional custom model registry snapshot

The package resolves its bundled agents and workflow definitions from its own
installed location, so it works even when the consuming project has no `.pi/`
configuration. A project can still override agents/workflows by creating
`.pi/agents/` or `.pi/workflows/` files.

### Conversation manner

Every session that loads `eregion` receives the composed manner of a formal
English butler and capable personal AI assistant: the agent addresses the user
as “Sir” when natural, uses brief, dry, good-natured sarcasm and witty jokes
where appropriate, proactively surfaces useful next steps and risks, and
remains direct about technical errors. Its humour is never aimed at the user or
used to trivialise serious failures. The package adds this as an independent
system-prompt section, so it does not replace Pi's built-in instructions,
project context, or your own
`APPEND_SYSTEM.md` guidance. Reload Pi with `/reload` (or start a new session)
after updating the package.

Before running PBT, DPBT, or just-build in a project, configure its quality profile once:

```text
/pbt-lint-setup
```

The command name remains for compatibility, but it starts a visible,
interruptible quality-setup turn in the current Pi session. The agent inspects
the repository, chooses or reuses reproducible project-local format, lint,
type-check, build, test, and other applicable commands, and writes
`.pi/quality.json`. The profile maps command names to shell commands and lists
the commands required for completion. You can interrupt it or provide more
context using Pi's normal controls. The orchestrator executes every required
command itself at each quality barrier, captures its output, and routes
failures to the persistent phase agent before proceeding. Run
`/pbt-lint-setup --force` to re-evaluate an existing profile.

PBT and DPBT reserve paired Builder and Tester plans under `acache/plans/`. The Planner must create both before the orchestrator starts Build/Test; invalid or missing output is returned to the Planner for correction. Builder reads only its implementation plan, while Tester reads only its scenario checklist and clears its conditions through passing verification. Normal workflow cleanup preserves both plans for inspection.

For small, direct changes use `/b <request>`. Just-build skips planning and
separate test authoring/verification: one persistent Builder implements the
request, then the orchestrator runs every required quality-profile command.
Failures are returned to that same Builder session for a focused repair before
all required commands are rerun. Use `/b-status`, `/b-inspect`, `/b-resume`,
`/b-stop`, and `/b-cleanup` for the corresponding run controls. `/flow b
<request>` and `pbt_start` with `workflow: "b"` are equivalent entry points.
See `extensions/eregion/one-for-all/docs.md` for details.

### Documentation maintenance

Add `--docs` to a workflow to run a final, isolated Docs-agent phase **only after its required Tester and orchestrator-owned quality gates pass**:

```text
/pbt --docs <request>
/dpbt --interactive --docs <request>
/b --docs <request>
```

The Docs agent is a separate `documentation` workflow phase and subagent. It
only changes `docs/`, creates or maintains `docs/README.md` as the entry point,
and keeps concise, linked feature, technical, and decision documents as
applicable. It records important product, business, and technical choices and
integrations without turning the folder into a code encyclopedia; it also
removes obsolete or redundant files in `docs/`.

Run `/doc` at any time (no workflow required) for the same project-wide
maintenance pass **in the Pi session where you invoked it**. It starts a normal,
visible and interruptible agent turn there rather than a background subagent.
`--doc` remains accepted as a backwards-compatible alias for `--docs`.

## Guardrails whitelist

During PBT and DPBT, guardrail permission selectors appear in the **parent
session**, labeled with the workflow, requesting phase, and subagent. This works
for design, planning, building, test authoring/verification, and repair turns,
with both headless children and Herdr tabs. Parallel requests are queued; there
is no need to switch to a child session. All existing permission choices remain
available. Session-only approvals and **Reject and stop execution** apply to the
requesting subagent, not the parent. A missing parent UI or disconnected relay
blocks access rather than granting permission or opening a hidden child prompt.

Use `/guardrails-allow project <path>` or `/guardrails-allow global <path>` inside Pi
to allow a file or directory without future prompts. Paths may be absolute or
relative to the current working directory; spaces in paths are supported. The
permission popup also offers **Allow and add path to project whitelist** and
**Allow and add path to global whitelist**. These choices permit the current
operation and persist the approved path. A whitelisted directory covers its
contents, including sensitive files and scripts executed from `/tmp`.

Project entries are stored as absolute paths in `<project>/.pi/guardrails.json`;
global entries go in `<agent-dir>/guardrails.json` (normally
`~/.pi/agent/guardrails.json`, or `PI_CODING_AGENT_DIR`). Both files have the
form `{ "whitelist": ["/absolute/path"] }`. Edit them to remove permissions;
changes are picked up on the next tool call without reloading Pi. Keep project
whitelists out of version control if the paths or permissions are local to your
machine. Invalid configuration blocks guarded tool calls until fixed.

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
