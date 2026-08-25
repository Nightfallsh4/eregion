---
name: pbt
description: Run the local PBT plan-build-test subagent workflow with feature-named plans, parallel test authoring, persistent builder/tester sessions, and an automatic fix loop
---

# Local PBT workflow

This project provides a deterministic local workflow orchestrated by the
`one-for-all` extension. It isolates planning, implementation, and testing into
specialized pi subagent sessions and accumulates structured handoffs in
`acache/workflow-runs/<run-id>/state.json`. The checked-in presets in
`.pi/workflows/pbt-simple.json` and `.pi/workflows/pbt-interactive.json`
document the two variants used by the extension.

## Start a workflow

Use the extension command rather than implementing the workflow in the main
conversation:

- `/pbt <request>` — simple planner; infers repository-answerable details
  and never asks questions.
- `/pbt --interactive <request>` — interactive planner; explores first and
  sends focused clarification rounds to the main TUI before writing the plan.
- `/dpbt --interactive <request>` — interactive designer; sends focused
  product/design clarification rounds to the main TUI before creating or
  revising the mockup. DPBT planning remains non-interactive after approval.

The LLM can also call `pbt_start` with `request` and optional
`interactive: true` when the user explicitly asks to start a workflow.

## What happens

1. The orchestrator reserves a deterministic feature-named `plan-*.md` path.
2. The planner writes only that artifact and returns a structured handoff.
3. When started from a Herdr-managed pi pane, every subagent gets a detached,
   background Herdr **tab** running a visible pi TUI. The planner, builder, and
   tester each have their own tab; persistent planner/builder/tester turns
   reuse that agent's tab so clarification, fixes, and re-verification remain
   inspectable in one place.
4. Builder and tester authoring run in parallel. The tester owns tests and does
   not run them until the builder-complete barrier.
5. The persistent tester verifies the authored/relevant suites.
6. Each reported issue is sent individually to the same persistent builder (or
   tester for test-owned maintenance). The next issue is withheld until the
   current issue reports fixed; only then is a completed builder barrier sent
   to the tester for re-verification, up to the configured iteration cap.
   Persistent sessions retain prior context, so follow-up handoffs provide
   only new information rather than repeating the request, plan, and old issue
   list.
7. State and all handoffs are written to `state.json`, with a final report in
   the TUI/session and stdout-compatible command output.

## Inspect or control runs

- `/pbts` — list available local PBT workflow variants and recent/running runs.
- `/pbt-status [run-id]` — show state, handoffs, active agent, and recent activity. Status shows the current iteration budget cycle.
- `/pbt-stop [run-id]` — abort a running PBT workflow.
- `/pbt-resume [run-id] [--reset-iteration]` — resume the newest (or selected) interrupted, failed, or aborted run. Use `--reset-iteration` after the max iteration cap is reached to start another iteration budget cycle without losing the existing run history.
- `/pbt-cleanup [run-id]` — close the run's Herdr tabs and remove its persistent planner/builder/tester session files; defaults to the latest run.

The `pbt_inspect` tool provides the same live activity to the main agent. Use `/pbt-resume [run-id]` or `pbt_resume` to continue a persisted run. The resume tool accepts `resetIteration: true` for the same fresh-budget behavior as `--reset-iteration`. Completed handoffs are treated as barriers; only pending phases are retried. Authoring handoff protocol errors are recoverable: resume reuses the persistent tester session, asks it to inspect the authored files and emit a corrected handoff, then revalidates the barrier before verification. Persistent `planner.jsonl`, `build.jsonl`, and `test.jsonl` sessions are reused. In Herdr mode, the stable phase agent identity reuses an open tab, or creates a replacement tab against the same session file when the tab was closed.
Useful artifacts include `planner.jsonl`, `build.jsonl`, `test.jsonl`,
`activity.jsonl`, `state.json`, and the reserved plan path under
`acache/workflow-runs/<run-id>/`. In Herdr mode, switch to the automatically
created `pbt plan …`, `pbt build …`, and `pbt test …` tabs to watch the live pi
TUIs (completed tabs are prefixed with ✓ and failed ones with ✗). Persistent
sessions can also be inspected with `/resume <session-file>` after the run. Cleanup preserves `state.json`, activity logs, and plans, so the run remains inspectable; use it after the workflow has stopped or completed.
Use `tail -f` on `activity.jsonl` in a separate terminal for a structured live
view of tool calls, assistant output, stderr, and phase transitions.

## Extension layout

The extension at `.pi/extensions/one-for-all/` is modular; `index.ts` is only the
pi wiring (commands/tools/hooks). See `.pi/extensions/one-for-all/docs.md` for the
full module documentation, dependency graph, and reuse guide. Reusable pieces
for other workflows:

- `subagent.ts` — run child pi sessions headlessly or as Herdr TUI tabs
  (`runSubagent`), model resolution
- `herdr.ts` — Herdr CLI integration for detached tabs, pi TUI startup,
  prompt/wait control, interrupts, and tab status labels
- `handoffs.ts` — structured handoff JSON protocol: parse/validate/render
- `prompts.ts` — per-phase task prompt builders
- `plan-paths.ts` — feature-named `plan-*.md` reservation
- `state.ts` — run registry, `state.json` persistence, summaries
- `progress.ts` — `activity.jsonl` append/read/format
- `report.ts` — final markdown report rendering/delivery
- `ui.ts` — status widget and clarification prompts
- `orchestrator.ts` — the plan-build-test control loop
- `constants.ts`, `types.ts`, `util.ts` — shared config, contracts, helpers

To build a new workflow, import the generic modules (subagent, handoffs,
state, progress, prompts) and write your own orchestrator + index wiring.

## Guidance

Use the simple variant for clear requests and automation. Use the interactive
variant when scope, behavior, constraints, or acceptance criteria need user
input. Do not treat unresolved choices as confirmed requirements; they must be
recorded as assumptions and risks.

Herdr tab mode activates automatically only when pi was launched inside Herdr
(`HERDR_ENV=1`). Set `PBT_FLOW_HERDR=off` to force the original headless
subagent mode for a run.
