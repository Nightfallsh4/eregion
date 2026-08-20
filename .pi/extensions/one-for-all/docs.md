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

The extension exposes a workflow catalog. Use `/flows` to inspect available definitions and `/flow <workflow-id> <request>` to run one. PBT variants and the Design → Plan → Build → Test (DPBT) workflow are catalog entries in `.pi/workflows/`.

```
/pbt-flow <request>  or  pbt_flow_start tool
        │
        ▼
   index.ts  ──►  orchestrator.ts (runWorkflow)
        │              │
        │              ├── plan-paths.ts   reserve plan-<slug>.md
        │              ├── subagent.ts     run child pi sessions
        │              ├── herdr.ts        create/control visible Herdr pi tabs
        │              ├── prompts.ts      build per-phase task text
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

- Commands: `/flow`, `/flows`, `/pbt-flow`, `/pbt-flows`, `/pbt-flow-status`, `/pbt-flow-stop`,
  `/pbt-flow-resume`, `/pbt-flow-inspect`, `/pbt-flow-cleanup`
- Tools: `pbt_flow_start`, `pbt_flow_resume`, `pbt_flow_status`,
  `pbt_flow_inspect`, `pbt_flow_stop`, `pbt_flow_cleanup`
- Hook: `session_start` — warns if the latest run was interrupted mid-flight
- Resume command/tool — reuses the original run directory, plan, handoffs, and persistent planner/builder/tester sessions. Pass `--reset-iteration` to the command or `resetIteration: true` to the tool after the max iteration cap is reached; this starts a fresh iteration budget cycle while preserving prior handoffs and history.
- Typebox parameter schemas for the tools
- `/flow <workflow-id> <request>` resolves a catalog definition and dispatches to its runner.
- `startFromCommand()` preserves the legacy `/pbt-flow` aliases and calls `runWorkflow`.

### `orchestrator.ts` — the control loop

`runWorkflow(pi, ctx, request, interactive, maxIterations, externalSignal?, resumeState?, resetIteration?, workflowId?, useDesignReview?)` — for PBT, `interactive` enables planner questions; for DPBT, it enables design-phase questions while planning remains simple.
owns the lifecycle and composes all other modules. When `resumeState` is
provided, it continues the existing run instead of creating a new one:

1. Create run ID + run dir under `acache/workflow-runs/<run-id>/`.
2. DPBT only: the Designer creates an isolated static preview under `<run-dir>/design-preview/`. Its built-in localhost review panel supports click-to-annotate comments, general comments, **Request changes**, and explicit **Approve design**. The orchestrator waits at this approval gate, gives newly saved feedback to the persistent Designer for revisions, and writes approved design decisions to `<run-dir>/design-decisions.md`.
3. Reserve the feature-named plan path (`plan-paths.ts`).
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
9. On any exit path: finalize state, render the report (`report.ts`), clean
   up empty plan reservations, release the run.

### `design-review.ts` — isolated DPBT preview and review runtime

- Generates the self-contained review overlay and starts a localhost-only static server for each preview.
- The overlay writes click-targeted feedback to `feedback.json`, revision requests to `review.json`, and explicit approvals to `approval.json`; these files are within the run-only preview directory, never the app source.
- The server is cleaned up by `/pbt-cleanup` along with `designer.jsonl`.

### `subagent.ts` — child pi session runner (reusable)

- `runSubagent(options)` uses the portable headless runner by default:
  `pi --mode json -p` with `--append-system-prompt <agent.md>`, `--tools`,
  `--model`, and either `--session <path>` (persistent) or `--no-session`
  (ephemeral). It streams JSONL stdout into `ProgressEvent`s, captures the
  last assistant message as output, accumulates token/cost usage, enforces
  `PHASE_TIMEOUT_MS` (SIGTERM → SIGKILL after 5 s), and honors an external
  `AbortSignal`.
- With a `tui` context, it opens/reuses a detached Herdr tab, starts pi in TUI
  mode, submits work with `herdr agent prompt --wait`, and tails the persistent
  pi session JSONL for live tool/assistant events and the final handoff. The
  tab remains available for inspection; its label receives ✓ or ✗ on settle.
- `getSubagentModel(ctx)` — resolves an authenticated model for children:
  `PBT_FLOW_MODEL` env override → durable new-session default → first available
  model. A model manually selected in the parent session is not inherited by
  child instances.
- `getPiInvocation(args)` — re-invokes the current pi binary when possible,
  falls back to `pi` on PATH.

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
- `reservePlanPath(cwd, request)` — creates a zero-byte `acache/plans/plan-<slug>.md`
  placeholder (`wx` flag) plus an in-memory reservation set, closing races
  both within this process and against other processes. Appends `-2`, `-3`,
  … on collision.
- `releasePlanReservation` — frees the in-memory slot; the orchestrator
  deletes the placeholder on disk if the planner never filled it.

### `cleanup.ts` — resource cleanup

- `/pbt-flow-cleanup [run-id]` closes the run's Herdr planner, builder, and
  tester tabs and removes `planner.jsonl`, `build.jsonl`, and `test.jsonl`.
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

- `updateUI(ctx, state, output?)` — redraws the `pbt-flow` widget (phase
  checklist, iteration counter, active agent line, and per-agent statuses) and
  status bar. No-op when `ctx.hasUI` is false.
- Each Herdr subagent session polls the persisted `state.json` while it is
  open. This keeps planner, builder, and tester widgets synchronized even
  though they run in separate pi extension instances.
- `askClarifications(ctx, questions, round)` — per-question select with the
  planner's options plus "Custom answer" and "Proceed without deciding";
  `CLARIFICATION_TIMEOUT_MS` applies, and unanswered questions are recorded
  as unresolved assumptions.

### `report.ts` — final report

`buildFinalReport(state)` renders the markdown report (status, handoffs,
file list, per-iteration test verification with commands/exit codes/issues).
`finishReport` prints it to stdout, updates the widget, notifies, and
delivers it into the session as a `pbt-flow-final-report` custom message.

### `constants.ts`, `types.ts`, `util.ts` — shared leaves

- `constants.ts` — `WORKFLOW_NAME`, `RUNS_DIR` (`acache/pbt-flow-runs`),
  `MAX_ITERATIONS` (5), `PHASE_TIMEOUT_MS` (10 min),
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
| `build.jsonl`    | pi            | Persistent builder session (reused across fix iterations)                                  |
| `test.jsonl`     | pi            | Persistent tester session (authoring + verification)                                       |

Plus the reserved `acache/plans/plan-<slug>.md`, written by the planner subagent.

## Configuration

- `PBT_FLOW_MODEL=provider/model` — forces the model used by all subagent
  processes (otherwise resolved from the durable new-session default, see
  `subagent.ts#getSubagentModel`).
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

Definitions are JSON files under `.pi/workflows/`. Each definition names a `runner`; the current runner is `one-for-all`, and additional runners can be added by extending `workflows.ts` and dispatching their orchestrators from the extension entry point. A run persists both `workflowName` and `workflowId`, so status and resume remain unambiguous when multiple workflows share the extension.

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
