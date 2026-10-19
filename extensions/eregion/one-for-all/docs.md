# One For All extension — module documentation

This document explains how the One For All extension is set up: what each module
does, how data flows between them, and how to reuse the pieces in other
workflows.

The extension lives at `.pi/extensions/one-for-all/` and is loaded by pi because
`index.ts` is the directory entry point. All sibling modules are plain
TypeScript files imported with ESM `.js`-suffixed relative paths (e.g.
`import { runSubagent } from "./subagent.js"`), matching pi's multi-file
extension convention.

## Big picture

The extension exposes a workflow catalog. Use `/flows` to inspect available definitions and `/flow <workflow-id> <request>` to run one. PBT variants, Design → Plan → Build → Test (DPBT), Plan → Build → Review (PBR), Design → Plan → Build → Review (DPBR), and focused just-build (`b`) are catalog entries in `.pi/workflows/`.

PBR/DPBR use one Builder plan with a required non-empty `## Acceptance Criteria` section. The Builder owns TDD and test changes, never commits, and a plan-only Reviewer evaluates the diff, criteria, tests, code quality, and every required quality command. Failures return only to the Builder. On success, the Reviewer uses its narrowly scoped Git stage/commit exception to make the final commit; the orchestrator reruns the quality profile and verifies that commit before completing the workflow.

```
/pbt <request>, /dpbt <request>, /b <request>, or pbt_start tool
        │
        ▼
   index.ts  ──►  orchestrator.ts (PBT/DPBT) or build-orchestrator.ts (`/b`)
        │              │
        │              ├── plan-paths.ts   reserve paired builder/tester plans
        │              ├── subagent.ts     run child pi sessions
        │              ├── herdr.ts        create/control visible Herdr pi tabs
        │              ├── prompts.ts      build per-phase task text
        │              ├── quality.ts      run required project quality checks
        │              ├── handoffs.ts     parse/validate JSON handoffs
        │              ├── ui.ts           widget + clarification prompts
        │              ├── progress.ts     activity.jsonl events
        │              ├── state.ts        state.json persistence + run registry
        │              └── report.ts       final markdown report
        │
        └── state.ts / progress.ts / ui.ts / report.ts also serve the
            status, inspect, and stop commands/tools.
```

## File-by-file

### `index.ts` — entry point (pi wiring only)

Registers everything pi sees. Contains no workflow logic.

- Commands: `/pbt`, `/dpbt`, `/b`, `/flow`, `/flows`, `/doc`, and their
  workflow status/resume/stop/inspect/cleanup controls. Add `--docs` to
  `/pbt`, `/dpbt`, `/b`, or `/flow` to request the final `documentation` phase
  and its separate Docs subagent after all required Tester and orchestrator-owned
  quality gates pass.
  `/doc` instead sends a normal, visible documentation-maintenance turn to the
  same Pi session that invoked it. `--doc` remains a compatibility alias.
- Tools: `pbt_flow_start`, `pbt_flow_resume`, `pbt_flow_status`,
  `pbt_flow_inspect`, `pbt_flow_stop`, `pbt_flow_cleanup`
- Hook: `session_start` — warns if the latest run was interrupted mid-flight
- Resume command/tool — reuses the original run directory, plan, handoffs, and persistent planner/builder/tester sessions. Pass `--reset-iteration` to the command or `resetIteration: true` to the tool after the max iteration cap is reached; this starts a fresh iteration budget cycle while preserving prior handoffs and history.
- Typebox parameter schemas for the tools
- `/flow <workflow-id> <request>` resolves a catalog definition and dispatches to its runner.
- `startFromCommand()` preserves the legacy `/pbt-flow` aliases and calls `runWorkflow`.

### `build-orchestrator.ts` — focused `/b` control loop

`runBuildWorkflow(pi, ctx, request, maxLintRepairs, externalSignal?, resumeState?, resetIteration?, workflowId?, models?)` implements the small-task workflow without borrowing PBT's plan/test loop:

1. Start (or reuse after resume) a persistent `build.jsonl` Builder session.
2. Make exactly one implementation turn. There is no plan artifact, Designer,
   Tester, test authoring, or test verification phase.
3. Run every required `.pi/quality.json` command programmatically after the
   Builder handoff.
4. On any non-zero quality-command exit, send the captured diagnostics to that
   same `build.jsonl` Builder session, then rerun every required command. This
   repeats up to the workflow preset's `loop.maxIterations` repair-turn limit
   (3 by default).
5. Persist all Builder handoffs and lint attempts in the normal `state.json`,
   activity log, status widget, final report, and Herdr tab lifecycle.

Use `/b <request>` or `/flow b <request>` to start it. `/b-status`,
`/b-inspect`, `/b-resume`, `/b-stop`, and `/b-cleanup` mirror the PBT controls;
matching `b_resume`, `b_status`, `b_inspect`, `b_stop`, and `b_cleanup` tools
are also available. `pbt_start` supports `workflow: "b"` for programmatic starts.

### `orchestrator.ts` — PBT/DPBT control loop

`runWorkflow(pi, ctx, request, interactive, maxIterations, externalSignal?, resumeState?, resetIteration?, workflowId?, useDesignReview?, models?)` — for PBT, `interactive` enables planner questions; for DPBT, it enables design-phase questions while planning remains simple. The optional `models` map supplies per-role model pins and triggers a demand-driven OpenRouter catalog refresh when a configured model is absent locally.
owns the lifecycle and composes all other modules. When `resumeState` is
provided, it continues the existing run instead of creating a new one:

1. Create run ID + run dir under `acache/workflow-runs/<run-id>/`.
2. DPBT only: the Designer creates an isolated static preview under `<run-dir>/design-preview/`. Its built-in localhost review panel supports click-to-annotate comments, general comments, **Request changes**, and explicit **Approve design**. The orchestrator waits at this approval gate, gives newly saved feedback to the persistent Designer for revisions, and writes approved design decisions to `<run-dir>/design-decisions.md`.
3. Reserve paired feature-named Builder and Tester plan paths (`plan-paths.ts`); validate both planner outputs before Build/Test starts and return invalid outputs to the persistent Planner for correction.
3. Register the run in `activeRuns` and wire abort-signal relaying.
4. **Clarification and plan loops** — PBT's interactive variant parses
   `clarification_request` output from the planner and asks the user via
   `ui.ts`; DPBT's `--interactive` variant performs the same round-trip from
   the Designer during the design phase. DPBT always uses the simple planner
   after design approval.
5. **Visible Herdr mode** — when the parent pi process has `HERDR_ENV=1`, each
   phase starts in a detached background Herdr tab containing a pi TUI. The
   planner, builder, and tester use separate tabs; persistent agents reuse
   their tab across clarification/fix/verification turns. The runner tails
   each pi session JSONL file to retain normal handoff parsing and live
   `activity.jsonl` progress.
6. **Iteration 1** — builder and test-authoring subagents run in parallel
   (`Promise.allSettled`) in their separate tabs. The tester may not execute
   anything until the builder-complete barrier.
7. **Verify** — the persistent tester session runs the suites and returns a
   `testStage=verification` handoff with pass/fail, captured test runs, and
   actionable issues.
8. **Fix loop** — the orchestrator creates a durable issue ledger, then sends
   exactly one issue at a time to the Builder. Every non-environment issue,
   including issues marked tester-owned because they concern stale test
   assertions, is processed by the Builder before the next issue is sent. The
   next issue is not sent until the current one reports `fixed`; only the
   completed barrier is followed by tester re-verification. The same persistent builder/tester
   sessions are reused, so request, plan, and prior handoff context is not
   redundantly repopulated on every turn. In Herdr mode, these are the same
   visible builder/tester tabs. Stops on pass, `maxIterations`, or a detected
   plateau (`handoffs.ts#detectPlateau`).
9. When a workflow was started with `--docs` and every required Tester and
   orchestrator-owned quality gate passes, run the separate Docs subagent as the
   final `documentation` phase.
   It updates only `docs/`, maintains `docs/README.md` as the entry point,
   keeps concise feature/technical/decision documentation, and removes obsolete
   or redundant docs files.
10. On any exit path: finalize state, render the report (`report.ts`), clean
   up empty plan reservations, release the run.

### `design-review.ts` — isolated DPBT preview and review runtime

- Generates the self-contained review overlay and starts a localhost-only static server for each preview.
- The overlay writes click-targeted feedback to `feedback.json`, revision requests to `review.json`, and explicit approvals to `approval.json`; these files are within the run-only preview directory, never the app source.
- The server is cleaned up by `/pbt-cleanup` along with `designer.jsonl`.

### `subagent.ts` — child pi session runner (reusable)

- With `permissionContext`, `runSubagent` opens a private guardrail relay before
  dispatching either runner and closes it when the turn settles or aborts. Every
  orchestrator phase supplies the parent context through `progress(...)`, so
  design/plan/build/test, authoring, verification, fixes, and lint repairs all
  show permission selectors in the parent. `permissionWorkflow` plus the phase
  and agent identify the requester in the selector heading.
- `runSubagent(options)` uses the portable headless runner by default:
  `pi --mode json -p` with `--append-system-prompt <agent.md>`, `--tools`,
  `--model`, and either `--session <path>` (persistent) or `--no-session`
  (ephemeral). It streams JSONL stdout into `ProgressEvent`s, captures the
  last assistant message as output, accumulates token/cost usage, enforces
  `PHASE_TIMEOUT_MS` (SIGTERM → SIGKILL after 5 s), and honors an external
  `AbortSignal`.
- With a `tui` context, it opens/reuses a detached Herdr tab, starts pi in TUI
  mode, submits work with `herdr agent prompt --wait`, and tails the persistent
  pi session JSONL for live tool/assistant events and the final handoff. If
  Herdr's five-second idle-to-working detector reports `agent_prompt_stalled`
  after pi accepted the prompt, the runner follows the session's assistant
  stop record instead of treating the still-running agent as failed. The tab
  remains available for inspection; its label receives ✓ or ✗ on settle.
- `getSubagentModel(ctx, models)` — resolves an authenticated provider/model
  for a child subagent. Resolution order for a role:
  `PBT_FLOW_MODEL_<ROLE>` env override → `models[role]` → `models.default` →
  legacy `PBT_FLOW_MODEL` env override → durable new-session default → first
  available model. Configured values that are not found or lack configured auth
  fall through to the next layer; a value solves as `provider/modelId` when it
  contains a `/`, otherwise the bare `modelId` is matched against the catalogue.
  `/resolveSubagentModels(ctx, models)` returns the effective role → `provider/id`
  map used by the orchestrator and persisted run state. A model manually
  selected in the parent session is not inherited by child instances.
- `getSubagentEffort(efforts, role)` — resolves the Pi `--thinking` level for
  each child. Resolution is `PBT_FLOW_EFFORT_<ROLE>` → `efforts[role]` →
  `efforts.default` → `PBT_FLOW_EFFORT` → `high`; `resolveSubagentEfforts()`
  produces the persisted role map. Pi clamps the requested level to a model's
  supported thinking levels when necessary.
- `getPiInvocation(args)` — re-invokes the current pi binary when possible,
  falls back to `pi` on PATH.

### `../global/guardrails-relay.ts` — parent permission dialogs

- Relays the existing guardrail choices over private local IPC (Unix sockets or
  Windows named pipes). The child applies the selected decision, preserving
  once/session/whitelist semantics and stopping only the requesting subagent
  for **Reject and stop execution**.
- One parent-process dialog queue serializes parallel builder/tester requests.
  Dialogs include the workflow, phase, agent, operation, target, and working
  directory. Desktop reminders run only for the currently displayed selector.
- Headless children receive the endpoint through `EREGION_GUARDRAILS_RELAY`.
  Persistent sessions discover it through `<session>.guardrails-relay.json`,
  atomically replaced before each turn. Existing Herdr TUIs read it on every
  permission request, so resume/reuse routes to the current parent without
  restarting the tab.
- Each relay uses a fresh token and private temporary directory; it accepts only
  the known permission choices. Missing UI, stale/disconnected relays, malformed
  responses, and dismissed selectors fail closed without a child-local prompt.
  Child cancellation or workflow shutdown dismisses active dialogs and skips
  canceled requests in the queue. Cleanup removes session discovery files;
  until then stale discovery deliberately blocks orphaned children.

### `herdr.ts` — Herdr multiplexer adapter (reusable)

- Activates only in an existing Herdr-managed parent pane (`HERDR_ENV=1`).
- Wraps `herdr tab create`, `herdr agent start --kind pi`,
  `herdr agent prompt --wait`, interrupt, get, and tab rename calls.
- Keeps new phase tabs detached (`--no-focus`) in the parent workspace and
  derives unique per-run names such as `pbt-builder-<run-suffix>`.
- `PBT_FLOW_HERDR=off` forces the original headless runner even inside Herdr.

### `handoffs.ts` — the handoff protocol (reusable)

Subagents communicate through a JSON contract embedded in their final
assistant message (fenced ` ```json ` block or bare JSON).

- Parsing: `parseJsonCandidates`, `parseHandoff`, `parseClarificationRequest`
- Normalizers: `normalizeHandoff`, `normalizeArtifact`, `normalizeDecision`,
  `normalizeIssue`, `normalizeTestRun` — tolerant readers that coerce model
  output into the typed shapes
- Enforcement: `requireHandoff` (throws on failed/timeout subagents, falls
  back to a summary-only handoff on unparseable output),
  `validateAuthoringHandoff`, `validateVerificationHandoff`
- Authoring recovery: invalid tester authoring handoffs trigger a focused
  correction turn through the same persistent tester session; invalid
  persisted authoring handoffs are ignored during resume so the phase can be
  repaired instead of being treated as a completed barrier.
- Prompt rendering: `renderPlanContext`, `renderAuthoringContext`,
  `renderBuilderBarrier`, `renderIssue`, and `renderIssues` expose compact,
  recipient-specific deltas; `renderHandoff` remains a general compact view.
- Analysis: `isVerificationHandoff`, `latestVerification`, `detectPlateau`
  (same non-zero failed-test count twice in a row)

### `quality.ts` — required project quality profile

Reads `.pi/quality.json`, validates its named commands and required list, runs
every required command with a bounded timeout, captures output, and supplies
machine-captured diagnostics to persistent agent repair turns. The orchestrator
records all attempts in run state and blocks phase transitions until every
required command passes.

### `documentation.ts` and `agents/docs.md` — docs maintenance

The optional final documentation phase uses a separate Docs subagent and is
recorded as a `documentation` handoff. It runs only after the workflow's
required Tester and orchestrator-owned quality gates pass. Its prompt strictly limits changes to `docs/`;
it creates or maintains `docs/README.md` as the entry point, organizes important
material into focused feature, technical, and decision documents as appropriate,
and removes obsolete, duplicate, or empty documentation files. `/doc` does not
start this subagent: it sends the maintenance task to the invoking Pi session,
where the work is visible and interruptible.

### `prompts.ts` — task builders

`buildPlanTask`, `buildInitialBuildTask`, `buildIssueFixTask`,
`buildIssueFixRetryTask`, `buildCompletionTask`, `buildTestAuthoringTask`, and
`buildTestVerificationTask` assemble compact phase-specific task strings.
Initial turns receive request and plan context; persistent follow-up turns
receive only new clarification, one issue, or the builder barrier. Parallel
and late test authoring have separate prompts so their instructions cannot
conflict.

### `plan-paths.ts` — plan path reservation (reusable)

- `deriveFeatureSlug(request)` — extracts the concise subject of an action
  from the request rather than truncating the whole sentence ("make a directory
  called to-do and create a to-do app" → `to-do-app`), normalizes it to
  kebab-case, and caps it at `MAX_SLUG_LENGTH`.
- `reservePlanPaths(cwd, request)` — atomically creates zero-byte `acache/plans/builder-plan-<slug>.md` and `tester-plan-<slug>.md` placeholders plus in-memory reservations. A collision on either advances both names to the same `-2`, `-3`, … suffix.
- `releasePlanReservations` — frees both in-memory slots; the orchestrator deletes only empty placeholders if the planner never filled them. Completed plans remain inspectable after normal cleanup.

### `cleanup.ts` — resource cleanup

- `/pbt-flow-cleanup [run-id]` closes the run's Herdr planner, builder, tester,
  and Docs-agent tabs and removes their session files, including `docs.jsonl`.
- Cleanup preserves `state.json`, `activity.jsonl`, and the plan so historical
  status and handoffs remain inspectable. It refuses active in-process runs.

### `state.ts` — run registry + persistence

- `activeRuns: Map<runId, RunControl>` — in-process registry used by
  stop/status.
- `saveState` — atomic write of `state.json` (temp file + rename), mirrored
  into the session via `pi.appendEntry("pbt-flow", state)` best-effort.
- `loadState` / `listStates` / `stateForArgument` — read-side helpers;
  `stateForArgument` resolves "the run the user means" (explicit id → active
  run → most recent on disk).
- `assertPlanExists` — path-safety + non-empty check on the planner's output.
- `summarizeState` / `inspectState` — text renderings for status/inspect
  commands and tools.

### `progress.ts` — activity log (reusable)

`appendProgress` appends one JSON line per event to `activity.jsonl` and
updates the state's `currentAgent`/`currentActivity`/`latestOutput` fields plus
an `agentStatuses` entry for each planner, builder, and tester. This makes the
status of every persistent subagent independently visible instead of showing
only whichever agent emitted the last event. `readProgress` reads the tail,
`formatProgressEvent` renders one line for humans. `tail -f activity.jsonl`
gives a live view from another terminal.

### `ui.ts` — TUI integration

- `updateUI(ctx, state, output?)` — redraws the workflow widget (phase
  checklist, iteration counter, active agent line, and per-agent statuses) and
  status bar. Widget lines are sanitized and clipped to the available terminal
  columns instead of wrapping multiline diagnostics over the editor. Stopped
  runs collapse to a short status, failure preview, and `/pbt-status` hint.
  Resuming clears the previous stop/error and agent activity from the live
  widget; a reset budget shows verification and lint from the new cycle only.
  No-op when `ctx.hasUI` is false.
- Each Herdr subagent session polls the persisted `state.json` while it is
  open, including while the run is stopped and resumable. This keeps planner,
  builder, and tester widgets synchronized when the same tabs resume, even
  though they run in separate pi extension instances.
- `askClarifications(ctx, questions, round)` — per-question select with the
  planner's options plus "Custom answer" and "Proceed without deciding";
  `CLARIFICATION_TIMEOUT_MS` applies, and unanswered questions are recorded
  as unresolved assumptions.

### `report.ts` — final report

`buildFinalReport(state)` renders the markdown report (status, handoffs,
file list, per-iteration test verification with commands/exit codes/issues).
`finishReport` updates the widget and delivers a `workflow-final-report` custom
message. Stopped-run reports are collapsed by default and can be expanded for
full diagnostics. Pi notifications are permanent transcript entries, so stopped
runs do not emit one; the widget and report provide the error instead. After a
resume, earlier reports render as superseded, and a successful resumed report
shows a concise error-free summary. Full history remains in the session report
content and persisted run files. `/pbt-status` and `/pbt-inspect` include the
current failure reason when present.

`deliverWorkflowOutput` routes reports, status/inspect output, and catalog
listings through pi's session renderer when a UI is active. It writes to stdout
only without a UI, so output cannot overwrite pi's screen or input editor.
Terminal control sequences are stripped from displayed diagnostics, while
`state.json` retains the original failure details.

### `constants.ts`, `types.ts`, `util.ts` — shared leaves

- `constants.ts` — `WORKFLOW_NAME`, `RUNS_DIR` (`acache/pbt-flow-runs`),
  `MAX_ITERATIONS` (5), lint repair and agent timeouts,
  `CLARIFICATION_TIMEOUT_MS` (2 min), slug/handoff/display length caps.
- `types.ts` — every shared interface: `WorkflowState`, `PhaseHandoff`,
  `TestIssue`, `TestRun`, `ClarificationRequest`, `ProgressEvent`,
  `AgentResult`, `RunControl`, …
- `util.ts` — `ensureDirectory`, `truncate`, `isRecord`, `asString`,
  `asNumber`, `getAssistantText`.

## Dependency graph (acyclic)

```
constants   types   util
    │        │       │
    ├────────┴───────┴──► handoffs ──► prompts
    │            │          │
    │            │          ├────────► ui ──► report
    │            │          │
    ├────────────┴──► plan-paths      │
    │            │                    │
    ├────────────┴──► progress ──► state
    │                               │
    ├──────────────► herdr ──► subagent
    │                               │
    └──────────────► orchestrator ◄─┘ (imports nearly everything)
                          │
                        index.ts
```

Leaves (`constants`, `types`, `util`) have no intra-extension imports, so any
module can be lifted into another workflow without dragging the whole
extension along.

## Runtime artifacts

Each run writes to `acache/pbt-flow-runs/<run-id>/`:

| File             | Writer        | Contents                                                                                   |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `state.json`     | `state.ts`    | Full `WorkflowState`: handoffs, answers, status, counters                                  |
| `activity.jsonl` | `progress.ts` | One `ProgressEvent` per line (tool starts/ends, assistant text, stderr, phase transitions) |
| `designer.jsonl` | pi            | Persistent DPBT designer session and mockup revisions                                      |
| `design-preview/` | Designer/review UI | Isolated static mockup, feedback, approval state, and local server files                 |
| `design-decisions.md` | Orchestrator | Explicitly approved design decisions supplied to plan/build/test agents                  |
| `planner.jsonl`  | pi            | Planner session; interactive persistence and Herdr TUI handoff capture                     |
| `build.jsonl`    | pi            | Persistent Builder session (PBT/DPBT fix iterations; the only subagent session for `/b`)  |
| `test.jsonl`     | pi            | Persistent tester session (authoring + verification; PBT/DPBT only)                        |
| `docs.jsonl`     | pi            | Docs-agent session for an optional final `--docs` documentation phase                       |
| `*.jsonl.guardrails-relay.json` | Subagent runner | Current private permission relay endpoint; refreshed on reuse/resume, removed by cleanup |

Plus the reserved `acache/plans/plan-<slug>.md`, written by the planner subagent.

## Configuration

### Project setup

Run `/project-setup [description]` in an empty directory to start a visible,
interruptible, framework-agnostic project setup turn. For example:

```text
/project-setup Build an internal equipment booking service.
```

When the description is omitted, the command collects bounded root-level
project briefs, prioritising `AGENTS.md` and `CLAUDE.md`. The in-session agent
uses the brainstorming skill and `clarify` tool to resolve only material
language, framework, library, runtime, and delivery decisions; it does not
apply a fixed stack. It initialises Git if necessary, scaffolds the selected
framework, installs project-local framework and quality dependencies, and adds
applicable format, lint, type-check, test, build, and framework configuration.
Every successful setup writes `.pi/quality.json` with the required quality
commands used by PBT, DPBT, and just-build, runs those commands once, and
reports genuine failures without weakening the gates.

### Required project quality profile

Before running `/pbt`, `/dpbt`, `/b`, or a workflow tool, configure the
project's quality profile once:

```text
/pbt-lint-setup
```

The command name remains for compatibility. It starts a visible, interruptible
setup turn in the **current Pi session** — it does not start a
detached/background subagent. The agent inspects manifests, lockfiles, source
languages, existing scripts/configuration, and CI conventions; reuses working
project-local checks where possible; otherwise creates appropriate local
configuration and standard scripts. It writes `.pi/quality.json` itself:

```json
{
  "commands": {
    "format": "npm run format:check",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": "npm run build",
    "unit": "npm test"
  },
  "required": ["lint", "typecheck", "build", "unit"]
}
```

`commands` may include any applicable reproducible checks, including
integration, e2e, or security. `required` is non-empty, duplicate-free, and
must name configured commands. This project-specific file is the command source
used by PBT, DPBT, and just-build. Run `/pbt-lint-setup --force` to re-evaluate
and replace an existing profile. A missing, unreadable, or invalid profile fails
before child agents start, explains the reason, and directs the operator to
`/pbt-lint-setup`.

PBT/DPBT run every required command after each build turn, after test authoring,
and after verification. A failing build check is sent to the persistent Builder;
a failing test-phase check is sent to the persistent Tester. The same session
repairs the reported findings, then the orchestrator reruns every required
command. It records each command name, exit code, stdout, and stderr in
`state.json` and the final report. A passing Tester handoff must report only
successful test runs, but it is not the authority for workflow completion: all
required profile commands must independently exit successfully.

Just-build runs every required command immediately after its sole Builder
handoff. A failure is sent back to the **same persistent Builder session**
(never a new agent), then every required command is rerun. Its
`workflows/b.json` `loop.maxIterations` value is the number of allowed
quality-repair turns, defaulting to three. No workflow can complete until every
required command exits successfully.

### Per-subagent models and effort

Each subagent role (planner, designer, builder, tester, documentation) can be pinned to its own
LLM provider/model so the strongest model is used where it matters most in each
phase. Configure either in the workflow JSON presets (`workflows/*.json` or a
project `.pi/workflows/*.json`) or with environment variables.

Top-level `models` block in a workflow JSON — values are `provider/modelId`
identifiers (or bare `modelId`s resolved against the catalogue):

```json
{
  "name": "pbt-simple",
  "models": {
    "default": "openrouter/openai/gpt-5.6-luna",
    "planner": "openrouter/anthropic/claude-sonnet-4",
    "builder": "openrouter/anthropic/claude-sonnet-4",
    "tester": "openai/gpt-5.2-pro",
    "designer": "openrouter/google/gemini-2.5-pro",
    "documentation": "openrouter/anthropic/claude-sonnet-4"
  }
}
```

`default` applies to every role not given an explicit entry. A per-phase
`model` override inside `plan`/`design`/`build`/`test` wins for that phase:

```json
{
  "build": {
    "agent": "builder",
    "model": "openrouter/anthropic/claude-sonnet-4",
    "tools": ["edit", "write", "read", "bash", "grep", "find", "ls"],
    "session": "persistent"
  }
}
```

Environment overrides (highest precedence, one per role; set alongside the
legacy `PBT_FLOW_MODEL`):

- `PBT_FLOW_MODEL_PLANNER=provider/model`
- `PBT_FLOW_MODEL_DESIGNER=provider/model`
- `PBT_FLOW_MODEL_BUILDER=provider/model`
- `PBT_FLOW_MODEL_TESTER=provider/model`
- `PBT_FLOW_MODEL_DOCUMENTATION=provider/model`

Resolution order: role env override → workflow `models[role]` → `models.default`
→ legacy `PBT_FLOW_MODEL` → durable new-session default → first available
authenticated model. A value that cannot be resolved or authenticated falls
through to the next layer. Before a workflow starts, a missing explicitly
configured or unauthenticated OpenRouter model triggers a live model-catalog
refresh, so workflow
pins do not depend on the model selector having been opened first. The effective
role → model map is shown at run start, in `/pbt-status`, and persisted in
`state.json` under `agentModels`.

Workflow definitions merge the package's bundled presets with a project's
`.pi/workflows/*.json`: the bundled presets always form the baseline, and a
project override that does not declare its own `models` block inherits the
bundled preset's `models`. So a project with an older stale workflow copy still
receives the package's model defaults (editing e.g. `workflows/dpbt.json` takes
effect there). Give a project its own top-level `models` block (or per-phase
`model`) to override that project locally.

Legacy model behavior is unchanged when no model is configured: subagent
processes use the durable new-session default (see `subagent.ts#getSubagentModel`).

`PBT_FLOW_MODEL=provider/model` — forces the model used by all subagent
  processes (lowest env precedence; see above).

### Per-subagent effort

Use the parallel top-level `efforts` block to set Pi reasoning (`--thinking`)
levels per role. Valid values are `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`. Every workflow subagent defaults to `high`, including the
optional Docs subagent. Manual `/doc` work uses the invoking session's active
model and thinking level. Pi automatically uses the nearest supported thinking
level if the selected model does not support the requested one.

```json
{
  "name": "pbt-simple",
  "efforts": {
    "default": "high",
    "planner": "xhigh",
    "builder": "medium",
    "tester": "high",
    "documentation": "low"
  }
}
```

A per-phase `effort` override inside `plan`/`design`/`build`/`test` takes
precedence for that role:

```json
{
  "build": {
    "agent": "builder",
    "effort": "xhigh"
  }
}
```

Environment overrides mirror the model configuration:

- `PBT_FLOW_EFFORT_PLANNER=high`
- `PBT_FLOW_EFFORT_DESIGNER=high`
- `PBT_FLOW_EFFORT_BUILDER=high`
- `PBT_FLOW_EFFORT_TESTER=high`
- `PBT_FLOW_EFFORT_DOCUMENTATION=high`

Resolution order is role env override → workflow `efforts[role]` →
`efforts.default` → `PBT_FLOW_EFFORT` → `high`. Invalid effort values are
ignored, preserving the high default. The effective role → effort map is shown
at run start, included in `/pbt-status`, and persisted in `state.json` under
`agentEfforts`.

Workflow definitions merge the package's bundled presets with a project's
`.pi/workflows/*.json`: a project override without an `efforts` block inherits
the bundled high-effort defaults, just as it inherits bundled `models` when it
has no `models` block.
- `/dpbt <request>` — starts DPBT with repository-inferred design decisions. Once the local preview URL is announced,
  review it in a browser; click a proposed UI area to annotate it, save notes,
  choose **Request changes** for another designer revision, or use **Approve design** to unlock planning. `/flow dpbt <request>` is equivalent.
- `/dpbt --interactive <request>` — asks focused questions through the main UI during the design phase, before the preview is produced or revised. Planning remains non-interactive; `/flow dpbt --interactive <request>` is equivalent.
- `PBT_FLOW_HERDR=off` — force headless JSON-mode subagents even when pbt-flow
  is started from a Herdr-managed pi pane. Otherwise Herdr tab mode activates
  automatically when `HERDR_ENV=1`.
- DPBT controls mirror PBT but are scoped to DPBT runs: `/dpbt-resume [run-id]
  [--reset-iteration]`, `/dpbt-stop [run-id]`, and `/dpbt-cleanup [run-id]`.
  Matching `dpbt_resume`, `dpbt_stop`, and `dpbt_cleanup` tools are also
  available. Resume can return to a pending design-review approval gate; cleanup
  closes the isolated preview server as well as designer/planner/builder/tester
  resources.
- Timeouts, iteration caps, and directories are constants in `constants.ts`.

## Workflow catalog

Definitions are JSON files under `.pi/workflows/`. The current runners are `pbt`, `dpbt`, and `build`; `build` is the one-phase runner used by `workflows/b.json`. Additional runners can be added by extending `workflows.ts` and dispatching their orchestrators from the extension entry point. A run persists both `workflowName` and `workflowId`, so status and resume remain unambiguous when multiple workflows share the extension.

## Reusing these pieces in another workflow

1. Copy or import the generic modules: `subagent.ts`, `herdr.ts` (when you
   want visible Herdr agents), `handoffs.ts`, `state.ts`, `progress.ts`,
   `plan-paths.ts`, `types.ts`, `util.ts`, `constants.ts`.
2. Adjust `constants.ts` (workflow name, runs dir, timeouts) for the new
   workflow.
3. Write your own `prompts.ts` (phase task text) and `orchestrator.ts`
   (control loop) — these two encode the pbt-specific policy.
4. Write a thin `index.ts` that registers your commands/tools and calls your
   orchestrator.
5. Keep `report.ts` / `ui.ts` if you want the same TUI widget and report
   format, or swap them for your own renderers.

The handoff JSON contract in `handoffs.ts` is the stable interface between
orchestrator and subagents — if you keep it, the existing agent definitions
(`.pi/agents/*.md`) and parsing/validation code keep working unchanged.
