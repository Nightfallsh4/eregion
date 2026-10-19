# PBR and DPBR Review Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/pbr` and `/dpbr` workflows that make the Builder responsible for TDD and use a read-only Reviewer to validate acceptance criteria, quality gates, and the final commit.

**Architecture:** Keep PBT/DPBT's existing plan-build-test control loop intact and introduce a dedicated review-workflow mode/orchestrator with a single Builder plan and a persistent Builder/Reviewer repair loop. Extend the shared workflow contracts, subagent runner, and UI/reporting surfaces to model the Reviewer, its structured result, and its verified final commit. The Reviewer runs with Pi plan-only enabled; a reviewer-specific process flag permits only final Git staging and committing after a passing review.

**Tech Stack:** TypeScript ESM Pi extension, Node.js test runner via `tsx`, TypeBox, Git, existing `.pi/quality.json` quality runner.

**Spec:** `docs/superpowers/specs/2026-10-18-pbr-dpbr-review-workflows-design.md`

## Global Constraints

- Preserve the current PBT, DPBT, and just-build behaviour, APIs, and paired Builder/Tester plans.
- PBR/DPBR Planner output uses one Builder plan and must include a non-empty Markdown `## Acceptance Criteria` section.
- PBR/DPBR Builder must use `superpowers:test-driven-development`, create/update relevant tests, run verification, and never commit.
- Reviewer may not write, edit, delete, or format working-tree files; every issue returns to the persistent Builder.
- Reviewer uses plan-only mode and may stage/commit only after a successful review through a narrowly scoped exception that does not enable file changes.
- Reviewer must evaluate Git diff, acceptance criteria, test coverage, build, tests, lint, type checks, and code quality/structure.
- The orchestrator must rerun all required `.pi/quality.json` commands and verify the Reviewer commit before marking PBR/DPBR complete.
- Preserve the existing iteration cap, resume/stop/cleanup, Herdr visibility, guardrail relay, and optional `--docs` behaviour.

## Review Focus

- A planner emits an `Acceptance Criteria` heading with no meaningful content; reject it before Builder dispatch.
- A Builder changes production code without adding/updating a relevant test; Reviewer reports an actionable Builder-owned issue rather than repairing it.
- A Reviewer reports pass while any required quality command fails; reject the handoff and keep the run incomplete.
- The Reviewer attempts a file-writing command before approval or a Git commit before passing all checks; plan-only must block it.
- `HEAD` does not match the Reviewer-reported commit after review; orchestrator marks the run failed rather than claiming completion.

---

## File Structure

- `agents/reviewer.md` — new read-only Reviewer role, review rubric, structured review handoff, and final commit procedure.
- `agents/builder.md` — PBR/DPBR Builder-specific TDD/test ownership/no-commit requirements while retaining PBT rules.
- `agents/planner-simple.md`, `agents/planner-interactive.md` — single-plan PBR/DPBR planning instructions and mandatory acceptance criteria.
- `extensions/eregion/one-for-all/review-orchestrator.ts` — dedicated PBR/DPBR Plan → Builder → Reviewer lifecycle, repair loop, final quality/commit barriers, and DPBR design integration.
- `extensions/eregion/one-for-all/{types,handoffs,prompts,subagent,workflows,index,state,report,ui,cleanup,documentation}.ts` — shared Reviewer role/configuration, handoff validation, plan validation, command/tool wiring, status rendering, and resource lifecycle support.
- `extensions/eregion/global/plan-only.ts` — reviewer-process-only final Git stage/commit exemption; all file-writing restrictions remain active.
- `workflows/{pbr-simple,pbr-interactive,dpbr,dpbr-interactive}.json` — bundled preset definitions with Reviewer model/effort and phase policy.
- `extensions/eregion/one-for-all/docs.md`, `README.md`, `skills/pbt/SKILL.md` — document PBR/DPBR commands, lifecycle, quality/commit gates, and Reviewer semantics.
- `tests/{review-handoff,review-prompts,review-workflow,workflow-effort,subagent-tools,plan-only}.test.ts` plus adjusted existing plan/UI tests — lock down contracts and regressions.

### Task 1: Define the Reviewer workflow contract and bundled presets

**Files:**
- Modify: `extensions/eregion/one-for-all/types.ts`
- Modify: `extensions/eregion/one-for-all/subagent.ts`
- Modify: `extensions/eregion/one-for-all/workflows.ts`
- Modify: `extensions/eregion/one-for-all/cleanup.ts`
- Create: `workflows/pbr-simple.json`
- Create: `workflows/pbr-interactive.json`
- Create: `workflows/dpbr.json`
- Create: `workflows/dpbr-interactive.json`
- Modify: `tests/workflow-effort.test.ts`
- Modify: `tests/subagent-tools.test.ts`

**Interfaces:**
- Consumes: existing `WorkflowDefinition`, `WorkflowState`, `PhaseHandoff`, and `runSubagent` contracts.
- Produces: `runner: "pbr" | "dpbr"`, `SubagentRole: "reviewer"`, review-stage handoff/state fields, and subagent options capable of starting Pi in plan-only mode with the reviewer commit exception.

- [ ] **Step 1: Write failing catalog and role-resolution tests**

Add tests asserting that all four bundled review presets load, resolve `reviewer` model/effort settings, and that the Reviewer is included in role/tool/cleanup naming without changing existing roles.

- [ ] **Step 2: Run focused contract tests to verify they fail**

Run: `npx tsx --test tests/workflow-effort.test.ts tests/subagent-tools.test.ts`

Expected: FAIL because PBR/DPBR presets and reviewer role resolution do not exist.

- [ ] **Step 3: Extend shared workflow types and subagent configuration**

Add `reviewer` to the role/model/effort maps; add a review handoff stage/status and durable reviewer commit/quality state needed by reports and resume. Add explicit `planOnly` and `reviewerCommitException` subagent options so both headless Pi invocation and Herdr startup receive the required mode/flag/environment. Do not grant this exception to any non-Reviewer phase.

- [ ] **Step 4: Add PBR/DPBR catalog definitions and resource naming**

Create simple/interactive PBR and DPBR presets matching PBT/DPBT models, efforts, and iteration defaults but replacing the Tester phase with a Reviewer phase. Extend parser fallbacks, runner union/type checks, Herdr names/labels, and cleanup recognition to include PBR/DPBR Reviewer resources.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx tsx --test tests/workflow-effort.test.ts tests/subagent-tools.test.ts`

Expected: PASS.

### Task 2: Enforce PBR/DPBR planning acceptance criteria and Builder-owned TDD

**Files:**
- Modify: `extensions/eregion/one-for-all/plan-paths.ts`
- Modify: `extensions/eregion/one-for-all/state.ts`
- Modify: `extensions/eregion/one-for-all/handoffs.ts`
- Modify: `extensions/eregion/one-for-all/prompts.ts`
- Modify: `agents/planner-simple.md`
- Modify: `agents/planner-interactive.md`
- Modify: `agents/builder.md`
- Modify: `tests/plan-handoff.test.ts`
- Modify: `tests/plan-paths.test.ts`
- Create: `tests/review-prompts.test.ts`

**Interfaces:**
- Consumes: a PBR/DPBR `PlanPaths` variant containing one Builder plan and a planner handoff.
- Produces: `validateReviewPlanHandoff(handoff, path)` and `assertAcceptanceCriteria(cwd, planPath)`, plus PBR/DPBR Builder prompts that explicitly require TDD, test changes, local verification, and prohibit commits.

- [ ] **Step 1: Write failing plan validation and Builder prompt tests**

Test a populated single Builder plan that lacks `## Acceptance Criteria`, an empty criteria section, and a valid criteria list. Test that PBR Builder prompts name `superpowers:test-driven-development`, require test ownership/verification, and forbid commits; retain assertions that PBT prompts preserve Tester ownership.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx --test tests/plan-handoff.test.ts tests/plan-paths.test.ts tests/review-prompts.test.ts`

Expected: FAIL because no single-plan acceptance validator or PBR Builder prompt exists.

- [ ] **Step 3: Add single-plan reservation and acceptance-criteria validation**

Introduce a collision-safe single Builder-plan reservation for PBR/DPBR without changing `reservePlanPaths` for PBT/DPBT. Validate safe, non-empty plan files and parse Markdown headings so `## Acceptance Criteria` contains at least one non-whitespace criterion before a plan handoff becomes a barrier. Add a focused planner recovery prompt that names the missing/empty section.

- [ ] **Step 4: Add role-specific planning and Builder prompts**

Make PBR/DPBR planners write only the supplied Builder plan with explicit, verifiable acceptance criteria. Add PBR/DPBR initial and repair Builder prompts that require loading the TDD skill before changes, red/green/refactor evidence, relevant test changes, quality/test execution, and `git commit` prohibition. Ensure ordinary PBT/DPBT prompt paths are untouched.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx tsx --test tests/plan-handoff.test.ts tests/plan-paths.test.ts tests/review-prompts.test.ts`

Expected: PASS.

### Task 3: Implement the Reviewer agent, handoff protocol, and review repair loop

**Files:**
- Create: `agents/reviewer.md`
- Create: `extensions/eregion/one-for-all/review-orchestrator.ts`
- Modify: `extensions/eregion/one-for-all/handoffs.ts`
- Modify: `extensions/eregion/one-for-all/prompts.ts`
- Modify: `extensions/eregion/one-for-all/types.ts`
- Modify: `extensions/eregion/global/plan-only.ts`
- Create: `tests/review-handoff.test.ts`
- Create: `tests/review-workflow.test.ts`
- Create: `tests/plan-only.test.ts`

**Interfaces:**
- Consumes: single accepted Builder plan, persistent `build.jsonl`, optional approved DPBR design state, required `QualityConfig`, and baseline `HEAD`.
- Produces: `runReviewWorkflow(...)`, `buildReviewTask(...)`, `validateReviewHandoff(...)`, a `review` PhaseHandoff with quality evidence/issues/commit SHA, and a reviewer-only plan-only Git exception.

- [ ] **Step 1: Write failing Reviewer handoff and plan-only policy tests**

Cover rejection of review handoffs without a pass/fail status, Git-diff/acceptance evidence, complete required quality evidence, unique actionable issue IDs, or a commit SHA on pass. Assert plan-only blocks `write`, `edit`, and arbitrary destructive Bash for a reviewer process, permits `git diff`/quality commands, and permits exact `git add` plus `git commit` only when the reviewer exception is present.

- [ ] **Step 2: Run focused contract tests to verify they fail**

Run: `npx tsx --test tests/review-handoff.test.ts tests/plan-only.test.ts`

Expected: FAIL because Reviewer handoffs and the restricted exception do not exist.

- [ ] **Step 3: Implement Reviewer policy and prompts**

Create `agents/reviewer.md` with no file-writing tools and instructions to inspect the Builder plan, `git diff`, changed tests, acceptance criteria, and all configured quality checks. Require it to return Builder-owned issues without modifying files. On a passing review, allow only staging/review commit after all checks pass, then require the exact new SHA in the handoff. Add phase-specific initial/re-review prompts that carry only the plan, Builder barrier, prior issues, and approved design context where present.

- [ ] **Step 4: Implement the dedicated PBR/DPBR orchestration loop**

Create `runReviewWorkflow` without altering PBT/DPBT's test loop. Reserve/validate the single plan, preserve PBR interactive plan clarification and DPBR's existing design approval flow, run the Builder, then dispatch the plan-only Reviewer. Store a baseline Git SHA, serialize Reviewer issues through the same persistent Builder one at a time, and re-review until pass, plateau, or iteration limit. Require the Builder handoff to declare test artifacts/evidence for PBR/DPBR; do not permit it to commit.

- [ ] **Step 5: Implement final commit and independent quality barriers**

After a passing Reviewer handoff, verify the reported commit SHA is current `HEAD` and differs from the pre-review baseline. Programmatically rerun every required quality command, persist all command diagnostics as a final-review stage, and fail the run if any command or commit verification fails. Run the optional Docs phase only after these gates pass.

- [ ] **Step 6: Run focused workflow tests to verify they pass**

Run: `npx tsx --test tests/review-handoff.test.ts tests/review-workflow.test.ts tests/plan-only.test.ts`

Expected: PASS.

### Task 4: Wire public commands, persistence, UI, reports, and documentation

**Files:**
- Modify: `extensions/eregion/one-for-all/index.ts`
- Modify: `extensions/eregion/one-for-all/state.ts`
- Modify: `extensions/eregion/one-for-all/ui.ts`
- Modify: `extensions/eregion/one-for-all/report.ts`
- Modify: `extensions/eregion/one-for-all/documentation.ts`
- Modify: `extensions/eregion/one-for-all/docs.md`
- Modify: `README.md`
- Modify: `skills/pbt/SKILL.md`
- Modify: `tests/workflow-ui.test.ts`

**Interfaces:**
- Consumes: `runner: "pbr" | "dpbr"` workflow definitions and review workflow state.
- Produces: `/pbr`, `/dpbr`, matching resume/stop/status/inspect/cleanup commands/tools, and user-visible review/commit/quality state.

- [ ] **Step 1: Write failing command/catalog/UI tests**

Assert catalog listing and command registration metadata mention PBR/DPBR, review runs select their own state rather than PBT/DPBT runs, UI renders Plan → Build → Review and commit state, and reports show the acceptance-plan path, Reviewer result, final commit, and final quality runs.

- [ ] **Step 2: Run focused wiring tests to verify they fail**

Run: `npx tsx --test tests/workflow-ui.test.ts tests/review-workflow.test.ts`

Expected: FAIL because PBR/DPBR public wiring and Review status are absent.

- [ ] **Step 3: Add workflow dispatch and lifecycle controls**

Dispatch PBR/DPBR definitions to `runReviewWorkflow`; add slash commands and matching tool APIs for start, resume, stop, status, inspect, and cleanup. Ensure generic `/flow` and the start tool resolve them. Scope state lookup so PBR and DPBR controls do not select PBT/DPBT runs, and preserve existing legacy command behaviour.

- [ ] **Step 4: Surface review evidence and document the workflow**

Render Reviewer handoffs, review issues, reviewer commit SHA, and final orchestrator quality results in state summaries, live UI, and final reports. Update extension docs, package README, and workflow skill with the PBR/DPBR lifecycle, Acceptance Criteria gate, Builder TDD responsibility, Reviewer read-only restriction, commit exception, and controls.

- [ ] **Step 5: Run focused wiring tests to verify they pass**

Run: `npx tsx --test tests/workflow-ui.test.ts tests/review-workflow.test.ts`

Expected: PASS.

### Task 5: Run regression suite and smoke-test the packaged extension

**Files:**
- Modify only as required by failures in prior tasks.

**Interfaces:**
- Consumes: all completed PBR/DPBR implementation and existing workflow tests.
- Produces: a verified package with all PBT/DPBT/`/b` regressions passing.

- [ ] **Step 1: Run the full automated suite**

Run: `npx tsx --test tests/*.test.ts`

Expected: PASS with zero failures, including existing PBT/DPBT and new PBR/DPBR coverage.

- [ ] **Step 2: Run a TypeScript/package smoke check**

Run: `PI_CODING_AGENT_DIR="$(mktemp -d)" PI_OFFLINE=1 pi -e . --list-models`

Expected: exit 0 and no extension-loading error.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: no whitespace errors; changes limited to the planned workflow, agent, test, preset, and documentation surfaces.

## Acceptance Criteria

1. `/pbr` and `/dpbr`, with interactive variants, are available through direct commands, `/flow`, and the workflow start tool while PBT/DPBT/`/b` retain current behaviour.
2. PBR/DPBR planning accepts only one safe non-empty Builder plan containing a non-empty `## Acceptance Criteria` section and automatically returns malformed plans to the Planner.
3. PBR/DPBR Builder prompts require Superpowers TDD, relevant test changes and verification, and prohibit commits; PBT/DPBT Builder prompts retain their current Tester ownership restrictions.
4. Reviewer prompts and tools are plan-only/read-only except for final successful-review `git add`/`git commit`; Reviewer defects always route to Builder repair.
5. Reviewer validates Git diff, acceptance criteria, changed tests, build, tests, lint, type checks, and code quality, reporting structured evidence and stable issues.
6. Review failures repeat Builder → Reviewer under existing iteration/plateau semantics; success requires a verified Reviewer commit and independently passing orchestrator-run required quality commands.
7. State, UI, reports, cleanup, Herdr labels, docs, and automated tests accurately represent review phases and the final commit/quality evidence.
